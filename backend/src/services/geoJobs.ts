import type { Job } from 'bullmq';
import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';
import { requireSite } from './sites.js';
import { runGeoCheck } from './geoService.js';
import { checkLimit } from '../metering.js';
import type { PlanId } from '../plans.js';

export const GEO_PLATFORMS = ['chatgpt', 'perplexity', 'gemini'];

/** Pure helper: true if any row was checked within the last `days` days. */
export function alreadyChecked(rows: { checked_at: Date | string }[], days: number): boolean {
  const cutoff = Date.now() - days * 86_400_000;
  return rows.some((r) => new Date(r.checked_at).getTime() >= cutoff);
}

interface GeoJobData {
  siteId: string;
  tenantId: string;
}

/**
 * Weekly AI-visibility sweep: takes the site's top 5 tracked keywords
 * (falls back to top 5 by priority regardless of tracked flag), skips any
 * query already checked in the last 7 days, and checks all GEO_PLATFORMS.
 * Softly respects the tenant's geo_checks plan limit (scheduler-driven;
 * stops early when the budget is exhausted).
 */
export async function geoCheckProcessor(job: Job): Promise<unknown> {
  const { siteId, tenantId } = job.data as GeoJobData;
  const q: QueryFn = defaultQuery;
  await requireSite(tenantId, siteId, q); // tenant scoping check

  let rows = await q(
    `SELECT keyword FROM keywords
     WHERE site_id = $1 AND tenant_id = $2 AND tracked = TRUE
     ORDER BY priority_score DESC NULLS LAST LIMIT 5`,
    [siteId, tenantId],
  );
  if (rows.rows.length === 0) {
    rows = await q(
      `SELECT keyword FROM keywords
       WHERE site_id = $1 AND tenant_id = $2
       ORDER BY priority_score DESC NULLS LAST LIMIT 5`,
      [siteId, tenantId],
    );
  }
  const keywords: string[] = rows.rows.map((r: any) => r.keyword as string);
  if (keywords.length === 0) return { queriesChecked: 0, reason: 'no-keywords' };

  const t = await q(`SELECT plan_id FROM tenants WHERE id = $1`, [tenantId]);
  const planId = (t.rows[0]?.plan_id ?? 'starter') as PlanId;
  const limit = await checkLimit(tenantId, planId, 'geo_checks', q);
  let budget = limit.limit - limit.used;
  if (budget <= 0) return { queriesChecked: 0, reason: 'limit-exhausted' };

  let queriesChecked = 0;
  for (const keyword of keywords) {
    if (budget < GEO_PLATFORMS.length) break; // soft stop at plan limit
    const recent = await q(
      `SELECT checked_at FROM geo_checks
       WHERE site_id = $1 AND tenant_id = $2 AND query = $3
         AND checked_at > now() - interval '7 days' LIMIT 1`,
      [siteId, tenantId, keyword],
    );
    if (alreadyChecked(recent.rows, 7)) continue; // idempotent skip
    await runGeoCheck(tenantId, siteId, keyword, GEO_PLATFORMS, q);
    budget -= GEO_PLATFORMS.length;
    queriesChecked += 1;
  }
  return { queriesChecked };
}
