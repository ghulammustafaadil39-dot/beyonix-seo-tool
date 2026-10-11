import { getKeywordSerpProvider } from '../providers/dataforseo.js';
import { recordProviderSpend, withUsageReservation } from '../metering.js';
import { assertGlobalProviderBudget } from './providerGuard.js';
import type { KeywordMetric, SerpResult, KeywordSerpProvider } from '../providers/types.js';
import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';

// W-02: cache TTLs by data type (part of the provenance contract) +
// provider name recorded on every fresh row (see migration 040).
export const METRICS_TTL_DAYS = 30;
export const SERP_TTL_DAYS = 7;

export const DEFAULT_LOCATION_CODE = 2840; // United States

/** Cached keyword metrics. Only uncached keywords hit the provider AND are metered. */
export async function getKeywordMetrics(
  tenantId: string,
  keywords: string[],
  q: QueryFn = defaultQuery,
  providerOverride?: KeywordSerpProvider,
  locationCode: number = DEFAULT_LOCATION_CODE,
): Promise<KeywordMetric[]> {
  const uniq = [...new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))];
  if (uniq.length === 0) return [];
  const cached = await q(
    `SELECT keyword, volume, difficulty, source_provider, fetched_at FROM keyword_metrics_cache
     WHERE keyword = ANY($1) AND location_code = $2
       AND fetched_at > now() - ($3 || ' days')::interval`,
    [uniq, locationCode, String(METRICS_TTL_DAYS)],
  );
  const hit = new Map<string, KeywordMetric & { source?: string; fetchedAt?: string }>(
    cached.rows.map((r: any) => [r.keyword, { keyword: r.keyword, volume: r.volume, difficulty: r.difficulty, source: r.source_provider ?? 'unknown', fetchedAt: r.fetched_at }]),
  );
  const missing = uniq.filter((k) => !hit.has(k));
  if (missing.length > 0) {
    // A1-M1: atomic reserve → billable call → commit(actual). The old
    // assertDataBudget + recordUsage pair was check-then-act: concurrent
    // callers could overspend the real DataForSEO budget.
    await withUsageReservation(tenantId, 'keyword_metrics', missing.length, async () => {
      await assertGlobalProviderBudget(q); // W-01: global daily circuit
      const provider = providerOverride ?? getKeywordSerpProvider();
      const fresh = await provider.keywordMetrics(missing, locationCode);
      if (!provider.isMock) await recordProviderSpend(tenantId, 'dataforseo', 'keyword_metrics', missing.length, 0, q);
      for (const m of fresh) {
        hit.set(m.keyword.toLowerCase(), { keyword: m.keyword, volume: m.volume, difficulty: m.difficulty, source: provider.name });
        await q(
          `INSERT INTO keyword_metrics_cache (keyword, location_code, volume, difficulty, fetched_at, source_provider)
           VALUES ($1, $2, $3, $4, now(), $5)
           ON CONFLICT (keyword, location_code) DO UPDATE SET volume=EXCLUDED.volume, difficulty=EXCLUDED.difficulty, fetched_at=now(), source_provider=EXCLUDED.source_provider`,
          [m.keyword.toLowerCase(), locationCode, m.volume, m.difficulty, provider.name],
        );
      }
      return { value: undefined as void, actualUnits: missing.length };
    });
  }
  return uniq.map((k) => hit.get(k)!).filter(Boolean);
}

/** Cached SERP lookup. Metered only on cache miss. */
export async function getSerp(
  tenantId: string,
  keyword: string,
  domain: string,
  q: QueryFn = defaultQuery,
  providerOverride?: KeywordSerpProvider,
  locationCode: number = DEFAULT_LOCATION_CODE,
): Promise<SerpResult> {
  const key = `${keyword.trim().toLowerCase()}|${domain.trim().toLowerCase()}|${locationCode}`;
  const r = await q(
    `SELECT position, url, serp_features FROM serp_cache
     WHERE cache_key = $1 AND fetched_at > now() - ($2 || ' days')::interval`,
    [key, String(SERP_TTL_DAYS)],
  );
  if (r.rows.length > 0) {
    const row = r.rows[0];
    return { position: row.position, url: row.url, features: row.serp_features ?? [] };
  }
  // A1-M1: atomic reserve → billable call → commit(actual) (see above).
  const fresh = await withUsageReservation(tenantId, 'serp_checks', 1, async () => {
    await assertGlobalProviderBudget(q); // W-01: global daily circuit
    const serpProvider = providerOverride ?? getKeywordSerpProvider();
    const serp = await serpProvider.serp(keyword, domain, locationCode);
    if (!serpProvider.isMock) await recordProviderSpend(tenantId, 'dataforseo', 'serp', 1, 0, q);
    await q(
      `INSERT INTO serp_cache (cache_key, position, url, serp_features, fetched_at, source_provider)
       VALUES ($1, $2, $3, $4, now(), $5)
       ON CONFLICT (cache_key) DO UPDATE SET position=EXCLUDED.position, url=EXCLUDED.url,
         serp_features=EXCLUDED.serp_features, fetched_at=now(), source_provider=EXCLUDED.source_provider`,
      [key, serp.position, serp.url, JSON.stringify(serp.features), serpProvider.name],
    );
    return { value: serp, actualUnits: 1 };
  });
  return fresh;
}
