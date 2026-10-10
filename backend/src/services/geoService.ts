import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';
import { renderPrompt } from './prompt.js';
import { getLLM } from '../providers/llm.js';
import { recordUsage } from '../metering.js';
import { requireSite } from './sites.js';

export interface GeoCheckResult {
  platform: string;
  mentioned: boolean;
  snippet: string;
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

/**
 * Runs mention checks for one query across the given AI platforms.
 *
 * HONESTY NOTE (v1): there is no public API for "what did ChatGPT actually
 * answer". Our LLM *simulates* each platform's likely answer and we detect
 * brand mentions in that simulation. This is a directional estimate, NOT a
 * measurement of the real platforms — the UI must label it as such
 * ("simulated visibility estimate"). Native platform checks are a v2 item.
 *
 * Metering: geo checks consume the plan's geo_checks budget only (not
 * ai_words) — the feature is budgeted as its own unit.
 */
export async function runGeoCheck(
  tenantId: string,
  siteId: string,
  queryText: string,
  platforms: string[],
  q: QueryFn = defaultQuery,
): Promise<GeoCheckResult[]> {
  const site = await requireSite(tenantId, siteId, q);
  const results: GeoCheckResult[] = [];
  const llm = getLLM();
  for (const platform of platforms) {
    const prompt = await renderPrompt('geo-answer', { platform, query: queryText });
    const res = await llm.generate({ prompt, maxWords: 220 });
    const mentioned = detectMention(res.text, site.domain);
    const snippet = res.text.slice(0, 300);
    await q(
      `INSERT INTO geo_checks (id, tenant_id, site_id, query, platform, mentioned, context_snippet)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
      [tenantId, siteId, queryText, platform, mentioned, snippet],
    );
    await recordUsage(tenantId, 'geo_check', 1, siteId, undefined, q);
    results.push({ platform, mentioned, snippet });
  }
  return results;
}

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
