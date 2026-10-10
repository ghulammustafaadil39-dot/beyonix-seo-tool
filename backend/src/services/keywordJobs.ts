import type { Job } from 'bullmq';
import { query as defaultQuery } from '../db.js';
import { refreshKeywordMetrics } from './keywordService.js';

/** Skip refresh when the site's cached metrics are fresher than this. */
const FRESH_WITHIN_DAYS = 25;

/**
 * keyword-refresh job processor. Idempotent: skips when the newest cached
 * metric for any of the site's keywords is less than 25 days old.
 */
export async function keywordRefreshProcessor(job: Job): Promise<unknown> {
  const { siteId, tenantId } = (job.data ?? {}) as { siteId: string; tenantId: string };
  const r = await defaultQuery(
    `SELECT MAX(fetched_at) AS last FROM keyword_metrics_cache
     WHERE keyword IN (SELECT keyword FROM keywords WHERE site_id = $1 AND tenant_id = $2)`,
    [siteId, tenantId],
  );
  const lastMs = r.rows[0]?.last ? new Date(r.rows[0].last).getTime() : 0;
  if (Date.now() - lastMs < FRESH_WITHIN_DAYS * 86_400_000) {
    return { skipped: true };
  }
  const count = await refreshKeywordMetrics(tenantId, siteId);
  return { refreshed: count };
}
