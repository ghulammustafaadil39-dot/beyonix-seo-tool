// GEO v2 (F-05): multi-engine AI-visibility tracking with clearly-labeled
// simulations, prompt sets, sentiment + citation tracking, share-of-voice
// vs competitors, recommendations, and an llms.txt generator.
//
// HONESTY: no public API exposes "what ChatGPT actually answered". Every
// check is a simulation by our own LLM and is stored/returned with
// simulated = true. API responses and the UI MUST label these
// "simulated estimate" — never present them as real platform data.

import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';
import { renderPrompt } from './prompt.js';
import { delimitUntrusted } from './promptSafety.js';
import { generateMetered } from './llmMetered.js';
import { withUsageReservation } from '../metering.js';
import { requireSite } from './sites.js';

export const GEO_ENGINES = ['chatgpt', 'perplexity', 'gemini', 'claude', 'ai_overview'] as const;
// AUDIT (A1-L4): GeoEngine is a type-only export (zero runtime code);
// kept as the public domain type for GEO engine identifiers.
export type GeoEngine = (typeof GEO_ENGINES)[number];

export const SIMULATED_DISCLAIMER =
  'Simulated estimate: no public API exposes real AI-platform answers. ' +
  'These results simulate each engine with our own LLM and are directional only.';

export interface GeoCheckResult {
  platform: string;
  mentioned: boolean;
  snippet: string;
  sentiment: 'positive' | 'neutral' | 'negative';
  citations: string[];
  simulated: true;
  engineVersion: string;
}

/**
 * True when the site's brand (domain's first label) or full domain appears
 * in the AI platform's answer text. Case-insensitive.
 */
export function detectMention(text: string, domain: string): boolean {
  const lowered = text.toLowerCase();
  const brand = domain.split('.')[0].toLowerCase();
  return lowered.includes(brand) || lowered.includes(domain.toLowerCase());
}

const POSITIVE = ['best', 'excellent', 'great', 'leading', 'top-rated', 'outstanding', 'trusted', 'recommended', 'love', 'perfect', 'amazing', 'superb'];
const NEGATIVE = ['worst', 'terrible', 'awful', 'avoid', 'poor', 'bad', 'horrible', 'disappointing', 'scam', 'overpriced'];

/** Pure: naive sentiment of an answer snippet. */
export function analyzeSentiment(text: string): 'positive' | 'neutral' | 'negative' {
  const lowered = text.toLowerCase();
  let pos = 0;
  let neg = 0;
  for (const w of POSITIVE) if (lowered.includes(w)) pos++;
  for (const w of NEGATIVE) if (lowered.includes(w)) neg++;
  if (neg > pos) return 'negative';
  if (pos > 0) return 'positive';
  return 'neutral';
}

/** Pure: extract candidate cited domains from an answer snippet. */
export function extractCitations(text: string): string[] {
  const out = new Set<string>();
  const re = /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+\.[a-z]{2,})(?:[\s/)"']|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const d = m[1].toLowerCase();
    if (!d.includes('example.') && !d.endsWith('.png') && !d.endsWith('.jpg')) out.add(d);
  }
  return [...out].slice(0, 20);
}

/**
 * Runs mention checks for one query across the given AI engines.
 * Stores sentiment, citations and the simulated flag on every row, and
 * detects competitor brand mentions (from the site's competitors table)
 * so share-of-voice can be computed later.
 *
 * Metering: geo checks consume the plan's geo_checks budget; the LLM
 * simulation calls now ALSO go through the metered LLM path (SEC-FIX
 * Wave-3) so the tenant's llm_cost_cap_words (W-03), ai_words metering, and
 * BYOK key selection apply — a viewer can no longer trigger unbounded LLM
 * spend via GEO runs.
 */
export async function runGeoCheck(
  tenantId: string,
  siteId: string,
  queryText: string,
  platforms: string[],
  q: QueryFn = defaultQuery,
): Promise<GeoCheckResult[]> {
  const site = await requireSite(tenantId, siteId, q);
  const compRows = (
    await q(`SELECT domain FROM competitors WHERE site_id = $1 AND tenant_id = $2`, [siteId, tenantId])
  ).rows as Array<{ domain: string }>;
  const brands: string[] = [site.domain, ...compRows.map((c) => c.domain)];

  const results: GeoCheckResult[] = [];
  for (const platform of platforms) {
    // A1-M1: atomic geo_checks reservation per platform check — the old
    // checkLimit pre-flight + recordUsage pair was check-then-act.
    await withUsageReservation(tenantId, 'geo_checks', 1, async () => {
      const prompt = await buildGeoAnswerPrompt(platform, queryText);
      // SEC-FIX (Wave-3): metered path — enforces llm_cost_cap_words (402 when
      // tripped), records ai_words, and honors the tenant's BYOK key.
      const res = await generateMetered(tenantId, { prompt, maxWords: 220, siteId }, q);
      const engineVersion = res.provider.replace(/Provider$/, '').toLowerCase();
      const mentioned = detectMention(res.text, site.domain);
      const snippet = res.text.slice(0, 500);
      const sentiment = analyzeSentiment(snippet);
      const citations = extractCitations(res.text);
      const brandMentions: Record<string, boolean> = {};
      for (const b of brands) brandMentions[b] = detectMention(res.text, b);
      await q(
        `INSERT INTO geo_checks (id, tenant_id, site_id, query, platform, mentioned, context_snippet,
                                 sentiment, citations, simulated, engine_version)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8::jsonb, TRUE, $9)`,
        [tenantId, siteId, queryText, platform, mentioned, snippet, sentiment,
         JSON.stringify({ sources: citations, brands: brandMentions }), engineVersion],
      );
      results.push({ platform, mentioned, snippet, sentiment, citations, simulated: true, engineVersion });
      return { value: undefined as void };
    }, { siteId });
  }
  return results;
}

/**
 * A2-M7: builds the geo-answer prompt with the user's query text wrapped
 * in delimitUntrusted() — the raw query must never be interpolated
 * directly into the prompt (prompt-injection → stored artifacts).
 * Exported for regression tests.
 */
export async function buildGeoAnswerPrompt(platform: string, queryText: string): Promise<string> {
  return renderPrompt('geo-answer', {
    platform,
    query: delimitUntrusted(queryText, { label: 'user-query', maxChars: 500 }),
  });
};

/** % of AI answers mentioning the brand in the last 30 days. 0 when no checks. */
export async function geoScore(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<number> {
  const r = await q(
    `SELECT COUNT(*)::int AS total,
            COALESCE(SUM(CASE WHEN mentioned THEN 1 ELSE 0 END), 0)::int AS hits
     FROM geo_checks
     WHERE site_id = $1 AND tenant_id = $2
       AND checked_at > now() - interval '30 days'`,
    [siteId, tenantId],
  );
  const total = Number(r.rows[0]?.total ?? 0);
  const hits = Number(r.rows[0]?.hits ?? 0);
  if (total === 0) return 0;
  return Math.round((hits / total) * 100);
}

export interface ShareOfVoiceRow {
  domain: string;
  mentions: number;
  checks: number;
  mentionRatePct: number;
}

/**
 * Share-of-voice: mention rate per brand (site + tracked competitors)
 * across recent simulated checks. All inputs are simulated estimates.
 */
export async function shareOfVoice(
  tenantId: string,
  siteId: string,
  days = 30,
  q: QueryFn = defaultQuery,
): Promise<{ simulated: true; rows: ShareOfVoiceRow[] }> {
  const r = await q(
    `SELECT citations FROM geo_checks
     WHERE site_id = $1 AND tenant_id = $2 AND checked_at > now() - ($3 || ' days')::interval`,
    [siteId, tenantId, String(days)],
  );
  const counts = new Map<string, { mentions: number; checks: number }>();
  for (const row of r.rows as Array<{ citations: { brands?: Record<string, boolean> } | null }>) {
    const brands = row.citations?.brands;
    if (!brands) continue;
    for (const [domain, mentioned] of Object.entries(brands)) {
      const c = counts.get(domain) ?? { mentions: 0, checks: 0 };
      c.checks++;
      if (mentioned) c.mentions++;
      counts.set(domain, c);
    }
  }
  const rows: ShareOfVoiceRow[] = [...counts.entries()].map(([domain, c]) => ({
    domain,
    mentions: c.mentions,
    checks: c.checks,
    mentionRatePct: c.checks === 0 ? 0 : Math.round((c.mentions / c.checks) * 100),
  }));
  rows.sort((a, b) => b.mentionRatePct - a.mentionRatePct);
  return { simulated: true, rows };
}

export interface GeoHistoryPoint {
  date: string;
  platform: string;
  checks: number;
  mentions: number;
  mentionRatePct: number;
}

/** Daily mention-rate series per engine. All simulated. */
export async function geoHistory(
  tenantId: string,
  siteId: string,
  days = 30,
  q: QueryFn = defaultQuery,
): Promise<{ simulated: true; points: GeoHistoryPoint[] }> {
  const r = await q(
    `SELECT to_char(checked_at, 'YYYY-MM-DD') AS date, platform,
            COUNT(*)::int AS checks,
            COALESCE(SUM(CASE WHEN mentioned THEN 1 ELSE 0 END), 0)::int AS mentions
     FROM geo_checks
     WHERE site_id = $1 AND tenant_id = $2 AND checked_at > now() - ($3 || ' days')::interval
     GROUP BY 1, 2 ORDER BY 1, 2`,
    [siteId, tenantId, String(days)],
  );
  const points: GeoHistoryPoint[] = (r.rows as Array<{ date: string; platform: string; checks: number; mentions: number }>)
    .map((row) => ({
      date: row.date,
      platform: row.platform,
      checks: row.checks,
      mentions: row.mentions,
      mentionRatePct: row.checks === 0 ? 0 : Math.round((row.mentions / row.checks) * 100),
    }));
  return { simulated: true, points };
}

export interface GeoRecommendation {
  priority: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
}

/**
 * Rules-based GEO recommendations from the site's simulated data:
 * llms.txt, entity/FAQ pages, schema, citation building.
 */
export async function geoRecommendations(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<{ score: number; simulated: true; recommendations: GeoRecommendation[] }> {
  const site = await requireSite(tenantId, siteId, q);
  const score = await geoScore(tenantId, siteId, q);
  const recs: GeoRecommendation[] = [];

  const prompts = await q(`SELECT COUNT(*)::int AS n FROM geo_prompts WHERE site_id = $1 AND tenant_id = $2`, [siteId, tenantId]);
  if (Number(prompts.rows[0]?.n ?? 0) === 0) {
    recs.push({
      priority: 'high',
      title: 'Create a GEO prompt set',
      detail: 'Add 5-10 prompts your customers actually ask AI assistants (e.g. "best plumber near me") so every engine is tracked against the same questions.',
    });
  }
  if (score < 30) {
    recs.push({
      priority: 'high',
      title: 'Publish an llms.txt file',
      detail: `AI crawlers increasingly read llms.txt. Generate one from the llms-txt endpoint and deploy it at https://${site.domain}/llms.txt.`,
    });
    recs.push({
      priority: 'high',
      title: 'Add FAQ + entity pages with schema',
      detail: 'AI answers cite pages that directly answer questions. Add an FAQ section with FAQPage schema and dedicated entity/topic pages for your main services.',
    });
  } else if (score < 60) {
    recs.push({
      priority: 'medium',
      title: 'Strengthen citations',
      detail: 'You are mentioned in some answers. Get listed and reviewed on the domains AI engines cite most (check the citations on your recent checks).',
    });
  }
  const neg = await q(
    `SELECT COUNT(*)::int AS n FROM geo_checks
     WHERE site_id = $1 AND tenant_id = $2 AND sentiment = 'negative'
       AND checked_at > now() - interval '30 days'`,
    [siteId, tenantId],
  );
  if (Number(neg.rows[0]?.n ?? 0) > 0) {
    recs.push({
      priority: 'high',
      title: 'Address negative sentiment',
      detail: `${neg.rows[0].n} recent simulated answers carried negative sentiment about your brand. Review the snippets and fix the underlying issues (reviews, pricing pages, support docs).`,
    });
  }
  recs.push({
    priority: 'low',
    title: 'Keep content fresh',
    detail: 'AI engines prefer recently-updated sources. Refresh your top pages quarterly and re-run the prompt set after major changes.',
  });
  return { score, simulated: true, recommendations: recs };
}

/**
 * Pure: generate an llms.txt for the site (F-05 recommendation artifact).
 */
export function generateLlmsTxt(input: {
  domain: string;
  siteName: string;
  summary: string;
  pages: Array<{ title: string; url: string; description?: string }>;
}): string {
  const lines = [
    `# ${input.siteName}`,
    '',
    `> ${input.summary}`,
    '',
    '## Key pages',
    '',
  ];
  for (const p of input.pages.slice(0, 50)) {
    lines.push(`- [${p.title}](${p.url})${p.description ? `: ${p.description}` : ''}`);
  }
  lines.push('', `Contact: https://${input.domain}`, '');
  return lines.join('\n');
}
