import { ApiError } from '../errors.js';
import { decrypt } from '../crypto.js';
import { query as defaultQuery, type QueryFn } from '../db.js';
import { DEFAULT_LOCATION_CODE, getKeywordMetrics } from './keywordCache.js';
import { getGoogle } from '../providers/google.js';
import { requireSite, siteUrl } from './sites.js';

/** Site's DataForSEO location_code (defaults to 2840 = United States). */
async function siteLocation(siteId: string, tenantId: string, q: QueryFn): Promise<number> {
  const r = await q(`SELECT serp_location_code FROM sites WHERE id = $1 AND tenant_id = $2`, [siteId, tenantId]);
  const code = Number(r.rows[0]?.serp_location_code);
  return Number.isInteger(code) && code > 0 ? code : DEFAULT_LOCATION_CODE;
}

export type KeywordIntent = 'transactional' | 'commercial' | 'informational' | 'navigational';

/** Rule-based search intent classification. */
export function classifyIntent(keyword: string): KeywordIntent {
  if (/(buy|price|hire|service|company|agency|quote|cost|near me)/i.test(keyword)) return 'transactional';
  if (/(best|top|vs|review|compare)/i.test(keyword)) return 'commercial';
  if (/(login|sign in|download)/i.test(keyword)) return 'navigational';
  return 'informational';
}

/**
 * Priority score 1..100: log-scaled volume minus difficulty penalty.
 * volume/difficulty of null fall back to neutral defaults (100 / 50).
 */
export function priorityScore(volume: number | null, difficulty: number | null): number {
  const v = Math.log10((volume ?? 100) + 1) * 22;
  const d = (difficulty ?? 50) * 0.6;
  return Math.min(100, Math.max(1, Math.round(v - d + 40)));
}

const GROUP_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'in', 'on', 'of', 'to', 'with', 'by',
  'near', 'me', 'my', 'your', 'our', 'is', 'are', 'be', 'how', 'what', 'why',
  'best', 'top', 'buy', 'get', 'hire', // intent words handled separately
]);

/** Core topic tokens of a keyword: lowercase, de-pluralized, stopwords removed. */
export function topicTokens(keyword: string): string[] {
  const tokens = keyword
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => t.replace(/(ies)$/, 'y').replace(/(s|es)$/, ''))
    .filter((t) => t.length > 1 && !GROUP_STOPWORDS.has(t));
  return [...new Set(tokens)];
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  const inter = a.filter((t) => sb.has(t)).length;
  return inter / (a.length + b.length - inter);
}

/**
 * Assigns each keyword to a topic group. Two keywords share a group when
 * their core-token Jaccard similarity >= 0.5 (one topic = one content piece,
 * so the content engine never targets the same topic twice).
 * Returns keyword -> group_key (stable, human-readable: sorted core tokens).
 */
export function groupKeywords(keywords: string[]): Map<string, string> {
  const groups: Array<{ key: string; tokens: string[] }> = [];
  const out = new Map<string, string>();
  for (const kw of keywords) {
    const tokens = topicTokens(kw);
    let best: { key: string; tokens: string[] } | null = null;
    let bestScore = 0;
    for (const g of groups) {
      const s = jaccard(tokens, g.tokens);
      if (s > bestScore) {
        bestScore = s;
        best = g;
      }
    }
    if (best && bestScore >= 0.5) {
      out.set(kw, best.key);
    } else {
      const key = [...tokens].sort().join('-') || 'misc';
      // avoid key collision between unrelated single-token groups
      const uniqueKey = groups.some((g) => g.key === key) ? `${key}-${groups.length}` : key;
      groups.push({ key: uniqueKey, tokens });
      out.set(kw, uniqueKey);
    }
  }
  return out;
}

/**
 * Research keyword seeds: fetch (cached+metered) metrics, classify intent,
 * score priority, and upsert into keywords. Returns rows highest-score first.
 */
export async function researchKeywords(
  tenantId: string,
  siteId: string,
  seeds: string[],
  q: QueryFn = defaultQuery,
): Promise<any[]> {
  const clean = (seeds ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (clean.length === 0 || clean.length > 10) {
    throw new ApiError(400, 'BAD_REQUEST', 'Provide between 1 and 10 non-empty keyword seeds.');
  }
  await requireSite(tenantId, siteId, q);
  const locationCode = await siteLocation(siteId, tenantId, q);
  const metrics = await getKeywordMetrics(tenantId, clean, q, undefined, locationCode);
  const groupMap = groupKeywords(metrics.map((m) => m.keyword.toLowerCase().trim()).filter(Boolean));
  const rows: any[] = [];
  for (const m of metrics) {
    const keyword = m.keyword.toLowerCase().trim();
    if (!keyword) continue;
    const groupKey = groupMap.get(keyword) ?? 'misc';
    const r = await q(
      `INSERT INTO keywords (id, tenant_id, site_id, keyword, volume, difficulty, intent, priority_score, added_from, group_key)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'research', $8)
       ON CONFLICT (site_id, keyword) DO UPDATE SET
         volume = EXCLUDED.volume,
         difficulty = EXCLUDED.difficulty,
         intent = EXCLUDED.intent,
         priority_score = EXCLUDED.priority_score,
         added_from = 'research',
         group_key = COALESCE(keywords.group_key, EXCLUDED.group_key)
       RETURNING *`,
      [tenantId, siteId, keyword, m.volume, m.difficulty, classifyIntent(keyword), priorityScore(m.volume, m.difficulty), groupKey],
    );
    if (r.rows[0]) rows.push(r.rows[0]);
  }
  rows.sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));
  return rows;
}

/**
 * Seed keywords from the site's Google Search Console top queries.
 * Returns the number of keywords inserted/updated (0 when GSC not connected).
 */
export async function seedFromGsc(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<number> {
  const site = await requireSite(tenantId, siteId, q);
  if (!site.gsc_connected) return 0;
  if (!site.gsc_refresh_token_enc) return 0;
  const token = decrypt(site.gsc_refresh_token_enc);
  const queries = await getGoogle().searchQueries(token, siteUrl(site.domain));
  const top = [...queries]
    .filter((r) => String(r.query ?? '').trim())
    .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0))
    .slice(0, 100);
  const groupMap = groupKeywords(top.map((r) => String(r.query).toLowerCase().trim()).filter(Boolean));
  let count = 0;
  for (const row of top) {
    const keyword = String(row.query).toLowerCase().trim();
    const score = Math.min(100, Math.round(row.impressions / Math.max(row.position, 1)));
    const groupKey = groupMap.get(keyword) ?? 'misc';
    await q(
      `INSERT INTO keywords (id, tenant_id, site_id, keyword, volume, difficulty, intent, priority_score, added_from, group_key)
       VALUES (gen_random_uuid(), $1, $2, $3, NULL, NULL, $4, $5, 'gsc', $6)
       ON CONFLICT (site_id, keyword) DO UPDATE SET
         volume = EXCLUDED.volume,
         difficulty = EXCLUDED.difficulty,
         intent = EXCLUDED.intent,
         priority_score = EXCLUDED.priority_score,
         added_from = 'gsc',
         group_key = COALESCE(keywords.group_key, EXCLUDED.group_key)`,
      [tenantId, siteId, keyword, classifyIntent(keyword), score, groupKey],
    );
    count++;
  }
  return count;
}

/**
 * Refresh stored volume/difficulty for all of a site's keywords.
 * Busts the metrics cache first so fresh provider data is pulled.
 */
export async function refreshKeywordMetrics(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<number> {
  await requireSite(tenantId, siteId, q);
  const list = await q(
    `SELECT keyword FROM keywords WHERE site_id = $1 AND tenant_id = $2`,
    [siteId, tenantId],
  );
  const kws = (list.rows.map((r: any) => r.keyword).filter(Boolean) as string[]);
  if (kws.length === 0) return 0;
  const locationCode = await siteLocation(siteId, tenantId, q);
  await q(`DELETE FROM keyword_metrics_cache WHERE keyword = ANY($1) AND location_code = $2`, [kws, locationCode]);
  const metrics = await getKeywordMetrics(tenantId, kws, q, undefined, locationCode);
  let count = 0;
  for (const m of metrics) {
    await q(
      `UPDATE keywords
       SET volume = $1, difficulty = $2, priority_score = $3
       WHERE site_id = $4 AND tenant_id = $5 AND keyword = $6`,
      [m.volume, m.difficulty, priorityScore(m.volume, m.difficulty), siteId, tenantId, m.keyword.toLowerCase()],
    );
    count++;
  }
  return count;
}
