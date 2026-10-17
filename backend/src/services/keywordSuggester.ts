/**
 * keywordSuggester.ts — Phase 1 rebuild.
 *
 * Auto-suggests NEW keywords for a site from FREE sources only:
 *  1. GSC search queries (free Google API) — queries with impressions but
 *     position > 10 are "opportunity" keywords (visible but not ranking well).
 *  2. Site content (already crawled) — TF frequency analysis on page titles
 *     to find business-relevant multi-word phrases.
 *
 * No paid APIs. Dedupe against already-tracked keywords. Returns top 20.
 */

import { query } from '../db.js';
import { getGoogle } from '../providers/google.js';
import { siteUrl } from './sites.js';

// Minimal English stopword list — keeps the frequency analysis meaningful.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'this', 'that', 'these', 'those',
  'it', 'its', 'as', 'we', 'you', 'your', 'our', 'their', 'they', 'them',
  'he', 'she', 'his', 'her', 'not', 'no', 'yes', 'if', 'then', 'than',
  'so', 'such', 'only', 'also', 'just', 'about', 'into', 'over', 'after',
  'home', 'page', 'welcome', 'click', 'here', 'more', 'read', 'view', 'all',
]);

export interface KeywordSuggestion {
  keyword: string;
  source: 'gsc' | 'content';
  score: number;
  reason: string;
  impressions?: number;
  position?: number;
}

/** Normalize: lowercase, strip punctuation, collapse whitespace. */
function clean(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract candidate phrases (2-4 words) from titles.
 * Scores by frequency × specificity (longer phrases score higher, capped).
 */
function extractPhrases(titles: string[], domain: string): Map<string, number> {
  const counts = new Map<string, number>();
  const domainParts = new Set(domain.toLowerCase().split(/[.-]/).filter((p) => p.length > 2));

  for (const raw of titles) {
    const words = clean(raw)
      .split(' ')
      .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !domainParts.has(w));
    // 2-grams, 3-grams, 4-grams
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= words.length; i++) {
        const phrase = words.slice(i, i + n).join(' ');
        if (phrase.length < 6) continue;
        // Specificity bonus: longer phrases are more targeted
        counts.set(phrase, (counts.get(phrase) ?? 0) + n);
      }
    }
  }
  return counts;
}

export async function suggestKeywords(
  tenantId: string,
  siteId: string,
): Promise<KeywordSuggestion[]> {
  const siteRes = await query(`SELECT domain, gsc_connected, gsc_refresh_token_enc FROM sites WHERE id = $1 AND tenant_id = $2`, [siteId, tenantId]);
  if (siteRes.rows.length === 0) throw new Error('Site not found');
  const site = siteRes.rows[0];

  // Already-tracked keywords + existing suggestions → dedupe set
  const existing = await query(
    `SELECT keyword FROM keywords WHERE site_id = $1
     UNION SELECT keyword FROM keyword_suggestions WHERE site_id = $1`,
    [siteId],
  );
  const seen = new Set(existing.rows.map((r: any) => r.keyword.toLowerCase().trim()));

  const suggestions: KeywordSuggestion[] = [];

  // ---- Source 1: GSC opportunity queries (free) ----
  if (site.gsc_connected && site.gsc_refresh_token_enc) {
    try {
      const gscQueries = await getGoogle().searchQueries(site.gsc_refresh_token_enc, siteUrl(site.domain));
      for (const q of gscQueries) {
        const kw = (q.query ?? '').toLowerCase().trim();
        if (!kw || kw.length < 4 || seen.has(kw)) continue;
        // Opportunity: getting impressions but ranking beyond page 1
        if (q.impressions > 0 && q.position > 10) {
          const score = Math.min(100, 40 + Math.log10(q.impressions + 1) * 15 + Math.min(20, (q.position - 10)));
          suggestions.push({
            keyword: kw,
            source: 'gsc',
            score: Math.round(score * 10) / 10,
            reason: `${q.impressions} impressions but ranking #${Math.round(q.position)} — push to page 1`,
            impressions: q.impressions,
            position: Math.round(q.position * 10) / 10,
          });
          seen.add(kw);
        }
      }
    } catch {
      // GSC unavailable (revoked token, API error) — fall through to content.
    }
  }

  // ---- Source 2: site content phrases (free, already crawled) ----
  const pages = await query(
    `SELECT title FROM audit_pages
     WHERE site_id = $1 AND title IS NOT NULL AND title <> ''
     ORDER BY created_at DESC LIMIT 200`,
    [siteId],
  );
  const titles = pages.rows.map((r: any) => r.title as string).filter(Boolean);
  // Fall back to the domain itself as a seed if no crawl data yet
  if (titles.length === 0) {
    titles.push(site.domain.replace(/[.-]/g, ' '));
  }
  const phrases = extractPhrases(titles, site.domain);
  const sorted = [...phrases.entries()].sort((a, b) => b[1] - a[1]);
  for (const [phrase, weight] of sorted.slice(0, 30)) {
    if (seen.has(phrase)) continue;
    const words = phrase.split(' ').length;
    const score = Math.min(100, 30 + weight * 2 + words * 5);
    suggestions.push({
      keyword: phrase,
      source: 'content',
      score: Math.round(score * 10) / 10,
      reason: `Found across your site content (${words}-word phrase)`,
    });
    seen.add(phrase);
    if (suggestions.length >= 40) break;
  }

  // Sort by score desc, return top 20
  suggestions.sort((a, b) => b.score - a.score);
  return suggestions.slice(0, 20);
}

/** Persist suggestions (idempotent — skips keywords already present). */
export async function saveSuggestions(
  tenantId: string,
  siteId: string,
  suggestions: KeywordSuggestion[],
): Promise<number> {
  let saved = 0;
  for (const s of suggestions) {
    const r = await query(
      `INSERT INTO keyword_suggestions (tenant_id, site_id, keyword, source, score, reason, impressions, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (site_id, keyword) DO NOTHING`,
      [tenantId, siteId, s.keyword, s.source, s.score, s.reason, s.impressions ?? null, s.position ?? null],
    );
    if ((r.rowCount ?? 0) > 0) saved++;
  }
  return saved;
}
