import type { FastifyInstance } from 'fastify';
import { load } from 'cheerio';
import { authPlugin } from '../middleware/auth.js';
import { requireSite } from '../services/sites.js';
import { renderPrompt } from '../services/prompt.js';
import { generateMetered } from '../services/llmMetered.js';
import { checkLimit, assertLimit } from '../metering.js';
import { type PlanId } from '../plans.js';
import { safeFetch } from '../services/safeFetch.js';
import { ApiError, badRequest } from '../errors.js';

export interface PageBasics {
  statusCode: number;
  title: string;
  metaDescription: string;
  h1: string;
  textExcerpt: string;
}

/** Parse LLM suggestions; fall back to the raw text when it is not valid JSON. */
export function parseSuggestions(text: string): object {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/**
 * Lightweight page fetch (local to this module — not the audit crawler).
 * SSRF-protected via safeFetch; 8s timeout; extracts title, meta description,
 * h1 and a text excerpt via cheerio.
 */
async function fetchPageBasics(url: string): Promise<PageBasics> {
  try {
    const res = await safeFetch(
      url,
      { headers: { 'user-agent': 'BeyonixSEO/1.0 (on-page analyzer)' } },
      8000,
    );
    const statusCode = res.status;
    const html = await res.text();
    const $ = load(html);
    $('script, style, noscript').remove();
    const title = $('title').first().text().trim();
    const metaDescription = ($('meta[name="description"]').attr('content') ?? '').trim();
    const h1 = $('h1').first().text().trim();
    const textExcerpt = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 4000);
    return { statusCode, title, metaDescription, h1, textExcerpt };
  } catch (err) {
    // SSRF block / DNS failure / timeout — surface as a bad request, not a 500.
    throw badRequest(`Could not fetch that URL: ${(err as Error).message}`);
  }
}

/** Ensure the analyzed URL belongs to the site (exact domain or www-variant). */
function assertUrlOnSite(rawUrl: string, domain: string): void {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw badRequest('url must be a valid absolute URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw badRequest('url must use http(s)');
  }
  const host = u.hostname.toLowerCase();
  const d = domain.toLowerCase().replace(/^www\./, '');
  const bare = host.replace(/^www\./, '');
  if (bare !== d) {
    throw new ApiError(400, 'URL_NOT_ON_SITE', `URL host "${host}" does not belong to site "${domain}"`);
  }
}

const uuidParamSchema = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

interface SiteParams {
  id: string;
}

export interface QualityBreakdown {
  label: string;
  points: number;
  max: number;
  note: string;
}

export interface PageQuality {
  score: number;
  grade: string;
  breakdown: QualityBreakdown[];
}

/**
 * Deterministic 0-100 page quality score (Surfer-style grade for non-experts).
 * Computed from the fetched page basics + the LLM's suggestions — no extra
 * AI cost, fully explainable via the breakdown.
 */
export function scorePageQuality(basics: PageBasics, s: Record<string, any>): PageQuality {
  const breakdown: QualityBreakdown[] = [];
  const add = (label: string, points: number, max: number, note: string) =>
    breakdown.push({ label, points, max, note });

  // Title (20)
  let tp = 0;
  let tnote = 'Missing — add a descriptive title tag.';
  if (basics.title) {
    tp = 10;
    tnote = `Present (${basics.title.length} chars).`;
    if (basics.title.length >= 30 && basics.title.length <= 60) {
      tp = 20;
      tnote = `Good length (${basics.title.length} chars, ideal 30-60).`;
    } else {
      tnote = `Present but ${basics.title.length} chars — aim for 30-60.`;
    }
  }
  add('Title tag', tp, 20, tnote);

  // Meta description (15)
  let mp = 0;
  let mnote = 'Missing — write a 120-160 character summary.';
  if (basics.metaDescription) {
    mp = 8;
    const l = basics.metaDescription.length;
    if (l >= 120 && l <= 160) {
      mp = 15;
      mnote = `Good length (${l} chars).`;
    } else {
      mnote = `Present but ${l} chars — aim for 120-160.`;
    }
  }
  add('Meta description', mp, 15, mnote);

  // H1 (15)
  const hp = basics.h1 ? 15 : 0;
  add('H1 heading', hp, 15, basics.h1 ? 'Exactly one clear H1 found.' : 'Missing — add one H1 matching the page topic.');

  // Content depth (20) — excerpt is capped at 4000 chars by the fetcher
  const chars = basics.textExcerpt.length;
  let cp = 0;
  let cnote = 'Very thin content — expand with useful detail.';
  if (chars >= 2500) {
    cp = 20;
    cnote = 'Good content depth.';
  } else if (chars >= 1000) {
    cp = 12;
    cnote = 'Decent length — more depth would help competitive queries.';
  } else if (chars >= 300) {
    cp = 6;
    cnote = 'Thin — add sections, examples, or an FAQ.';
  }
  add('Content depth', cp, 20, cnote);

  // Reachable (10)
  const sp = basics.statusCode === 200 ? 10 : 0;
  add('Page reachable', sp, 10, basics.statusCode === 200 ? 'Returns HTTP 200.' : `Returns HTTP ${basics.statusCode}.`);

  // FAQ schema (10)
  const fq = typeof s.faqSchema === 'string' && s.faqSchema.length > 50;
  add('FAQ schema', fq ? 10 : 0, 10, fq ? 'FAQ structured data suggested below — paste it in.' : 'No FAQ schema suggested for this page.');

  // Internal links (10)
  const il = Array.isArray(s.internalLinks) ? s.internalLinks.length : 0;
  add('Internal links', il >= 3 ? 10 : il > 0 ? 5 : 0, 10, il > 0 ? `${il} internal-link suggestions below.` : 'No internal-link suggestions — link this page from related content.');

  const score = breakdown.reduce((a, b) => a + b.points, 0);
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F';
  return { score, grade, breakdown };
}

export interface SuggestionItem {
  area: string;
  current?: string;
  suggested?: string;
  note: string;
}

/** Normalizes the LLM's JSON into the array shape the dashboard renders. */
export function toSuggestionItems(basics: PageBasics, parsed: unknown): SuggestionItem[] {
  const s = (parsed ?? {}) as Record<string, any>;
  const items: SuggestionItem[] = [];
  if (typeof s.title === 'string' && s.title) {
    items.push({
      area: 'Title',
      current: basics.title || '(missing)',
      suggested: s.title,
      note: 'Keep it under 60 characters with the main keyword near the front.',
    });
  }
  if (typeof s.metaDescription === 'string' && s.metaDescription) {
    items.push({
      area: 'Meta description',
      current: basics.metaDescription || '(missing)',
      suggested: s.metaDescription,
      note: 'This is the snippet Google shows — make it sell the click.',
    });
  }
  if (Array.isArray(s.internalLinks) && s.internalLinks.length > 0) {
    const list = s.internalLinks
      .map((l: any) => `• "${l.anchor ?? ''}" — ${l.suggestion ?? ''}`)
      .join('\n');
    items.push({
      area: 'Internal links',
      suggested: list,
      note: 'Link this page from related pages using natural anchor text.',
    });
  }
  if (typeof s.faqSchema === 'string' && s.faqSchema.length > 50) {
    items.push({
      area: 'FAQ schema (copy-paste)',
      suggested: s.faqSchema.slice(0, 2000),
      note: 'Paste this JSON-LD into the page <head> for AI answers + rich results.',
    });
  }
  if (Array.isArray(s.contentGaps) && s.contentGaps.length > 0) {
    items.push({
      area: 'Content gaps',
      suggested: s.contentGaps.map((g: any) => `• ${String(g)}`).join('\n'),
      note: 'Topics this page is missing that would help it rank and get cited by AI search.',
    });
  }
  if (items.length === 0) {
    const raw = typeof s.raw === 'string' ? s.raw : JSON.stringify(parsed).slice(0, 2000);
    items.push({ area: 'AI suggestions', suggested: raw, note: 'Raw model output (could not be structured).' });
  }
  return items;
}

async function analyzeUrl(tenantId: string, plan: PlanId, siteId: string, rawUrl: string) {
  const site = await requireSite(tenantId, siteId);
  assertUrlOnSite(rawUrl, site.domain);

  // Pre-flight AI budget check (the worker-side spend is metered; this stops
  // obvious budget-burning before we fetch + call the LLM).
  assertLimit(await checkLimit(tenantId, plan, 'ai_words'));

  const basics = await fetchPageBasics(rawUrl);

  const prompt = await renderPrompt('onpage-suggest', {
    url: rawUrl,
    title: basics.title,
    metaDescription: basics.metaDescription,
    h1: basics.h1,
    textExcerpt: basics.textExcerpt.slice(0, 1500),
    issues: '',
  });
  const res = await generateMetered(tenantId, { prompt, maxWords: 600, siteId: site.id });
  const parsed = parseSuggestions(res.text);

  return {
    url: rawUrl,
    basics: {
      title: basics.title,
      metaDescription: basics.metaDescription,
      h1: basics.h1,
      statusCode: basics.statusCode,
    },
    quality: scorePageQuality(basics, (parsed ?? {}) as Record<string, any>),
    suggestions: toSuggestionItems(basics, parsed),
    words: res.words,
  };
}

export async function registerOnpageRoutes(fastify: FastifyInstance) {
  await fastify.register(async (app) => {
    await authPlugin(app);

    // Fetch + analyze a single URL (LLM suggestions; meters ai_words).
    app.post<{ Params: SiteParams; Body: { url: string } }>(
      '/sites/:id/onpage/analyze',
      {
        schema: {
          params: uuidParamSchema,
          body: {
            type: 'object',
            required: ['url'],
            properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } },
          },
        },
      },
      async (req) => analyzeUrl(req.tenant.tenantId, req.tenant.plan, req.params.id, req.body.url),
    );

    // Same analysis, URL passed as query param.
    app.get<{ Params: SiteParams; Querystring: { url: string } }>(
      '/sites/:id/onpage',
      {
        schema: {
          params: uuidParamSchema,
          querystring: {
            type: 'object',
            required: ['url'],
            properties: { url: { type: 'string', minLength: 1, maxLength: 2048 } },
          },
        },
      },
      async (req) => analyzeUrl(req.tenant.tenantId, req.tenant.plan, req.params.id, req.query.url),
    );
  });
}
