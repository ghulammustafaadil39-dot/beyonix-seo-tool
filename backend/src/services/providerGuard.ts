import { ApiError } from '../errors.js';
import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';

// W-01: GLOBAL daily provider-spend circuit (extends the per-tenant budgets
// in metering.ts + the Redis circuit breaker in circuitBreaker.ts).
// provider_spend.cost_cents is currently recorded as 0 by callers that do not
// price units, so the guard tracks BOTH cost (when priced) and raw units —
// either tripping opens the circuit for the rest of the UTC day.

export interface GlobalSpend { costCents: number; units: number }

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
