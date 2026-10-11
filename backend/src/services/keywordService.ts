import { ApiError } from '../errors.js';
import { decrypt } from '../crypto.js';
import { query as defaultQuery, type QueryFn } from '../db.js';
import { DEFAULT_LOCATION_CODE, getKeywordMetrics } from './keywordCache.js';
import { getKeywordSerpProvider } from '../providers/dataforseo.js';
import { expandSeed, parseKeywordBulkImport } from './keywordText.js';
import { recordProviderSpend, withUsageReservation } from '../metering.js';
import { assertGlobalProviderBudget } from './providerGuard.js';
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

/**
 * F-03: seed expansion — deterministic variants of each seed, enriched with
 * cached+metered metrics, upserted as added_from='expansion'.
 */
export async function expandKeywords(
  tenantId: string,
  siteId: string,
  seeds: string[],
  q: QueryFn = defaultQuery,
): Promise<any[]> {
  const clean = (seeds ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (clean.length === 0 || clean.length > 5) {
    throw new ApiError(400, 'BAD_REQUEST', 'Provide between 1 and 5 non-empty seeds.');
  }
  await requireSite(tenantId, siteId, q);
  const locationCode = await siteLocation(siteId, tenantId, q);
  const candidates = new Set<string>();
  for (const seed of clean) {
    for (const k of expandSeed(seed, 20)) candidates.add(k);
  }
  const list = [...candidates].slice(0, 100);
  if (list.length === 0) return [];
  const metrics = await getKeywordMetrics(tenantId, list, q, undefined, locationCode);
  const groupMap = groupKeywords(metrics.map((m) => m.keyword.toLowerCase().trim()).filter(Boolean));
  const rows: any[] = [];
  for (const m of metrics) {
    const keyword = m.keyword.toLowerCase().trim();
    if (!keyword) continue;
    const r = await q(
      `INSERT INTO keywords (id, tenant_id, site_id, keyword, volume, difficulty, intent, priority_score, added_from, group_key)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'expansion', $8)
       ON CONFLICT (site_id, keyword) DO NOTHING
       RETURNING *`,
      [tenantId, siteId, keyword, m.volume, m.difficulty, classifyIntent(keyword), priorityScore(m.volume, m.difficulty), groupMap.get(keyword) ?? 'misc'],
    );
    if (r.rows[0]) rows.push(r.rows[0]);
  }
  rows.sort((a, b) => (b.priority_score ?? 0) - (a.priority_score ?? 0));
  return rows;
}

export interface KeywordCluster {
  group_key: string;
  keywords: string[];
  intents: Record<string, number>;
  total_volume: number;
  avg_difficulty: number | null;
}

/** F-03: cluster a site's keywords by topic (group_key) + intent mix. Pure over rows. */
export function clusterRows(
  rows: Array<{ keyword: string; group_key: string | null; intent: string | null; volume: number | null; difficulty: number | null }>,
): KeywordCluster[] {
  const map = new Map<string, KeywordCluster>();
  for (const r of rows) {
    const key = r.group_key || 'misc';
    let c = map.get(key);
    if (!c) {
      c = { group_key: key, keywords: [], intents: {}, total_volume: 0, avg_difficulty: null };
      map.set(key, c);
    }
    c.keywords.push(r.keyword);
    const intent = r.intent || 'informational';
    c.intents[intent] = (c.intents[intent] ?? 0) + 1;
    c.total_volume += r.volume ?? 0;
  }
  const out = [...map.values()];
  const diffByKey = new Map<string, { sum: number; n: number }>();
  for (const r of rows) {
    if (r.difficulty == null) continue;
    const key = r.group_key || 'misc';
    const d = diffByKey.get(key) ?? { sum: 0, n: 0 };
    d.sum += r.difficulty; d.n += 1;
    diffByKey.set(key, d);
  }
  for (const c of out) {
    const d = diffByKey.get(c.group_key);
    c.avg_difficulty = d && d.n > 0 ? Math.round(d.sum / d.n) : null;
    c.keywords.sort();
  }
  out.sort((a, b) => b.total_volume - a.total_volume);
  return out;
}

export interface CannibalizationHit {
  kind: 'same-url-multiple-keywords' | 'multiple-urls-one-keyword';
  keyword: string;
  keyword_id: string;
  urls: string[];
  detail: string;
}

/**
 * F-03: cannibalization detection.
 * - same-url-multiple-keywords: two tracked keywords whose latest ranking URL is identical.
 * - multiple-urls-one-keyword: the site's domain appears with 2+ distinct URLs
 *   in the latest SERP snapshot of one keyword.
 */
export async function detectCannibalization(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<CannibalizationHit[]> {
  const site = await requireSite(tenantId, siteId, q);
  const hits: CannibalizationHit[] = [];

  // (a) same ranking URL for multiple keywords
  const rows = (
    await q(
      `SELECT k.id AS keyword_id, k.keyword, rc.url
       FROM keywords k
       JOIN LATERAL (
         SELECT url FROM rank_checks
         WHERE keyword_id = k.id AND tenant_id = $2 AND url IS NOT NULL
         ORDER BY checked_at DESC LIMIT 1
       ) rc ON TRUE
       WHERE k.site_id = $1 AND k.tenant_id = $2 AND k.tracked = TRUE`,
      [siteId, tenantId],
    )
  ).rows as Array<{ keyword_id: string; keyword: string; url: string }>;
  const byUrl = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byUrl.get(r.url) ?? [];
    list.push(r);
    byUrl.set(r.url, list);
  }
  for (const [url, list] of byUrl) {
    if (list.length >= 2) {
      hits.push({
        kind: 'same-url-multiple-keywords',
        keyword: list.map((l) => l.keyword).join(', '),
        keyword_id: list[0].keyword_id,
        urls: [url],
        detail: `${list.length} tracked keywords all rank to the same page — they compete with each other.`,
      });
    }
  }

  // (b) multiple own-domain URLs in one keyword's snapshot
  const snaps = (
    await q(
      `SELECT k.id AS keyword_id, k.keyword, s.items
       FROM keywords k
       JOIN LATERAL (
         SELECT snapshot_id FROM rank_checks
         WHERE keyword_id = k.id AND tenant_id = $2 AND snapshot_id IS NOT NULL
         ORDER BY checked_at DESC LIMIT 1
       ) rc ON TRUE
       JOIN serp_snapshots s ON s.id = rc.snapshot_id
       WHERE k.site_id = $1 AND k.tenant_id = $2 AND k.tracked = TRUE`,
      [siteId, tenantId],
    )
  ).rows as Array<{ keyword_id: string; keyword: string; items: Array<{ url: string; domain: string }> }>;
  const want = site.domain.toLowerCase().replace(/^www\./, '');
  for (const s of snaps) {
    const ownUrls = [...new Set(
      (s.items ?? [])
        .filter((i) => String(i.domain ?? '').toLowerCase().replace(/^www\./, '') === want)
        .map((i) => i.url),
    )];
    if (ownUrls.length >= 2) {
      hits.push({
        kind: 'multiple-urls-one-keyword',
        keyword: s.keyword,
        keyword_id: s.keyword_id,
        urls: ownUrls.slice(0, 5),
        detail: `${ownUrls.length} of your pages rank for "${s.keyword}" — Google can't pick a winner; consolidate.`,
      });
    }
  }
  return hits;
}

export interface KeywordGap {
  keyword: string;
  competitor_position: number;
  competitor_url: string;
  volume: number | null;
  difficulty: number | null;
}

/**
 * F-03/F-07: keyword gap vs a competitor — keywords they rank for (top 100)
 * that we don't track. Results cached 7 days in keyword_gaps.
 * `dataSource` is 'mock' when the provider is in mock mode (honest label).
 */
export async function keywordGap(
  tenantId: string,
  siteId: string,
  competitorDomain: string,
  q: QueryFn = defaultQuery,
): Promise<{ gaps: KeywordGap[]; dataSource: 'mock' | 'real'; fetchedAt: string }> {
  await requireSite(tenantId, siteId, q);
  const comp = competitorDomain.trim().toLowerCase().replace(/^www\./, '');
  if (!comp || comp.length > 253) throw new ApiError(400, 'BAD_REQUEST', 'Invalid competitor domain.');

  const cached = await q(
    `SELECT gaps, fetched_at, data_source FROM keyword_gaps
     WHERE site_id = $1 AND tenant_id = $2 AND competitor_domain = $3
       AND fetched_at > now() - interval '7 days'`,
    [siteId, tenantId, comp],
  );
  if (cached.rows.length > 0) {
    return {
      gaps: cached.rows[0].gaps as KeywordGap[],
      dataSource: cached.rows[0].data_source === 'real' ? 'real' : 'mock',
      fetchedAt: cached.rows[0].fetched_at,
    };
  }

  const provider = getKeywordSerpProvider();
  const dataSource = provider.isMock ? 'mock' : 'real';
  // A1-M1: atomic reserve → billable call → commit(actual). The old
  // assertDataBudget gate was check-then-act and never recorded the spend
  // against the tenant's keyword_metrics budget at all — this call spends
  // real DataForSEO money, so it now counts (1 unit).
  const compKws = provider.competitorKeywords
    ? await withUsageReservation(tenantId, 'keyword_metrics', 1, async () => {
        await assertGlobalProviderBudget(q); // W-01: global daily circuit
        const kws = await provider.competitorKeywords!(comp);
        if (!provider.isMock) {
          await recordProviderSpend(tenantId, 'dataforseo', 'keyword_gap', 1, 0);
        }
        return { value: kws, actualUnits: 1 };
      })
    : [];
  const ours = new Set(
    (
      await q(`SELECT keyword FROM keywords WHERE site_id = $1 AND tenant_id = $2`, [siteId, tenantId])
    ).rows.map((r: any) => String(r.keyword).toLowerCase()),
  );
  const missing = compKws.filter((c) => !ours.has(c.keyword.toLowerCase()));
  // Enrich with volume/difficulty (cached+metered) for the top 50.
  const top = missing.slice(0, 50);
  const metrics = top.length > 0 ? await getKeywordMetrics(tenantId, top.map((t) => t.keyword), q) : [];
  const byKw = new Map(metrics.map((m) => [m.keyword.toLowerCase(), m]));
  const gaps: KeywordGap[] = top.map((t) => ({
    keyword: t.keyword,
    competitor_position: t.position,
    competitor_url: t.url,
    volume: byKw.get(t.keyword.toLowerCase())?.volume ?? null,
    difficulty: byKw.get(t.keyword.toLowerCase())?.difficulty ?? null,
  }));
  gaps.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));

  await q(
    `INSERT INTO keyword_gaps (id, tenant_id, site_id, competitor_domain, fetched_at, gaps, data_source)
     VALUES (gen_random_uuid(), $1, $2, $3, now(), $4, $5)
     ON CONFLICT (site_id, competitor_domain) DO UPDATE SET fetched_at = now(), gaps = EXCLUDED.gaps, data_source = EXCLUDED.data_source`,
    [tenantId, siteId, comp, JSON.stringify(gaps), dataSource],
  );
  return { gaps, dataSource, fetchedAt: new Date().toISOString() };
}

/**
 * F-03: bulk keyword import from CSV/text. Parses, enriches with
 * cached+metered metrics, upserts (added_from='import').
 */
export async function importKeywords(
  tenantId: string,
  siteId: string,
  text: string,
  q: QueryFn = defaultQuery,
): Promise<{ imported: number; skipped: number }> {
  await requireSite(tenantId, siteId, q);
  const kws = parseKeywordBulkImport(text, 1000);
  if (kws.length === 0) throw new ApiError(400, 'BAD_REQUEST', 'No valid keywords found in the import.');
  const locationCode = await siteLocation(siteId, tenantId, q);
  const metrics = await getKeywordMetrics(tenantId, kws, q, undefined, locationCode);
  const groupMap = groupKeywords(metrics.map((m) => m.keyword.toLowerCase().trim()).filter(Boolean));
  // Dedupe defensively (metrics must not repeat a keyword, but the batch
  // VALUES list must never contain two rows for one (site_id, keyword)
  // anyway) and drop empties.
  const seen = new Set<string>();
  const rows: Array<{ keyword: string; volume: number | null; difficulty: number | null }> = [];
  for (const m of metrics) {
    const keyword = m.keyword.toLowerCase().trim();
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    rows.push({ keyword, volume: m.volume, difficulty: m.difficulty });
  }
  // B1-7: batch the upserts — one statement per 500 rows instead of one
  // round trip per keyword (the same N+1 class as the A1-L1 backlinks fix).
  let imported = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values: string[] = [];
    const params: unknown[] = [];
    batch.forEach((row, j) => {
      const o = j * 8;
      values.push(
        `(gen_random_uuid(), $${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, 'import', $${o + 8})`,
      );
      params.push(
        tenantId,
        siteId,
        row.keyword,
        row.volume,
        row.difficulty,
        classifyIntent(row.keyword),
        priorityScore(row.volume, row.difficulty),
        groupMap.get(row.keyword) ?? 'misc',
      );
    });
    const r = await q(
      `INSERT INTO keywords (id, tenant_id, site_id, keyword, volume, difficulty, intent, priority_score, added_from, group_key)
       VALUES ${values.join(', ')}
       ON CONFLICT (site_id, keyword) DO NOTHING
       RETURNING id`,
      params,
    );
    imported += r.rows.length;
  }
  // skipped = every parsed keyword that did not become a new row: no-data
  // drops from getKeywordMetrics, dupes, and already-tracked conflicts.
  return { imported, skipped: kws.length - imported };
}
