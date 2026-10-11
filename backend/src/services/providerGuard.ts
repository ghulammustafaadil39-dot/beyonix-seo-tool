import { ApiError } from '../errors.js';
import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';

// W-01: GLOBAL daily provider-spend circuit (extends the per-tenant budgets
// in metering.ts + the Redis circuit breaker in circuitBreaker.ts).
// The guard tracks BOTH cost (priced — see priceProviderUnits below) and raw
// units — either tripping opens the circuit for the rest of the UTC day.
//
// C5-M-3 — per-call documentation of why a provider_spend row may still be
// recorded at cost 0:
// - mock providers never reach recordProviderSpend (call sites skip the call
//   when provider.isMock) — fake data never accrues fake cost;
// - cache hits never call recordProviderSpend — no provider call happened, so
//   no cost exists to record;
// - a caller may pass an explicit costCents > 0; explicit pricing always
//   wins over the default table below.

export interface GlobalSpend { costCents: number; units: number }

// ---------------------------------------------------------------------------
// C5-M-3: default per-unit pricing for provider spend.
// ---------------------------------------------------------------------------

/**
 * Default per-unit prices (US cents) for DataForSEO features, applied by
 * recordProviderSpend when the caller records costCents = 0. Every current
 * call site records unpriced units (keywordCache, serpSnapshots and
 * keywordService all pass 0), which made GLOBAL_PROVIDER_DAILY_CAP_CENTS a
 * dead knob — the dollar circuit could never trip. With these estimates the
 * cents cap is live.
 *
 * Values are CONSERVATIVE estimates from DataForSEO's public list pricing,
 * deliberately rounded UP per call (see priceProviderUnits) so small batches
 * still register spend: the circuit errs toward tripping early, never toward
 * missing spend. Calibrate per deployment with PROVIDER_PRICE_<FEATURE>_CENTS
 * env vars (e.g. PROVIDER_PRICE_SERP_CENTS=0.25); set a feature to 0 to
 * disable default pricing for it.
 */
const DEFAULT_UNIT_PRICE_CENTS: Record<string, number> = {
  keyword_metrics: 0.1, // ~$0.001 per keyword-metrics task
  serp: 0.2, // ~$0.002 per SERP task
  serp_snapshot: 0.2, // ~$0.002 per SERP snapshot task
  keyword_gap: 0.2, // ~$0.002 per keyword-gap task
};

/**
 * Estimated cost (integer US cents) for `units` of a provider feature.
 * Returns 0 for unknown providers/features or non-positive unit counts.
 */
export function priceProviderUnits(provider: string, feature: string, units: number): number {
  if (provider !== 'dataforseo' || !Number.isFinite(units) || units <= 0) return 0;
  const envKey = `PROVIDER_PRICE_${feature.toUpperCase()}_CENTS`;
  const envRaw = process.env[envKey];
  const envVal = envRaw === undefined ? NaN : Number(envRaw);
  const perUnit =
    Number.isFinite(envVal) && envVal >= 0 ? envVal : (DEFAULT_UNIT_PRICE_CENTS[feature] ?? 0);
  if (perUnit <= 0) return 0;
  // provider_spend.cost_cents is an integer column; ceil (not round) so
  // sub-cent unit prices still register spend on small batches.
  return Math.ceil(units * perUnit);
}

export async function getGlobalDailySpend(q: QueryFn = defaultQuery): Promise<GlobalSpend> {
  const r = await q(
    `SELECT COALESCE(SUM(cost_cents),0)::int AS cost, COALESCE(SUM(units),0)::int AS units
     FROM provider_spend WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
  );
  return { costCents: Number(r.rows[0]?.cost ?? 0), units: Number(r.rows[0]?.units ?? 0) };
}

export function globalCapsFromEnv(env: NodeJS.ProcessEnv = process.env): { capCents: number; capUnits: number } {
  return {
    capCents: Number(env.GLOBAL_PROVIDER_DAILY_CAP_CENTS ?? 0) || 0, // 0 = disabled
    capUnits: Number(env.GLOBAL_PROVIDER_DAILY_CAP_UNITS ?? 0) || 0,
  };
}

export async function assertGlobalProviderBudget(q: QueryFn = defaultQuery): Promise<void> {
  const { capCents, capUnits } = globalCapsFromEnv();
  if (capCents <= 0 && capUnits <= 0) return;
  const spend = await getGlobalDailySpend(q);
  if ((capCents > 0 && spend.costCents >= capCents) || (capUnits > 0 && spend.units >= capUnits)) {
    throw new ApiError(503, 'PROVIDER_BUDGET_EXCEEDED',
      'Global daily provider budget reached — paid data calls are paused until tomorrow (UTC). Cached data remains available.',
      { ...spend, capCents, capUnits });
  }
}

/**
 * D5-L-3: atomic check-AND-reserve for the global daily provider circuit.
 * assertGlobalProviderBudget was check-then-act: N concurrent tenants could
 * all pass the check and then all spend, overshooting the cap N×. This
 * does the check and the provisional spend insert in ONE statement, with
 * SELECT … FOR UPDATE on the day's guard row serializing concurrent
 * attempts (READ COMMITTED re-evaluates the totals after the lock, so each
 * attempt sees the reservations that committed before it).
 *
 * Returns the reservation row id. The caller MUST settle it: on provider
 * success call commitGlobalProviderSpend(id, actualUnits, actualCostCents);
 * on provider failure call releaseGlobalProviderSpend(id) so the hold
 * doesn't inflate the daily total.
 *
 * Throws 503 PROVIDER_BUDGET_EXCEEDED when the reservation would breach a
 * configured cap. When both caps are 0 (disabled) it still inserts the row
 * (spend evidence) and returns its id.
 */
export async function reserveGlobalProviderBudget(
  tenantId: string,
  provider: string,
  feature: string,
  units: number,
  q: QueryFn = defaultQuery,
): Promise<{ reservationId: string }> {
  const { capCents, capUnits } = globalCapsFromEnv();
  const u = Math.max(0, Math.round(units));
  const cents = priceProviderUnits(provider, feature, u);
  // Ensure today's guard row exists (idempotent). Kept as a separate
  // statement: combining the INSERT with FOR UPDATE on the same row in one
  // statement makes the lock a no-op in Postgres (the CTE form returns 0
  // rows), silently disabling the serialization.
  await q(
    `INSERT INTO global_provider_guard (day) VALUES ((now() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING`,
  );
  const r = await q(
    `WITH today AS (
       SELECT COALESCE(SUM(cost_cents), 0)::int AS cost,
              COALESCE(SUM(units), 0)::int AS units
       FROM provider_spend
       WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
     )
     INSERT INTO provider_spend (id, tenant_id, provider, feature, units, cost_cents)
     SELECT gen_random_uuid(), $1, $2, $3, $4, $5
     FROM today
     WHERE NOT (($6 > 0 AND today.cost + $5 >= $6)
             OR ($7 > 0 AND today.units + $4 >= $7))
       -- Serialize concurrent reserves: the FOR UPDATE waits for any
       -- in-flight reserve to commit, and READ COMMITTED then re-evaluates
       -- the daily totals against the committed rows.
       AND EXISTS (
         SELECT 1 FROM global_provider_guard
         WHERE day = (now() AT TIME ZONE 'UTC')::date
         FOR UPDATE
       )
     RETURNING id`,
    [tenantId, provider, feature, u, cents, capCents, capUnits],
  );
  if ((r.rowCount ?? 0) === 0) {
    const spend = await getGlobalDailySpend(q);
    throw new ApiError(503, 'PROVIDER_BUDGET_EXCEEDED',
      'Global daily provider budget reached — paid data calls are paused until tomorrow (UTC). Cached data remains available.',
      { ...spend, capCents, capUnits });
  }
  return { reservationId: r.rows[0].id as string };
}

/**
 * D5-L-3: settles a global reservation after the provider call with the
 * actual units/cost (usually identical to the estimate — the reservation
 * itself is the spend evidence).
 */
export async function commitGlobalProviderSpend(
  reservationId: string,
  units: number,
  costCents: number,
  q: QueryFn = defaultQuery,
): Promise<void> {
  const u = Math.max(0, Math.round(units));
  const cents = Math.max(0, Math.round(costCents));
  await q(
    `UPDATE provider_spend SET units = $2, cost_cents = $3 WHERE id = $1`,
    [reservationId, u, cents],
  );
}

/**
 * D5-L-3: releases a global reservation when the provider call failed, so
 * the provisional hold doesn't inflate the daily total.
 */
export async function releaseGlobalProviderSpend(
  reservationId: string,
  q: QueryFn = defaultQuery,
): Promise<void> {
  await q(`DELETE FROM provider_spend WHERE id = $1`, [reservationId]);
}
