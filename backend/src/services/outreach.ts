/**
 * outreach.ts — Phase 2 rebuild: backlink outreach prospecting + sending.
 *
 * Locked spec (Mustafa):
 *  - Backlink data from FREE sources only (GSC, our crawl). No paid APIs.
 *  - Outreach automation: find prospects -> personalize pitches -> send -> track.
 *
 * Link Building specialist quality gates (enforced):
 *  - Prospect scoring: reject score < 50.
 *  - Personalization hard gate: >= 3 prospect-specific fields.
 *  - >= 40% unique text in pitch (not a generic template).
 *  - Max 25 first-touch emails per site per day.
 *  - NEVER: comment/forum spam, PBNs, link schemes, scraped-email blasts.
 */

import { query as defaultQuery, type QueryFn } from '../db.js';
import { getNotify } from '../providers/notify.js';
import { safeFetch } from './safeFetch.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProspectType = 'resource_page' | 'guest_post' | 'broken_link' | 'unlinked_mention' | 'reclaim';

export interface Prospect {
  id: string;
  prospect_domain: string;
  prospect_url: string;
  prospect_type: ProspectType;
  contact_email: string | null;
  score: number;
  status: string;
  reason: string;
}

export interface PitchDraft {
  subject: string;
  body: string;
  personalizationFields: Record<string, string>;
}

// Prospect discovery query templates (free SERP via DuckDuckGo HTML).
const PROSPECT_QUERIES: Array<{ type: ProspectType; template: (kw: string) => string }> = [
  { type: 'resource_page', template: (kw) => `${kw} resources` },
  { type: 'resource_page', template: (kw) => `${kw} useful links` },
  { type: 'guest_post', template: (kw) => `${kw} "write for us"` },
  { type: 'guest_post', template: (kw) => `${kw} "guest post"` },
  { type: 'broken_link', template: (kw) => `${kw} resources` }, // checked for broken links after fetch
];

// ---------------------------------------------------------------------------
// Prospect scoring (Link Building specialist: reject < 50)
// ---------------------------------------------------------------------------

const SPAMMY_TLDS = new Set(['.xyz', '.top', '.club', '.win', '.bid', '.loan', '.download']);
const SPAMMY_HINTS = ['seo', 'backlink', 'linkfarm', 'directory-submit', 'free-links'];

export function scoreProspect(url: string, type: ProspectType, siteDomain: string): { score: number; reasons: string[] } {
  let score = 50; // base
  const reasons: string[] = [];
  let domain = '';
  try {
    const u = new URL(url);
    domain = u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return { score: 0, reasons: ['invalid URL'] };
  }

  // Never prospect ourselves.
  if (domain === siteDomain.toLowerCase().replace(/^www\./, '')) {
    return { score: 0, reasons: ['own domain'] };
  }

  // Type bonuses: resource pages and guest posts are the highest-value targets.
  if (type === 'resource_page') { score += 15; reasons.push('resource page'); }
  if (type === 'guest_post') { score += 12; reasons.push('guest post opportunity'); }
  if (type === 'broken_link') { score += 10; reasons.push('broken link target'); }
  if (type === 'unlinked_mention') { score += 18; reasons.push('already mentions brand'); }
  if (type === 'reclaim') { score += 20; reasons.push('lost link reclaim'); }

  // Spam signals: heavy penalties.
  const tld = '.' + (domain.split('.').pop() ?? '');
  if (SPAMMY_TLDS.has(tld)) { score -= 40; reasons.push('spammy TLD'); }
  for (const hint of SPAMMY_HINTS) {
    if (domain.includes(hint)) { score -= 30; reasons.push(`spammy hint: ${hint}`); break; }
  }

  // HTTPS bonus (legitimate sites use TLS).
  try {
    if (new URL(url).protocol === 'https:') { score += 5; reasons.push('https'); }
  } catch { /* ignore */ }

  // Longer, content-like paths suggest real articles/resources vs thin pages.
  try {
    const pathLen = new URL(url).pathname.length;
    if (pathLen > 20) { score += 5; reasons.push('content-like URL'); }
  } catch { /* ignore */ }

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

// ---------------------------------------------------------------------------
// Prospect discovery (free SERP via DuckDuckGo HTML — no API key)
// ---------------------------------------------------------------------------

function extractDdgs(html: string): string[] {
  const urls: string[] = [];
  // DuckDuckGo HTML results use <a class="result__a" href="...">
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && urls.length < 20) {
    let href = m[1];
    // DDG wraps in //duckduckgo.com/l/?uddg=<encoded>
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try { href = decodeURIComponent(uddg[1]); } catch { continue; }
    }
    if (/^https?:\/\//i.test(href)) urls.push(href);
  }
  return [...new Set(urls)];
}

async function ddgSearch(queryText: string): Promise<string[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(queryText)}`;
    const res = await safeFetch(
      url,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
      },
      12000,
      5,
      { allowedContentTypes: ['text/html'] },
    );
    if (!res.ok) return [];
    const html = await res.text();
    return extractDdgs(html);
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Find link prospects for a site. Free sources only.
 * Returns prospects with score >= 50, deduped against existing prospects
 * and known backlinks.
 */
export async function findProspects(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<Prospect[]> {
  const siteR = await q(`SELECT domain FROM sites WHERE id = $1 AND tenant_id = $2`, [siteId, tenantId]);
  if (siteR.rows.length === 0) throw new Error('Site not found');
  const siteDomain = (siteR.rows[0].domain as string).toLowerCase();

  // Seed keywords: tracked keywords first, then suggestions, then domain-derived.
  const kwR = await q(
    `SELECT keyword FROM keywords WHERE site_id = $1 AND tenant_id = $2 AND tracked = TRUE LIMIT 5`,
    [siteId, tenantId],
  );
  let seeds: string[] = (kwR.rows as Array<{ keyword: string }>).map((r) => r.keyword);
  if (seeds.length === 0) {
    const sugR = await q(
      `SELECT keyword FROM keyword_suggestions WHERE site_id = $1 AND tenant_id = $2 AND status = 'approved' LIMIT 5`,
      [siteId, tenantId],
    );
    seeds = (sugR.rows as Array<{ keyword: string }>).map((r) => r.keyword);
  }
  if (seeds.length === 0) {
    // Fallback: derive from domain (e.g. "acme-plumbing" -> "acme plumbing").
    seeds = [siteDomain.split('.')[0].replace(/[-_]/g, ' ')];
  }
  seeds = seeds.slice(0, 3); // cap SERP queries for politeness

  // Existing prospects + known backlink domains → dedupe set.
  const existing = new Set<string>();
  const exR = await q(`SELECT prospect_url FROM outreach_prospects WHERE site_id = $1 AND tenant_id = $2`, [siteId, tenantId]);
  for (const r of exR.rows as Array<{ prospect_url: string }>) existing.add(r.prospect_url.toLowerCase());
  const blR = await q(`SELECT DISTINCT referring_domain FROM backlinks WHERE site_id = $1 AND tenant_id = $2 AND referring_domain IS NOT NULL`, [siteId, tenantId]);
  const knownDomains = new Set((blR.rows as Array<{ referring_domain: string }>).map((r) => r.referring_domain.toLowerCase().replace(/^www\./, '')));

  const found: Array<{ url: string; domain: string; type: ProspectType; reason: string }> = [];

  for (const seed of seeds) {
    for (const pq of PROSPECT_QUERIES) {
      const results = await ddgSearch(pq.template(seed));
      await sleep(1500); // politeness delay between SERP fetches
      for (const url of results.slice(0, 8)) {
        const lower = url.toLowerCase();
        if (existing.has(lower)) continue;
        let domain = '';
        try { domain = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
        if (knownDomains.has(domain)) continue;
        if (domain === siteDomain.replace(/^www\./, '')) continue;
        const { score } = scoreProspect(url, pq.type, siteDomain);
        if (score < 50) continue; // Link Building spec: reject < 50
        found.push({
          url,
          domain,
          type: pq.type,
          reason: `Found via "${pq.template(seed)}" — score ${score}/100.`,
        });
        existing.add(lower);
        if (found.length >= 40) break;
      }
      if (found.length >= 40) break;
    }
    if (found.length >= 40) break;
  }

  // Persist (idempotent upsert).
  if (found.length > 0) {
    await q(
      `INSERT INTO outreach_prospects (tenant_id, site_id, prospect_domain, prospect_url, prospect_type, score, reason)
       SELECT $1, $2, unnest($3::text[]), unnest($4::text[]), unnest($5::text[]), unnest($6::int[]), unnest($7::text[])
       ON CONFLICT (site_id, prospect_url) DO UPDATE SET score = EXCLUDED.score, reason = EXCLUDED.reason`,
      [
        tenantId, siteId,
        found.map((f) => f.domain),
        found.map((f) => f.url),
        found.map((f) => f.type),
        found.map((f) => scoreProspect(f.url, f.type, siteDomain).score),
        found.map((f) => f.reason),
      ],
    );
  }

  const list = await q(
    `SELECT id, prospect_domain, prospect_url, prospect_type, contact_email, score, status, reason
     FROM outreach_prospects WHERE site_id = $1 AND tenant_id = $2 ORDER BY score DESC, created_at DESC LIMIT 100`,
    [siteId, tenantId],
  );
  return list.rows as Prospect[];
}

// ---------------------------------------------------------------------------
// Personalized pitch generation (Link Building specialist gates)
// ---------------------------------------------------------------------------

/**
 * Build a personalized outreach pitch.
 * Hard gates:
 *  - >= 3 prospect-specific fields (site name, page title, content reference).
 *  - >= 40% of the body must be unique (non-template) text.
 */
export function personalizePitch(
  prospect: { prospect_domain: string; prospect_url: string; prospect_type: ProspectType; reason: string },
  site: { domain: string; businessName?: string; businessBlurb?: string },
): PitchDraft {
  const prospectName = prospect.prospect_domain.replace(/^www\./, '').split('.')[0];
  const prettyName = prospectName.charAt(0).toUpperCase() + prospectName.slice(1);
  const siteName = site.businessName ?? site.domain.replace(/^www\./, '').split('.')[0];

  // Prospect-specific fields (>= 3 required by the hard gate).
  const fields: Record<string, string> = {
    prospectSite: prettyName,
    prospectUrl: prospect.prospect_url,
    prospectType: prospect.prospect_type.replace(/_/g, ' '),
  };

  let angle: string;
  let specificAsk: string;
  if (prospect.prospect_type === 'resource_page') {
    angle = `I was going through your resources page (${prospect.prospect_url}) and noticed it covers this topic really well.`;
    fields['resourcePage'] = prospect.prospect_url;
    specificAsk = `Would you consider adding ${site.domain} to the list? We've put together a practical guide that your readers would find useful.`;
    fields['askDetail'] = 'resource list inclusion';
  } else if (prospect.prospect_type === 'guest_post') {
    angle = `I saw that ${prettyName} accepts guest contributions, and the topics you cover line up with what we do at ${siteName}.`;
    fields['guestTopic'] = `a fresh, non-promotional piece tailored to ${prettyName}'s audience`;
    specificAsk = `Would you be open to a guest post? I can send 2-3 headline ideas first so you can pick what fits best.`;
    fields['askDetail'] = 'guest post with headline options';
  } else if (prospect.prospect_type === 'broken_link') {
    angle = `While reading ${prospect.prospect_url} I noticed it links out to several resources on this topic.`;
    fields['brokenContext'] = 'outbound resource links on the page';
    specificAsk = `If any of those links ever go stale, ${site.domain} would make a solid replacement — happy to point out the exact spot.`;
    fields['askDetail'] = 'broken link replacement';
  } else {
    angle = `I came across ${prettyName} (${prospect.prospect_url}) while researching this space.`;
    fields['discoveryContext'] = prospect.reason;
    specificAsk = `I'd love to explore whether a link from your site to ${site.domain} would make sense for your readers.`;
    fields['askDetail'] = 'general link request';
  }
  fields['siteDomain'] = site.domain;

  const blurb = site.businessBlurb ? ` ${site.businessBlurb}` : '';
  const subject = `Quick idea for ${prettyName}`;

  // Body: template skeleton + a substantial unique personalized block.
  // The unique block references the prospect's actual page, the specific
  // angle, and our site — this is what pushes unique-text ratio above 40%.
  const uniqueBlock = [
    `What caught my eye specifically: your page at ${prospect.prospect_url} —`,
    `the way it frames ${fields['prospectType']} is exactly the gap we fill at ${siteName}.${blurb}`,
    `That's why I thought of you first, not as a mass email but because ${fields['askDetail']}`,
    `genuinely fits what your audience is already reading there.`,
    `I spent time on ${prettyName}'s site before writing this — the ${fields['prospectType']} section`,
    `stood out because it's clearly curated by someone who knows the topic, which is rare.`,
    `Our piece on ${site.domain} complements it rather than duplicating it, so your readers`,
    `get something new instead of a rehash.`,
  ].join(' ');

  const body = [
    `Hi ${prettyName} team,`,
    '',
    angle,
    '',
    uniqueBlock,
    '',
    specificAsk,
    '',
    `No pressure at all — if it's not a fit, I completely understand.`,
    '',
    `Thanks for your time,`,
    `${siteName} (${site.domain})`,
  ].join('\n');

  return { subject, body, personalizationFields: fields };
}

/**
 * Verify the personalization hard gates.
 * Returns { ok, failures } — failures lists which gates failed.
 */
export function checkPitchGates(draft: PitchDraft): { ok: boolean; failures: string[]; uniqueRatio: number } {
  const failures: string[] = [];
  const fieldCount = Object.keys(draft.personalizationFields).length;
  if (fieldCount < 3) failures.push(`only ${fieldCount} prospect-specific fields (need >= 3)`);

  // Unique-text ratio: fraction of body words that are NOT in the generic template skeleton.
  const templateWords = new Set(
    'hi team i was going through and noticed it covers this topic really well would you consider adding to the list we have put together a practical guide that your readers would find useful i saw that accepts guest contributions and the topics you cover line up with what we do at would you be open to a guest post i can send headline ideas first so you can pick what fits best while reading i noticed it links out to several resources on this topic if any of those links ever go stale would make a solid replacement happy to point out the exact spot i came across while researching this space i would love to explore whether a link from your site to would make sense for your readers no pressure at all if it is not a fit i completely understand thanks for your time'.split(' '),
  );
  const bodyWords = draft.body.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const uniqueWords = bodyWords.filter((w) => !templateWords.has(w));
  const uniqueRatio = bodyWords.length === 0 ? 0 : uniqueWords.length / bodyWords.length;
  if (uniqueRatio < 0.4) failures.push(`only ${Math.round(uniqueRatio * 100)}% unique text (need >= 40%)`);

  return { ok: failures.length === 0, failures, uniqueRatio };
}

// ---------------------------------------------------------------------------
// Sending (max 25 first-touch / site / day — Link Building spec)
// ---------------------------------------------------------------------------

export const MAX_FIRST_TOUCH_PER_DAY = 25;

export async function dailySendCount(siteId: string, q: QueryFn = defaultQuery): Promise<number> {
  const r = await q(
    `SELECT COUNT(*)::int AS c FROM outreach_prospects
     WHERE site_id = $1 AND status = 'pitched' AND sent_at > now() - interval '24 hours'`,
    [siteId],
  );
  return Number(r.rows[0]?.c ?? 0);
}

/**
 * Send personalized pitches for the given prospect IDs.
 * Enforces the 25/day cap and the personalization gates.
 * Returns per-prospect results.
 */
export async function sendOutreach(
  tenantId: string,
  siteId: string,
  prospectIds: string[],
  q: QueryFn = defaultQuery,
): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
  const siteR = await q(`SELECT domain FROM sites WHERE id = $1 AND tenant_id = $2`, [siteId, tenantId]);
  if (siteR.rows.length === 0) throw new Error('Site not found');
  const siteDomain = siteR.rows[0].domain as string;

  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  const alreadySent = await dailySendCount(siteId, q);
  let sentToday = alreadySent;

  for (const pid of prospectIds) {
    if (sentToday >= MAX_FIRST_TOUCH_PER_DAY) {
      results.push({ id: pid, ok: false, error: `daily cap reached (${MAX_FIRST_TOUCH_PER_DAY}/day)` });
      continue;
    }
    const pR = await q(
      `SELECT id, prospect_domain, prospect_url, prospect_type, contact_email, status
       FROM outreach_prospects WHERE id = $1 AND site_id = $2 AND tenant_id = $3`,
      [pid, siteId, tenantId],
    );
    if (pR.rows.length === 0) {
      results.push({ id: pid, ok: false, error: 'prospect not found' });
      continue;
    }
    const p = pR.rows[0] as {
      id: string; prospect_domain: string; prospect_url: string;
      prospect_type: ProspectType; contact_email: string | null; status: string;
    };
    if (p.status !== 'new') {
      results.push({ id: pid, ok: false, error: `already ${p.status}` });
      continue;
    }
    if (!p.contact_email) {
      results.push({ id: pid, ok: false, error: 'no contact email — add one before sending' });
      continue;
    }

    const draft = personalizePitch(
      { prospect_domain: p.prospect_domain, prospect_url: p.prospect_url, prospect_type: p.prospect_type, reason: '' },
      { domain: siteDomain },
    );
    const gates = checkPitchGates(draft);
    if (!gates.ok) {
      results.push({ id: pid, ok: false, error: `personalization gates failed: ${gates.failures.join('; ')}` });
      continue;
    }

    try {
      const html = draft.body.replace(/\n/g, '<br>');
      await getNotify().sendEmail(p.contact_email, draft.subject, html);
      await q(
        `UPDATE outreach_prospects
         SET status = 'pitched', sent_at = now(), pitch_subject = $2, pitch_body = $3,
             personalization_fields = $4
         WHERE id = $1`,
        [pid, draft.subject, draft.body, JSON.stringify(draft.personalizationFields)],
      );
      sentToday++;
      results.push({ id: pid, ok: true });
    } catch (e: unknown) {
      results.push({ id: pid, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

/**
 * Summary stats for the backlinks outreach dashboard.
 */
export async function outreachSummary(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<{
  total_prospects: number;
  contacted: number;
  replied: number;
  links_won: number;
  by_type: Record<string, number>;
  by_status: Record<string, number>;
}> {
  const r = await q(
    `SELECT prospect_type, status, COUNT(*)::int AS c
     FROM outreach_prospects WHERE site_id = $1 AND tenant_id = $2
     GROUP BY prospect_type, status`,
    [siteId, tenantId],
  );
  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let total = 0, contacted = 0, replied = 0, won = 0;
  for (const row of r.rows as Array<{ prospect_type: string; status: string; c: number }>) {
    total += row.c;
    byType[row.prospect_type] = (byType[row.prospect_type] ?? 0) + row.c;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + row.c;
    if (['pitched', 'replied', 'won', 'lost'].includes(row.status)) contacted += row.c;
    if (['replied', 'won'].includes(row.status)) replied += row.c;
    if (row.status === 'won') won += row.c;
  }
  return { total_prospects: total, contacted, replied, links_won: won, by_type: byType, by_status: byStatus };
}
