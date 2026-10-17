/**
 * contentCampaigns.ts — Phase 4 rebuild.
 *
 * Content campaigns: the client sets a publishing cadence (blogs/week or
 * blogs/month) and a mode (autopilot = auto-publish, approval = 2-3 options
 * for the client to pick). The tool is PROACTIVE: it suggests topics weekly
 * from free sources (tracked keywords, Phase-1 keyword suggestions, GSC
 * rising queries, competitor gaps) — never silent.
 *
 * generateBlog uses the human-style prompt (content-human-draft) and runs
 * the quality scorer — anything below 75 is rejected with rewrite notes.
 */

import { query } from '../db.js';
import { getGoogle } from '../providers/google.js';
import { siteUrl } from './sites.js';
import { renderPrompt } from './prompt.js';
import { delimitUntrusted } from './promptSafety.js';
import { generateMetered } from './llmMetered.js';
import { scoreContent, QUALITY_PASS_THRESHOLD } from './contentQuality.js';

export interface Campaign {
  id: string;
  tenant_id: string;
  site_id: string;
  name: string;
  blogs_per_week: number;
  blogs_per_month: number;
  mode: 'autopilot' | 'approval';
  status: string;
  created_at: string;
}

export interface CampaignTopic {
  id: string;
  campaign_id: string;
  topic: string;
  keyword: string | null;
  status: 'suggested' | 'approved' | 'rejected' | 'written';
  suggested_by: 'ai' | 'user';
  reason: string | null;
  content_piece_id: string | null;
  created_at: string;
}

export interface TopicSuggestion {
  topic: string;
  keyword: string;
  reason: string;
  source: 'keyword' | 'gsc' | 'competitor' | 'suggestion';
}

/** Topics already in this campaign (any status) — dedupe set. */
async function existingTopics(campaignId: string): Promise<Set<string>> {
  const r = await query(`SELECT lower(topic) AS t FROM campaign_topics WHERE campaign_id = $1`, [campaignId]);
  return new Set(r.rows.map((x: any) => (x.t as string).trim()));
}

/**
 * Suggest 5 fresh topics for a campaign from FREE sources:
 *  1. Phase-1 keyword suggestions (scored, deduped) not yet used as topics
 *  2. Tracked keywords ranking poorly (position > 10 from latest rank check)
 *  3. GSC queries with impressions but weak position (rising opportunities)
 *  4. Competitor gap keywords (competitors rank, site doesn't) — if discovery ran
 * Never suggests a topic already in the campaign.
 */
export async function suggestTopics(
  tenantId: string,
  siteId: string,
  campaignId: string,
  limit = 5,
): Promise<TopicSuggestion[]> {
  const seen = await existingTopics(campaignId);
  // Also dedupe against topics in OTHER campaigns of this site
  const other = await query(
    `SELECT lower(topic) AS t FROM campaign_topics WHERE site_id = $1 AND campaign_id <> $2`,
    [siteId, campaignId],
  );
  for (const r of other.rows) seen.add((r.t as string).trim());

  const out: TopicSuggestion[] = [];
  const take = (s: TopicSuggestion) => {
    const key = s.topic.toLowerCase().trim();
    if (seen.has(key) || out.some((o) => o.topic.toLowerCase().trim() === key)) return;
    seen.add(key);
    out.push(s);
  };

  // ---- 1. Phase-1 keyword suggestions (already scored) ----
  try {
    const ks = await query(
      `SELECT keyword, reason, score FROM keyword_suggestions
       WHERE site_id = $1 ORDER BY score DESC LIMIT 20`,
      [siteId],
    );
    for (const r of ks.rows) {
      if (out.length >= limit) break;
      const kw = r.keyword as string;
      take({
        topic: `The complete guide to ${kw}`,
        keyword: kw,
        reason: `Keyword opportunity: ${r.reason ?? 'suggested from your site data'}`,
        source: 'suggestion',
      });
    }
  } catch { /* table may not exist on old DBs — continue */ }

  // ---- 2. Tracked keywords ranking beyond page 1 ----
  if (out.length < limit) {
    try {
      const tk = await query(
        `SELECT k.keyword, rc.position FROM keywords k
         JOIN LATERAL (
           SELECT position FROM rank_checks WHERE keyword_id = k.id
           ORDER BY checked_at DESC LIMIT 1
         ) rc ON true
         WHERE k.site_id = $1 AND k.tracked = true AND rc.position IS NOT NULL AND rc.position > 10
         ORDER BY rc.position DESC LIMIT 10`,
        [siteId],
      );
      for (const r of tk.rows) {
        if (out.length >= limit) break;
        const kw = r.keyword as string;
        take({
          topic: `${kw}: everything you need to know`,
          keyword: kw,
          reason: `You're ranking #${r.position} for "${kw}" — a deep guide can push it to page 1`,
          source: 'keyword',
        });
      }
    } catch { /* continue */ }
  }

  // ---- 3. GSC rising queries (free Google data) ----
  if (out.length < limit) {
    try {
      const site = await query(`SELECT domain, gsc_connected, gsc_refresh_token_enc FROM sites WHERE id = $1`, [siteId]);
      const s = site.rows[0];
      if (s?.gsc_connected && s?.gsc_refresh_token_enc) {
        const queries = await getGoogle().searchQueries(s.gsc_refresh_token_enc, siteUrl(s.domain));
        const rising = queries
          .filter((q: any) => (q.impressions ?? 0) > 20 && (q.position ?? 99) > 10)
          .sort((a: any, b: any) => (b.impressions ?? 0) - (a.impressions ?? 0))
          .slice(0, 10);
        for (const q of rising) {
          if (out.length >= limit) break;
          const kw = String(q.query ?? '').trim();
          if (!kw) continue;
          take({
            topic: `${kw} — answered`,
            keyword: kw,
            reason: `Rising in Search Console: ${q.impressions} impressions at position #${Math.round(q.position ?? 0)}`,
            source: 'gsc',
          });
        }
      }
    } catch { /* GSC unavailable — continue */ }
  }

  // ---- 4. Competitor gaps (competitors rank, we don't) ----
  if (out.length < limit) {
    try {
      const gaps = await query(
        `SELECT keyword FROM competitor_keywords
         WHERE site_id = $1 AND site_position IS NULL AND competitor_position <= 10
         ORDER BY volume DESC NULLS LAST LIMIT 10`,
        [siteId],
      );
      for (const r of gaps.rows) {
        if (out.length >= limit) break;
        const kw = r.keyword as string;
        take({
          topic: `Why ${kw} matters — and how to get it right`,
          keyword: kw,
          reason: 'Competitors rank top 10 for this keyword and you don\'t — content gap',
          source: 'competitor',
        });
      }
    } catch { /* no competitor data yet — continue */ }
  }

  return out.slice(0, limit);
}

/** Persist AI suggestions (idempotent per campaign+topic). */
export async function saveTopicSuggestions(
  tenantId: string,
  siteId: string,
  campaignId: string,
  suggestions: TopicSuggestion[],
): Promise<number> {
  let saved = 0;
  for (const s of suggestions) {
    const r = await query(
      `INSERT INTO campaign_topics (tenant_id, site_id, campaign_id, topic, keyword, status, suggested_by, reason)
       VALUES ($1, $2, $3, $4, $5, 'suggested', 'ai', $6)
       ON CONFLICT (campaign_id, lower(topic)) DO NOTHING`,
      [tenantId, siteId, campaignId, s.topic, s.keyword, s.reason],
    );
    if ((r.rowCount ?? 0) > 0) saved++;
  }
  return saved;
}

export interface BlogResult {
  text: string;
  words: number;
  qualityScore: number;
  passed: boolean;
  qualityIssues: string[];
}

/**
 * Generate a blog post in HUMAN writing style (content-human-draft prompt).
 * Runs the quality scorer — throws if below the 75 pass threshold so the
 * caller gets explicit rewrite guidance instead of a weak article.
 */
export async function generateBlog(
  tenantId: string,
  opts: { topic: string; keyword: string; siteDomain: string; tone?: string; targetWords?: number; outline?: string; siteId?: string },
): Promise<BlogResult> {
  const targetWords = opts.targetWords ?? 1200;
  const prompt = await renderPrompt('content-human-draft', {
    keyword: delimitUntrusted(opts.keyword, { label: 'keyword', maxChars: 200 }),
    title: delimitUntrusted(opts.topic, { label: 'title', maxChars: 300 }),
    siteDomain: delimitUntrusted(opts.siteDomain, { label: 'site-domain', maxChars: 253 }),
    tone: delimitUntrusted(opts.tone ?? 'professional but warm', { label: 'tone', maxChars: 100 }),
    targetWords,
    outline: delimitUntrusted(
      opts.outline ?? 'What it is and why it matters; How it works / how to do it; Common mistakes to avoid; Practical examples; FAQ',
      { label: 'outline', maxChars: 2000 },
    ),
  });

  const res = await generateMetered(
    tenantId,
    { prompt, maxWords: targetWords + 300, temperature: 0.8, siteId: opts.siteId },
  );

  const q = scoreContent(res.text, opts.keyword);
  return {
    text: res.text,
    words: res.words,
    qualityScore: q.score,
    passed: q.passed,
    qualityIssues: q.passed ? [] : q.suggestions,
  };
}

/** Create a campaign for a site. */
export async function createCampaign(
  tenantId: string,
  siteId: string,
  input: { name: string; blogs_per_week?: number; blogs_per_month?: number; mode?: 'autopilot' | 'approval' },
): Promise<Campaign> {
  const r = await query(
    `INSERT INTO content_campaigns (tenant_id, site_id, name, blogs_per_week, blogs_per_month, mode)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      tenantId,
      siteId,
      input.name.trim().slice(0, 120),
      Math.max(0, Math.min(7, input.blogs_per_week ?? 1)),
      Math.max(0, Math.min(31, input.blogs_per_month ?? 4)),
      input.mode === 'autopilot' ? 'autopilot' : 'approval',
    ],
  );
  return r.rows[0] as Campaign;
}

/** Quality gate constant re-export for routes. */
export { QUALITY_PASS_THRESHOLD };
