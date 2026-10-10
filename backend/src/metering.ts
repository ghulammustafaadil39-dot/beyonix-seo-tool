import { ApiError } from './errors.js';
import { getPlan, isPlanId, type PlanId } from './plans.js';
import type { QueryFn } from './db.js';
import { query as defaultQuery } from './db.js';

export type UsageEventType = 'ai_words' | 'serp_check' | 'keyword_metric' | 'geo_check' | 'crawl_page';

export async function recordUsage(
  tenantId: string,
  eventType: UsageEventType,
  units: number,
  siteId?: string,
  meta?: Record<string, unknown>,
  q: QueryFn = defaultQuery,
): Promise<void> {
  await q(
    `INSERT INTO usage_events (id, tenant_id, site_id, event_type, units, meta)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
    [tenantId, siteId ?? null, eventType, Math.max(1, Math.round(units)), meta ? JSON.stringify(meta) : null],
  );
}

export async function getUsage(
  tenantId: string,
  eventType: UsageEventType,
  q: QueryFn = defaultQuery,
): Promise<number> {
  const r = await q(
    `SELECT COALESCE(SUM(units),0)::int AS total FROM usage_events
     WHERE tenant_id = $1 AND event_type = $2
       AND created_at >= date_trunc('month', now())`,
    [tenantId, eventType],
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

export async function checkLimit(
  tenantId: string,
  planId: PlanId,
  kind: LimitKind,
  q: QueryFn = defaultQuery,
): Promise<LimitCheck> {
  const plan = getPlan(planId);
  let used = 0;
  let limit = 0;
  switch (kind) {
    case 'sites':
      limit = plan.max_sites;
      used = Number((await q('SELECT COUNT(*)::int c FROM sites WHERE tenant_id=$1', [tenantId])).rows[0].c);
      break;
    case 'keywords_tracked':
      limit = plan.max_keywords_tracked;
      used = Number(
        (await q('SELECT COUNT(*)::int c FROM keywords WHERE tenant_id=$1 AND tracked=TRUE', [tenantId])).rows[0].c,
      );
      break;
    case 'ai_words':
      limit = plan.ai_words_month;
      used = await getUsage(tenantId, 'ai_words', q);
      break;
    case 'geo_checks':
      limit = plan.geo_checks_month;
      used = await getUsage(tenantId, 'geo_check', q);
      break;
    case 'serp_checks':
      limit = plan.serp_checks_month;
      used = await getUsage(tenantId, 'serp_check', q);
      break;
    case 'keyword_metrics':
      limit = plan.keyword_metrics_month;
      used = await getUsage(tenantId, 'keyword_metric', q);
      break;
    case 'crawl_pages':
      limit = plan.crawl_pages_month;
      used = await getUsage(tenantId, 'crawl_page', q);
      break;
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
