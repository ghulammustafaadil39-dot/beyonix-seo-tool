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
