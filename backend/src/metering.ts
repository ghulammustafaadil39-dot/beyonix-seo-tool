import { ApiError } from './errors.js';
import { getPlan, isPlanId, type PlanId } from './plans.js';
import type { QueryFn } from './db.js';
import { pool, query as defaultQuery } from './db.js';
import { priceProviderUnits } from './services/providerGuard.js';

export type UsageEventType = 'ai_words' | 'serp_check' | 'keyword_metric' | 'geo_check' | 'crawl_page';

export async function recordUsage(
  tenantId: string,
  eventType: UsageEventType,
  units: number,
  siteId?: string,
  meta?: Record<string, unknown>,
  q: QueryFn = defaultQuery,
): Promise<void> {
  // N-A2-4: zero-cost calls must not consume budget (the old Math.max(1,…)
  // floor charged every cache hit / no-op against the plan limit).
  await q(
    `INSERT INTO usage_events (id, tenant_id, site_id, event_type, units, meta)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [tenantId, siteId ?? null, eventType, Math.max(0, Math.round(units)), meta ? JSON.stringify(meta) : null],
  );
}

export interface BillingWindow {
  /** Inclusive start of the current usage window. */
  start: Date;
  /** True when the window comes from the Stripe subscription period. */
  fromSubscription: boolean;
}

/**
 * The tenant's usage window (N-A2-3): the Stripe billing period for paying
 * tenants (current_period_start from customer.subscription.* events), the
 * calendar month (UTC) otherwise.
 */
export async function getBillingWindow(tenantId: string, q: QueryFn = defaultQuery): Promise<BillingWindow> {
  const r = await q(
    `SELECT current_period_start FROM subscriptions
     WHERE tenant_id = $1 AND status IN ('active', 'trialing', 'past_due')
     ORDER BY current_period_start DESC NULLS LAST LIMIT 1`,
    [tenantId],
  );
  const start = r.rows[0]?.current_period_start as string | Date | null | undefined;
  if (start) return { start: new Date(start), fromSubscription: true };
  const now = new Date();
  return { start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), fromSubscription: false };
}

/**
 * Total usage in the tenant's billing window (C-02): usage_events
 * (committed spend, written by commitUsage) plus unexpired 'reserved' holds
 * (a reservation is a hold — it must count, otherwise concurrent callers
 * overspend). Committed reservations are NOT counted separately: their
 * units were folded into usage_events at commit time.
 */
export async function getUsage(
  tenantId: string,
  eventType: UsageEventType,
  q: QueryFn = defaultQuery,
): Promise<number> {
  const { start } = await getBillingWindow(tenantId, q);
  const r = await q(
    `SELECT (
       (SELECT COALESCE(SUM(units), 0) FROM usage_events
        WHERE tenant_id = $1 AND event_type = $2 AND created_at >= $3)
       +
       (SELECT COALESCE(SUM(units), 0) FROM usage_reservations
        WHERE tenant_id = $1 AND event_type = $2 AND created_at >= $3
          AND status = 'reserved' AND expires_at > now())
     )::int AS total`,
    [tenantId, eventType, start.toISOString()],
  );
  return Number(r.rows[0]?.total ?? 0);
}

export type LimitKind =
  | 'sites'
  | 'keywords_tracked'
  | 'ai_words'
  | 'geo_checks'
  | 'serp_checks'
  | 'keyword_metrics'
  | 'crawl_pages';

export interface LimitCheck {
  ok: boolean;
  used: number;
  limit: number;
  kind: LimitKind;
}

const KIND_EVENT: Record<LimitKind, UsageEventType | null> = {
  sites: null,
  keywords_tracked: null,
  ai_words: 'ai_words',
  geo_checks: 'geo_check',
  serp_checks: 'serp_check',
  keyword_metrics: 'keyword_metric',
  crawl_pages: 'crawl_page',
};

export function limitForKind(planId: PlanId, kind: LimitKind): number {
  const plan = getPlan(planId);
  switch (kind) {
    case 'sites':
      return plan.max_sites;
    case 'keywords_tracked':
      return plan.max_keywords_tracked;
    case 'ai_words':
      return plan.ai_words_month;
    case 'geo_checks':
      return plan.geo_checks_month;
    case 'serp_checks':
      return plan.serp_checks_month;
    case 'keyword_metrics':
      return plan.keyword_metrics_month;
    case 'crawl_pages':
      return plan.crawl_pages_month;
  }
}

export async function checkLimit(
  tenantId: string,
  planId: PlanId,
  kind: LimitKind,
  q: QueryFn = defaultQuery,
): Promise<LimitCheck> {
  const limit = limitForKind(planId, kind);
  let used = 0;
  switch (kind) {
    case 'sites':
      // A1-M3/A2-M2: soft-deleted sites must not burn the plan slot —
      // every other count path (listings, downgrade logic) uses deleted_at IS NULL.
      // C5-L-5: count unexpired 'reserved' holds too, exactly like reserveUsage
      // does — otherwise this pre-flight disagrees with the atomic path by
      // the in-flight hold amount.
      used = Number(
        (
          await q(
            `SELECT (COUNT(*)::int + COALESCE(
               (SELECT SUM(units)::int FROM usage_reservations
                WHERE tenant_id = $1 AND event_type = 'sites'
                  AND status = 'reserved' AND expires_at > now()), 0)) AS c
             FROM sites WHERE tenant_id = $1 AND deleted_at IS NULL`,
            [tenantId],
          )
        ).rows[0].c,
      );
      break;
    case 'keywords_tracked':
      used = Number(
        // A1-M3: keywords on soft-deleted sites must not burn quota either.
        // C5-L-5: same reservation-hold accounting as 'sites' above.
        (
          await q(
            `SELECT (COUNT(*)::int + COALESCE(
               (SELECT SUM(units)::int FROM usage_reservations
                WHERE tenant_id = $1 AND event_type = 'keywords_tracked'
                  AND status = 'reserved' AND expires_at > now()), 0)) AS c
             FROM keywords k WHERE k.tenant_id = $1 AND k.tracked = TRUE
               AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = k.site_id AND s.deleted_at IS NOT NULL)`,
            [tenantId],
          )
        ).rows[0].c,
      );
      break;
    default: {
      const event = KIND_EVENT[kind];
      if (event) used = await getUsage(tenantId, event, q);
    }
  }
  return { ok: used < limit, used, limit, kind };
}

export function assertLimit(check: LimitCheck): void {
  if (!check.ok) {
    throw new ApiError(402, 'LIMIT_EXCEEDED',
      `Plan limit reached for ${check.kind}: ${check.used}/${check.limit} used this period. Upgrade to continue.`,
      { used: check.used, limit: check.limit, kind: check.kind, upgrade: true });
  }
}

/** Snapshot of all limits for GET /settings/usage */
export async function usageSummary(tenantId: string, planId: PlanId, q: QueryFn = defaultQuery) {
  const kinds: LimitKind[] = [
    'sites',
    'keywords_tracked',
    'ai_words',
    'geo_checks',
    'serp_checks',
    'keyword_metrics',
    'crawl_pages',
  ];
  const out: Record<string, LimitCheck> = {};
  for (const k of kinds) out[k] = await checkLimit(tenantId, planId, k, q);
  return out;
}

/** Tenant's plan id, safe defaulting to starter. */
export async function getTenantPlanId(tenantId: string, q: QueryFn = defaultQuery): Promise<PlanId> {
  const r = await q('SELECT plan_id FROM tenants WHERE id = $1', [tenantId]);
  const pid = r.rows[0]?.plan_id as string | undefined;
  return isPlanId(pid ?? '') ? (pid as PlanId) : 'starter';
}

const DATA_BUDGET_LABEL: Record<'serp_checks' | 'keyword_metrics', string> = {
  serp_checks: 'rank check',
  keyword_metrics: 'keyword data',
};

/**
 * Enforces monthly paid-data budgets at the choke point (throws 402).
 * Called by keywordCache before any billable provider call, so background
 * jobs and API routes share one enforcement point.
 */
export async function assertDataBudget(
  tenantId: string,
  kind: 'serp_checks' | 'keyword_metrics',
  units: number,
  q: QueryFn = defaultQuery,
): Promise<void> {
  const planId = await getTenantPlanId(tenantId, q);
  const check = await checkLimit(tenantId, planId, kind, q);
  if (check.used + units > check.limit) {
    throw new ApiError(
      402,
      'LIMIT_EXCEEDED',
      `Monthly ${DATA_BUDGET_LABEL[kind]} budget reached: ${check.used}/${check.limit} used. Upgrade to continue.`,
      { used: check.used, limit: check.limit, kind, upgrade: true },
    );
  }
}

// ---------------------------------------------------------------------------
// Reserve-then-commit (C-02 / N-A2-4)
// ---------------------------------------------------------------------------

export interface ReserveOpts {
  siteId?: string;
  meta?: Record<string, unknown>;
  /** Test/override hook: bypass the plan table for the limit value. */
  limitOverride?: number;
  /**
   * D1-M-4: reservation TTL in minutes. Defaults to 15 (the column default).
   * Long-running work (e.g. large crawls) should scale this with the reserved
   * units so the hold doesn't expire mid-work and get double-reserved.
   */
  ttlMinutes?: number;
}

export interface Reservation {
  reservationId: string;
  used: number;
  limit: number;
  kind: LimitKind;
}

function limitExceededError(used: number, limit: number, kind: LimitKind, units: number): ApiError {
  return new ApiError(
    402,
    'LIMIT_EXCEEDED',
    `Plan limit reached for ${kind}: ${used}/${limit} used this period (+${units} requested). Upgrade to continue.`,
    { used, limit, kind, upgrade: true },
  );
}

/**
 * Atomically reserves `units` against the tenant's limit (C-02). The whole
 * check-and-insert runs in ONE transaction under a per-tenant advisory
 * transaction lock, so N concurrent callers can never collectively exceed
 * the limit — this replaces the old check-then-act race. Throws 402 with
 * { upgrade, limit, used } when the reservation would exceed the limit.
 */
export async function reserveUsage(
  tenantId: string,
  planId: PlanId,
  kind: LimitKind,
  units: number,
  opts: ReserveOpts = {},
): Promise<Reservation> {
  // B2-L1: usage_reservations.units has CHECK (units > 0). Reserving zero
  // (or negative) units is a caller bug — fail with a clean 400 instead of
  // a raw PG check-violation 500.
  const take = Math.round(units);
  if (!Number.isFinite(take) || take < 1) {
    throw new ApiError(400, 'VALIDATION_ERROR', `units must be a positive integer (got ${units})`);
  }
  // D1-M-4: TTL for the reservation hold. Callers doing long-running work
  // pass ttlMinutes scaled to the job size; default 15 preserves the old
  // column-default behavior for everything else.
  const ttlMins = Math.max(1, Math.min(1440, Math.round(opts.ttlMinutes ?? 15)));
  const limit = opts.limitOverride ?? limitForKind(planId, kind);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      // Serialize all metering mutations for this tenant. xact-scoped: the
      // lock releases automatically on COMMIT/ROLLBACK (no leak on crash).
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`metering:${tenantId}`]);
      const { start } = await getBillingWindow(tenantId, client.query.bind(client) as QueryFn);
      const event = KIND_EVENT[kind];
      let used = 0;
      if (event) {
        used = await getUsage(tenantId, event, client.query.bind(client) as QueryFn);
      } else if (kind === 'sites') {
        // A1-M3/A2-M2: see checkLimit — soft-deleted sites don't count.
        // A1-M1: unexpired 'reserved' holds count too — the site row itself
        // is inserted AFTER the reservation commits, so without this two
        // concurrent creators would both pass the check.
        used = Number(
          (
            await client.query(
              `SELECT (COUNT(*)::int + COALESCE(
                 (SELECT SUM(units)::int FROM usage_reservations
                  WHERE tenant_id = $1 AND event_type = 'sites'
                    AND status = 'reserved' AND expires_at > now()), 0)) AS c
               FROM sites WHERE tenant_id = $1 AND deleted_at IS NULL`,
              [tenantId],
            )
          ).rows[0].c,
        );
      } else if (kind === 'keywords_tracked') {
        // A1-M3: keywords on soft-deleted sites don't count.
        // A1-M1: same reservation-hold accounting as 'sites' above.
        used = Number(
          (
            await client.query(
              `SELECT (COUNT(*)::int + COALESCE(
                 (SELECT SUM(units)::int FROM usage_reservations
                  WHERE tenant_id = $1 AND event_type = 'keywords_tracked'
                    AND status = 'reserved' AND expires_at > now()), 0)) AS c
               FROM keywords k WHERE k.tenant_id = $1 AND k.tracked = TRUE
                 AND NOT EXISTS (SELECT 1 FROM sites s WHERE s.id = k.site_id AND s.deleted_at IS NOT NULL)`,
              [tenantId],
            )
          ).rows[0].c,
        );
      }
      if (used + take > limit) {
        await client.query('ROLLBACK');
        throw limitExceededError(used, limit, kind, take);
      }
      const ins = await client.query(
        `INSERT INTO usage_reservations (id, tenant_id, event_type, units, status, site_id, meta, expires_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'reserved', $4, $5, now() + make_interval(mins => $6)) RETURNING id`,
        [tenantId, event ?? kind, take, opts.siteId ?? null, opts.meta ? JSON.stringify(opts.meta) : null, ttlMins],
      );
      await client.query('COMMIT');
      const reservationId = ins.rows[0].id as string;
      const newUsed = used + take;
      // Alert hooks fire after commit (best-effort, never blocks metering).
      void checkUsageAlerts(tenantId, kind, newUsed, limit, start).catch((e) =>
        console.error('[metering] alert hook failed', e),
      );
      return { reservationId, used: newUsed, limit, kind };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  } finally {
    client.release();
  }
}

/** Finalizes a reservation with the actual units consumed (clamped to the reserved amount). */
export async function commitUsage(
  reservationId: string,
  actualUnits?: number,
  q: QueryFn = defaultQuery,
): Promise<void> {
  const units = actualUnits === undefined ? undefined : Math.round(actualUnits);
  // B2-L1: usage_reservations.units has CHECK (units > 0). A caller reporting
  // 0 consumption (e.g. generateMetered with an empty LLM response) must
  // release the hold instead of tripping a raw PG check-violation 500.
  if (units !== undefined && units <= 0) {
    await cancelUsage(reservationId, q);
    return;
  }
  // B2-M3: the reservation flip AND the usage_events INSERT are one atomic
  // statement (CTE). Two separate statements had a window where the spend
  // was counted in NEITHER table (getUsage sums usage_events + reserved
  // holds), letting concurrent reserveUsage calls grant over the limit;
  // a crash between them lost the spend evidence while the reservation
  // was already committed. A single statement is atomic even when the
  // caller passes a non-transactional QueryFn.
  //
  // C1-M-4 / C5-M-4: the commit is clamped to the reserved amount —
  // LEAST(COALESCE($2, units), units) reads the CURRENT (reserved) row
  // value on the right-hand side, so a caller reporting actualUnits >
  // reserved can never overshoot the atomic guarantee of reserveUsage.
  //
  // C2-L5: an EXPIRED reservation can no longer be committed — the hold was
  // already freed from getUsage's accounting (expired holds don't count),
  // so committing it would re-add budget and let concurrent callers
  // collectively overshoot. The caller must re-reserve (or recordUsage
  // directly) instead.
  const r = await q(
    `WITH u AS (
       UPDATE usage_reservations
       SET status = 'committed', units = LEAST(COALESCE($2, units), units)
       WHERE id = $1 AND status = 'reserved' AND expires_at > now()
       RETURNING tenant_id, site_id, event_type, units, meta
     ),
     i AS (
       -- A1-M1: committing must also record the usage_events row (dashboards,
       -- billing evidence, getUsage all read it). 'sites'/'keywords_tracked'
       -- are pure counts (no usage_events row); every other kind's
       -- event_type IS the UsageEventType (see KIND_EVENT).
       INSERT INTO usage_events (id, tenant_id, site_id, event_type, units, meta)
       SELECT gen_random_uuid(), tenant_id, site_id, event_type, units, meta
       FROM u
       WHERE event_type NOT IN ('sites', 'keywords_tracked')
     )
     SELECT count(*)::int AS committed FROM u`,
    [reservationId, units ?? null],
  );
  if (Number(r.rows[0]?.committed ?? 0) === 0) {
    // Distinguish "expired" from "missing/already finalized" so callers and
    // operators get an honest error instead of a misleading 404.
    const st = await q(
      `SELECT expires_at <= now() AS expired FROM usage_reservations WHERE id = $1`,
      [reservationId],
    );
    if (st.rows.length > 0 && st.rows[0].expired === true) {
      throw new ApiError(
        410,
        'RESERVATION_EXPIRED',
        'Usage reservation expired before commit; the budget hold was already released.',
      );
    }
    throw new ApiError(404, 'NOT_FOUND', 'Reservation not found or already finalized');
  }
}

/** Releases a reservation without consuming budget. */
export async function cancelUsage(reservationId: string, q: QueryFn = defaultQuery): Promise<void> {
  await q(`UPDATE usage_reservations SET status = 'cancelled' WHERE id = $1 AND status = 'reserved'`, [reservationId]);
}

/**
 * A1-M1: atomic reserve → work → commit(actual)/cancel primitive for paid
 * choke points. The old checkLimit/assertDataBudget + recordUsage pairs
 * were check-then-act: N concurrent callers could collectively overspend
 * the plan limit (or real DataForSEO money) because every one of them saw
 * `used < limit` before anyone recorded usage. The reservation serializes
 * on a per-tenant advisory xact lock, so the limit is enforced atomically.
 *
 * Pass the caller’s best estimate as `units`; the reservation is committed
 * with the actual units consumed (<= estimate) once work succeeds, or
 * cancelled when work throws. Reservations expire after 15 minutes, so a
 * crashed worker can’t hold budget forever.
 */
export async function withUsageReservation<T>(
  tenantId: string,
  kind: LimitKind,
  units: number,
  work: () => Promise<{ value: T; actualUnits?: number }>,
  opts: ReserveOpts = {},
): Promise<T> {
  const estimate = Math.max(1, Math.round(units));
  const planId = await getTenantPlanId(tenantId);
  const reservation = await reserveUsage(tenantId, planId, kind, estimate, opts);
  try {
    const { value, actualUnits } = await work();
    await commitUsage(reservation.reservationId, actualUnits ?? estimate);
    return value;
  } catch (err) {
    await cancelUsage(reservation.reservationId).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 80% / 100% alert hooks (C-02)
// ---------------------------------------------------------------------------

export interface UsageAlertInfo {
  tenantId: string;
  kind: LimitKind;
  used: number;
  limit: number;
  level: 80 | 100;
  periodStart: Date;
}

export type UsageAlertHook = (info: UsageAlertInfo) => Promise<void> | void;

const usageAlertHooks = new Set<UsageAlertHook>();

/** Registers an alert hook; returns an unsubscribe function. */
export function registerUsageAlertHook(hook: UsageAlertHook): () => void {
  usageAlertHooks.add(hook);
  return () => {
    usageAlertHooks.delete(hook);
  };
}

async function checkUsageAlerts(
  tenantId: string,
  kind: LimitKind,
  used: number,
  limit: number,
  periodStart: Date,
): Promise<void> {
  if (usageAlertHooks.size === 0 || limit <= 0) return;
  const ratio = used / limit;
  const level: 80 | 100 | null = ratio >= 1 ? 100 : ratio >= 0.8 ? 80 : null;
  if (level === null) return;
  const col = level === 100 ? 'alert_100_at' : 'alert_80_at';
  // INSERT the period row if missing, then claim the alert column with a
  // NULL-guarded UPDATE — the first writer wins, so hooks fire once even
  // under concurrency.
  await defaultQuery(
    `INSERT INTO usage_alert_state (tenant_id, kind, period_start)
     VALUES ($1, $2, $3) ON CONFLICT (tenant_id, kind, period_start) DO NOTHING`,
    [tenantId, kind, periodStart.toISOString()],
  );
  const claimed = await defaultQuery(
    `UPDATE usage_alert_state SET ${col} = now()
     WHERE tenant_id = $1 AND kind = $2 AND period_start = $3 AND ${col} IS NULL`,
    [tenantId, kind, periodStart.toISOString()],
  );
  if ((claimed.rowCount ?? 0) === 0) return;
  const info: UsageAlertInfo = { tenantId, kind, used, limit, level, periodStart };
  for (const hook of usageAlertHooks) {
    try {
      await hook(info);
    } catch (e) {
      console.error('[metering] usage alert hook threw', e);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider spend tracking (C-02: per-tenant DataForSEO cost)
// ---------------------------------------------------------------------------

export async function recordProviderSpend(
  tenantId: string,
  provider: string,
  feature: string,
  units: number,
  costCents: number,
  q: QueryFn = defaultQuery,
): Promise<void> {
  const u = Math.max(0, Math.round(units));
  // C5-M-3: callers record unpriced units (costCents = 0). Apply the default
  // per-feature unit price so the GLOBAL_PROVIDER_DAILY_CAP_CENTS circuit
  // can actually trip. An explicit caller-supplied costCents > 0 always wins.
  let cents = Math.max(0, Math.round(costCents));
  if (cents === 0 && u > 0) cents = priceProviderUnits(provider, feature, u);
  await q(
    `INSERT INTO provider_spend (id, tenant_id, provider, feature, units, cost_cents)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [tenantId, provider, feature, u, cents],
  );
}

export interface SpendFilter {
  provider?: string;
  feature?: string;
  since?: Date;
}

export async function getProviderSpend(
  tenantId: string,
  filter: SpendFilter,
  q: QueryFn = defaultQuery,
): Promise<{ units: number; costCents: number }> {
  const conds = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (filter.provider) {
    params.push(filter.provider);
    conds.push(`provider = $${params.length}`);
  }
  if (filter.feature) {
    params.push(filter.feature);
    conds.push(`feature = $${params.length}`);
  }
  if (filter.since) {
    params.push(filter.since.toISOString());
    conds.push(`created_at >= $${params.length}`);
  }
  const r = await q(
    `SELECT COALESCE(SUM(units),0)::int AS units, COALESCE(SUM(cost_cents),0)::int AS cost_cents
     FROM provider_spend WHERE ${conds.join(' AND ')}`,
    params,
  );
  return { units: Number(r.rows[0]?.units ?? 0), costCents: Number(r.rows[0]?.cost_cents ?? 0) };
}
