// Phase 3: Competitor auto-discovery (free SERP via DuckDuckGo HTML — no paid APIs).
//
// Flow:
//   1. Get the site's top keywords (tracked first, then approved suggestions,
//      then keywords by priority_score).
//   2. For each keyword (max 10), run a DuckDuckGo HTML search and collect
//      the domains ranking in the top 10.
//   3. Domains (other than the site itself) that appear for multiple keywords
//      are scored and upserted into `competitors` with discovery_source='auto'.

import { query as defaultQuery, type QueryFn } from '../db.js';
import { safeFetch } from './safeFetch.js';

export interface DiscoveredCompetitor {
  domain: string;
  sharedKeywords: number;
  avgPosition: number;
  overlapScore: number;
  keywords: string[];
}

export interface CompetitorGap {
  keyword: string;
  sitePosition: number | null;
  competitorPosition: number;
  volume: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function domainOf(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (!host || !host.includes('.')) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * DuckDuckGo HTML search → ordered list of { domain, position }.
 * Same free approach as outreach.ts prospect discovery.
 */
async function ddgSearchDomains(queryText: string): Promise<Array<{ domain: string; position: number }>> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(queryText)}`;
    const res = await safeFetch(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
      },
      12000,
      5,
      { allowedContentTypes: ['text/html'] },
    );
    if (!res.ok) return [];
    const html = await res.text();
    const out: Array<{ domain: string; position: number }> = [];
    const seen = new Set<string>();
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && out.length < 10) {
      let href = m[1];
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) {
        try {
          href = decodeURIComponent(uddg[1]);
        } catch {
          continue;
        }
      }
      if (!/^https?:\/\//i.test(href)) continue;
      const d = domainOf(href);
      if (!d || seen.has(d)) continue;
      seen.add(d);
      out.push({ domain: d, position: out.length + 1 });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Seed keywords for discovery: tracked keywords first, then approved
 * suggestions, then highest-priority keywords.
 */
async function seedKeywords(tenantId: string, siteId: string, limit: number, q: QueryFn): Promise<string[]> {
  const tracked = await q(
    `SELECT keyword FROM keywords WHERE site_id = $1 AND tenant_id = $2 AND tracked = TRUE ORDER BY priority_score DESC NULLS LAST LIMIT $3`,
    [siteId, tenantId, limit],
  );
  let seeds: string[] = (tracked.rows as Array<{ keyword: string }>).map((r) => r.keyword);
  if (seeds.length < limit) {
    const sug = await q(
      `SELECT keyword FROM keyword_suggestions WHERE site_id = $1 AND tenant_id = $2 AND status = 'approved' ORDER BY score DESC LIMIT $3`,
      [siteId, tenantId, limit - seeds.length],
    );
    seeds = seeds.concat((sug.rows as Array<{ keyword: string }>).map((r) => r.keyword));
  }
  if (seeds.length < limit) {
    const kw = await q(
      `SELECT keyword FROM keywords WHERE site_id = $1 AND tenant_id = $2 ORDER BY priority_score DESC NULLS LAST, volume DESC NULLS LAST LIMIT $3`,
      [siteId, tenantId, limit - seeds.length],
    );
    const existing = new Set(seeds.map((s) => s.toLowerCase()));
    for (const r of kw.rows as Array<{ keyword: string }>) {
      if (!existing.has(r.keyword.toLowerCase())) {
        seeds.push(r.keyword);
        existing.add(r.keyword.toLowerCase());
      }
      if (seeds.length >= limit) break;
    }
  }
  return seeds.slice(0, limit);
}

/**
 * Auto-discover competitors from free SERP overlap.
 * Upserts into competitors (discovery_source='auto', keeps 'manual' for
 * user-added rows) and returns the ranked list.
 */
export async function discoverCompetitors(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<{ competitors: DiscoveredCompetitor[]; keywordsChecked: number }> {
  const siteR = await q(`SELECT domain FROM sites WHERE id = $1 AND tenant_id = $2`, [siteId, tenantId]);
  if (siteR.rows.length === 0) throw new Error('Site not found');
  const siteDomain = (siteR.rows[0].domain as string).toLowerCase().replace(/^www\./, '');

  const seeds = await seedKeywords(tenantId, siteId, 10, q);
  if (seeds.length === 0) {
    return { competitors: [], keywordsChecked: 0 };
  }

  // domain -> { positions per keyword, keyword list }
  const agg = new Map<string, { positions: number[]; keywords: string[] }>();
  for (let i = 0; i < seeds.length; i++) {
    const results = await ddgSearchDomains(seeds[i]);
    for (const r of results) {
      if (r.domain === siteDomain) continue;
      // Skip aggregators/search engines that aren't real competitors.
      if (/^(google|bing|youtube|facebook|instagram|twitter|x|linkedin|pinterest|reddit|quora|wikipedia)\./.test(r.domain)) continue;
      let e = agg.get(r.domain);
      if (!e) {
        e = { positions: [], keywords: [] };
        agg.set(r.domain, e);
      }
      e.positions.push(r.position);
      e.keywords.push(seeds[i]);
    }
    if (i < seeds.length - 1) await sleep(700); // be polite to DDG
  }

  const competitors: DiscoveredCompetitor[] = [];
  for (const [domain, e] of agg) {
    const shared = e.positions.length;
    const avg = e.positions.reduce((a, b) => a + b, 0) / shared;
    // overlap_score 0-100: 60% keyword coverage, 40% position quality.
    const coverage = shared / seeds.length;
    const posQuality = Math.max(0, (11 - avg) / 10);
    const overlapScore = Math.round((coverage * 60 + posQuality * 40) * 100) / 100;
    competitors.push({
      domain,
      sharedKeywords: shared,
      avgPosition: Math.round(avg * 100) / 100,
      overlapScore,
      keywords: [...new Set(e.keywords)],
    });
  }
  competitors.sort((a, b) => b.overlapScore - a.overlapScore);
  const top = competitors.slice(0, 10);

  // Upsert: keep 'manual' source for user-added rows, update scores either way.
  for (const c of top) {
    await q(
      `INSERT INTO competitors (tenant_id, site_id, domain, discovery_source, overlap_score, shared_keywords, avg_position, last_discovered_at)
       VALUES ($1, $2, $3, 'auto', $4, $5, $6, now())
       ON CONFLICT (site_id, domain) DO UPDATE SET
         overlap_score = EXCLUDED.overlap_score,
         shared_keywords = EXCLUDED.shared_keywords,
         avg_position = EXCLUDED.avg_position,
         last_discovered_at = now(),
         discovery_source = CASE WHEN competitors.discovery_source = 'manual' THEN 'manual' ELSE 'auto' END`,
      [tenantId, siteId, c.domain, c.overlapScore, c.sharedKeywords, c.avgPosition],
    );
  }

  return { competitors: top, keywordsChecked: seeds.length };
}

/**
 * Gap analysis for one competitor: keywords where the competitor ranks in
 * the top 10 on free SERP but the site does not (or ranks worse).
 */
export async function competitorGaps(
  tenantId: string,
  siteId: string,
  competitorDomain: string,
  q: QueryFn = defaultQuery,
): Promise<{ gaps: CompetitorGap[]; keywordsChecked: number }> {
  const siteR = await q(`SELECT domain FROM sites WHERE id = $1 AND tenant_id = $2`, [siteId, tenantId]);
  if (siteR.rows.length === 0) throw new Error('Site not found');
  const siteDomain = (siteR.rows[0].domain as string).toLowerCase().replace(/^www\./, '');
  const comp = competitorDomain.toLowerCase().replace(/^www\./, '');

  const seeds = await seedKeywords(tenantId, siteId, 10, q);
  const volR = await q(`SELECT keyword, volume FROM keywords WHERE site_id = $1 AND tenant_id = $2`, [siteId, tenantId]);
  const volumes = new Map((volR.rows as Array<{ keyword: string; volume: number | null }>).map((r) => [r.keyword.toLowerCase(), r.volume]));

  const gaps: CompetitorGap[] = [];
  for (let i = 0; i < seeds.length; i++) {
    const results = await ddgSearchDomains(seeds[i]);
    const compHit = results.find((r) => r.domain === comp);
    if (!compHit || compHit.position > 10) continue;
    const siteHit = results.find((r) => r.domain === siteDomain);
    const sitePos = siteHit ? siteHit.position : null;
    // Gap: competitor in top 10 and site missing or clearly behind.
    if (sitePos === null || sitePos > compHit.position + 5) {
      gaps.push({
        keyword: seeds[i],
        sitePosition: sitePos,
        competitorPosition: compHit.position,
        volume: volumes.get(seeds[i].toLowerCase()) ?? null,
      });
    }
    if (i < seeds.length - 1) await sleep(700);
  }
  gaps.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  // Persist gaps so Phase 4 topic suggestions can use them (competitor_keywords table).
  for (const g of gaps) {
    try {
      await q(
        `INSERT INTO competitor_keywords (tenant_id, site_id, keyword, competitor_domain, competitor_position, site_position, volume)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (site_id, keyword, competitor_domain)
         DO UPDATE SET competitor_position = EXCLUDED.competitor_position,
                       site_position = EXCLUDED.site_position,
                       volume = EXCLUDED.volume,
                       discovered_at = now()`,
        [tenantId, siteId, g.keyword, comp, g.competitorPosition, g.sitePosition, g.volume],
      );
    } catch { /* table may not exist yet — non-fatal */ }
  }
  return { gaps, keywordsChecked: seeds.length };
}
