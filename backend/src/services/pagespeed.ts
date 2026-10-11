// Google PageSpeed Insights — real Core Web Vitals for the homepage.
// Free tier (no key required for our volume; PAGESPEED_API_KEY optional).
// C-04: results cached 7 days (pagespeed_cache) + daily quota
// (PAGESPEED_DAILY_QUOTA, default 25) so crawls never burn the free tier.
// Best-effort: never fails the audit when the API is unreachable or the
// quota is exhausted.

import { query as defaultQuery, type QueryFn } from '../db.js';

export interface PageSpeedMetrics {
  lcpMs: number | null; // Largest Contentful Paint
  cls: number | null; // Cumulative Layout Shift
  inpMs: number | null; // Interaction to Next Paint
  performanceScore: number | null; // 0-100 Lighthouse performance
}

const API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const CACHE_TTL_DAYS = 7;

export function pagespeedDailyQuota(): number {
  const n = parseInt(process.env.PAGESPEED_DAILY_QUOTA ?? '25', 10);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

/**
 * Pure quota helper: given today's count and the quota, is another call
 * allowed? (DB read/write lives in getPageSpeedMetrics.)
 */
export function quotaAllows(usedToday: number, quota: number): boolean {
  return usedToday < quota;
}

async function getQuotaCount(q: QueryFn, key: string): Promise<number> {
  const r = await q(
    `INSERT INTO daily_quotas (quota_key, day, count)
     VALUES ($1, CURRENT_DATE, 0)
     ON CONFLICT (quota_key, day) DO UPDATE SET count = daily_quotas.count
     RETURNING count`,
    [key],
  );
  return Number(r.rows[0]?.count ?? 0);
}

async function bumpQuota(q: QueryFn, key: string): Promise<void> {
  await q(
    `INSERT INTO daily_quotas (quota_key, day, count)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (quota_key, day) DO UPDATE SET count = daily_quotas.count + 1`,
    [key],
  );
}

async function fetchPageSpeed(pageUrl: string, apiKey?: string): Promise<PageSpeedMetrics | null> {
  try {
    const params = new URLSearchParams({ url: pageUrl, strategy: 'mobile', category: 'performance' });
    if (apiKey) params.set('key', apiKey);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    let res: Response;
    try {
      res = await fetch(`${API}?${params.toString()}`, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const data: any = await res.json();
    const audits = data?.lighthouseResult?.audits ?? {};
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    const score = data?.lighthouseResult?.categories?.performance?.score;
    return {
      lcpMs: num(audits['largest-contentful-paint']?.numericValue),
      cls: num(audits['cumulative-layout-shift']?.numericValue),
      inpMs: num(audits['interaction-to-next-paint']?.numericValue),
      performanceScore: typeof score === 'number' ? Math.round(score * 100) : null,
    };
  } catch {
    return null;
  }
}

/**
 * PageSpeed metrics with a 7-day DB cache and a daily quota.
 * Returns { metrics, cached, quotaExhausted } — never throws.
 */
export async function getPageSpeedMetrics(
  pageUrl: string,
  apiKey?: string,
  q: QueryFn = defaultQuery,
): Promise<{ metrics: PageSpeedMetrics | null; cached: boolean; quotaExhausted: boolean }> {
  try {
    const cached = await q(
      `SELECT metrics FROM pagespeed_cache
       WHERE url = $1 AND fetched_at > now() - ($2 || ' days')::interval`,
      [pageUrl, String(CACHE_TTL_DAYS)],
    );
    if (cached.rows.length > 0) {
      return { metrics: cached.rows[0].metrics as PageSpeedMetrics, cached: true, quotaExhausted: false };
    }
    const used = await getQuotaCount(q, 'pagespeed');
    const quota = pagespeedDailyQuota();
    if (!quotaAllows(used, quota)) {
      return { metrics: null, cached: false, quotaExhausted: true };
    }
    const metrics = await fetchPageSpeed(pageUrl, apiKey);
    await bumpQuota(q, 'pagespeed');
    if (metrics) {
      await q(
        `INSERT INTO pagespeed_cache (url, fetched_at, metrics)
         VALUES ($1, now(), $2)
         ON CONFLICT (url) DO UPDATE SET fetched_at = now(), metrics = EXCLUDED.metrics`,
        [pageUrl, JSON.stringify(metrics)],
      );
    }
    return { metrics, cached: false, quotaExhausted: false };
  } catch {
    return { metrics: null, cached: false, quotaExhausted: false };
  }
}
