// Content engine v2 workflow (F-04): brief -> outline -> draft -> optimize,
// version history, NLP term-coverage, internal-link suggestions, duplication
// check, SEO asset generation.

import { safeFetch } from './safeFetch.js';
import { getSerpSnapshot } from './serpSnapshots.js';
import { topTerms, termCoverage, pageTextForTerms, type TermStat } from './nlpTerms.js';
import { simhash64, hammingDistance } from './simhash.js';
import { generateMetered } from './llmMetered.js';
import { delimitUntrusted } from './promptSafety.js';
import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';

export const CONTENT_STATUSES = [
  'brief', 'outline', 'draft', 'review', 'changes_requested', 'approved', 'published',
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

const LEGACY_STATUSES: Record<string, ContentStatus> = {
  draft: 'draft', review: 'review', approved: 'approved',
};

/** Normalize legacy statuses; throws on unknown. Pure. */
export function normalizeStatus(s: string): ContentStatus {
  if ((CONTENT_STATUSES as readonly string[]).includes(s)) return s as ContentStatus;
  const legacy = LEGACY_STATUSES[s];
  if (legacy) return legacy;
  throw new Error(`Unknown content status: ${s}`);
}

const TRANSITIONS: Record<ContentStatus, ContentStatus[]> = {
  brief: ['outline', 'draft'],
  outline: ['draft', 'brief'],
  draft: ['review', 'outline'],
  review: ['approved', 'changes_requested'],
  changes_requested: ['draft', 'review'],
  approved: ['published', 'review'],
  published: [],
};

/** Pure: is a status transition allowed? */
export function canTransition(from: string, to: string): boolean {
  try {
    const f = normalizeStatus(from);
    const t = normalizeStatus(to);
    return TRANSITIONS[f].includes(t);
  } catch {
    return false;
  }
}

/** Append a version row before mutating a piece. */
export async function snapshotVersion(
  q: QueryFn,
  tenantId: string,
  piece: { id: string; title: string | null; outline: string | null; draft: string | null; status: string },
  changedBy = 'user',
): Promise<void> {
  await q(
    `INSERT INTO content_versions (id, tenant_id, piece_id, title, outline, draft, status, changed_by)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, piece.id, piece.title, piece.outline, piece.draft, piece.status, changedBy],
  );
}

export interface OptimizeResult {
  coveragePct: number;
  present: string[];
  missing: string[];
  topTerms: TermStat[];
  sourcesAnalyzed: number;
  keyword: string | null;
}

/**
 * F-04: NLP term-coverage scoring. Fetches the top-ranking pages for the
 * piece's keyword (via the shared SERP snapshot — no extra provider cost
 * when cached), extracts characteristic terms, and scores the draft.
 * Network failures degrade gracefully (fewer sources, never throws).
 */
export async function optimizeDraft(
  tenantId: string,
  piece: { id: string; site_id: string; keyword_id: string | null; draft: string | null; title: string },
  q: QueryFn = defaultQuery,
): Promise<OptimizeResult> {
  let keyword: string | null = null;
  if (piece.keyword_id) {
    const kr = await q(`SELECT keyword FROM keywords WHERE id = $1 AND tenant_id = $2`, [piece.keyword_id, tenantId]);
    keyword = (kr.rows[0]?.keyword as string | undefined) ?? null;
  }
  if (!keyword) {
    return { coveragePct: 0, present: [], missing: [], topTerms: [], sourcesAnalyzed: 0, keyword: null };
  }
  const site = await q(`SELECT domain FROM sites WHERE id = $1 AND tenant_id = $2`, [piece.site_id, tenantId]);
  const domain = (site.rows[0]?.domain as string | undefined) ?? '';

  const snap = await getSerpSnapshot(tenantId, keyword, domain, {}, q).catch(() => null);
  const urls = (snap?.items ?? [])
    .filter((i) => i.itemType === 'organic')
    .slice(0, 5)
    .map((i) => i.url)
    .filter(Boolean);

  const texts: string[] = [];
  for (const url of urls.slice(0, 5)) {
    try {
      const res = await safeFetch(url, { headers: { 'User-Agent': 'BeyonixSEO-Bot/1.0' } }, 8000);
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('text/html')) continue;
      const html = await res.text();
      const text = pageTextForTerms(html);
      if (text.length > 500) texts.push(text.slice(0, 20000));
    } catch {
      /* one bad source must not fail the analysis */
    }
  }
  const terms = topTerms(texts, 30, 2);
  const coverage = termCoverage(piece.draft ?? '', terms);
  return {
    coveragePct: coverage.coveragePct,
    present: coverage.present,
    missing: coverage.missing,
    topTerms: terms,
    sourcesAnalyzed: texts.length,
    keyword,
  };
}

export interface InternalLinkSuggestion {
  url: string;
  title: string;
  anchor: string;
  score: number;
}

function tokensOf(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length >= 4),
  );
}

/**
 * F-04: internal-link suggestions from the latest audit's page graph.
 * Scores audit pages by token overlap with the piece's keyword/title.
 */
export async function internalLinkSuggestions(
  tenantId: string,
  siteId: string,
  keyword: string,
  title: string,
  q: QueryFn = defaultQuery,
  limit = 5,
): Promise<InternalLinkSuggestion[]> {
  const ar = await q(
    `SELECT id FROM audits WHERE site_id = $1 AND tenant_id = $2 AND status = 'done'
     ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
    [siteId, tenantId],
  );
  if (ar.rows.length === 0) return [];
  const auditId = ar.rows[0].id as string;
  const pr = await q(
    `SELECT url, title FROM audit_pages
     WHERE audit_id = $1 AND tenant_id = $2 AND status_code = 200 AND title IS NOT NULL
     LIMIT 500`,
    [auditId, tenantId],
  );
  const want = tokensOf(`${keyword} ${title}`);
  if (want.size === 0) return [];
  const scored: InternalLinkSuggestion[] = [];
  for (const p of pr.rows as Array<{ url: string; title: string }>) {
    const have = tokensOf(p.title);
    let overlap = 0;
    for (const t of want) if (have.has(t)) overlap++;
    if (overlap === 0) continue;
    const score = overlap / Math.sqrt(want.size * Math.max(1, have.size));
    scored.push({ url: p.url, title: p.title, anchor: keyword, score: Math.round(score * 100) / 100 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export interface DuplicationHit {
  source: string;
  similarityPct: number;
}

/**
 * F-04: duplication check — simhash similarity of `text` against the
 * tenant's other content pieces and the site's crawled pages.
 */
export async function duplicationCheck(
  tenantId: string,
  siteId: string,
  pieceId: string,
  text: string,
  q: QueryFn = defaultQuery,
): Promise<DuplicationHit[]> {
  const target = simhash64(text);
  if (!target) return [];
  const hits: DuplicationHit[] = [];
  const pieces = (
    await q(
      `SELECT id, title, draft FROM content_pieces
       WHERE tenant_id = $1 AND site_id = $2 AND id <> $3 AND draft IS NOT NULL`,
      [tenantId, siteId, pieceId],
    )
  ).rows as Array<{ id: string; title: string; draft: string }>;
  for (const p of pieces) {
    const h = simhash64(p.draft);
    const dist = hammingDistance(target, h);
    if (dist <= 12) {
      hits.push({ source: `content: ${p.title}`, similarityPct: Math.round(((64 - dist) / 64) * 100) });
    }
  }
  const ar = await q(
    `SELECT id FROM audits WHERE site_id = $1 AND tenant_id = $2 AND status = 'done'
     ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
    [siteId, tenantId],
  );
  if (ar.rows.length > 0) {
    const pages = (
      await q(
        `SELECT url, simhash FROM audit_pages
         WHERE audit_id = $1 AND tenant_id = $2 AND simhash IS NOT NULL AND simhash <> '' LIMIT 1000`,
        [ar.rows[0].id, tenantId],
      )
    ).rows as Array<{ url: string; simhash: string }>;
    for (const pg of pages) {
      const dist = hammingDistance(target, pg.simhash);
      if (dist <= 12) {
        hits.push({ source: `page: ${pg.url}`, similarityPct: Math.round(((64 - dist) / 64) * 100) });
      }
    }
  }
  hits.sort((a, b) => b.similarityPct - a.similarityPct);
  return hits.slice(0, 10);
}

export interface SeoAssets {
  altTexts: string[];
  metaTitle: string;
  metaDescription: string;
  faqSchema: Record<string, unknown> | null;
}

/**
 * F-04: image alt texts + meta + FAQ schema generation (LLM, metered).
 * Output is schema-validated; HTML-escaped by callers (S-09).
 */
export async function generateSeoAssets(
  tenantId: string,
  input: { title: string; keyword: string; topics: string[]; imageCount?: number },
  q: QueryFn = defaultQuery,
): Promise<SeoAssets> {
  const n = Math.min(10, Math.max(1, input.imageCount ?? 3));
  const prompt =
    `You are an SEO assistant. For the article titled "${input.title}" targeting the keyword "${input.keyword}", ` +
    `produce STRICT JSON (no markdown, no commentary) with exactly these keys:\n` +
    `{"altTexts": ["alt text 1", ... ${n} items, each under 125 chars, descriptive, keyword-aware], ` +
    `"metaTitle": "under 60 chars, keyword near start", ` +
    `"metaDescription": "120-160 chars, includes keyword and a call to action", ` +
    `"faqSchema": {"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"...","acceptedAnswer":{"@type":"Answer","text":"..."}}]} or null}\n` +
    `Topics covered: ${delimitUntrusted(input.topics.join('; ').slice(0, 1000), { label: 'topics' })}`;
  const res = await generateMetered(tenantId, { prompt, maxWords: 600 }, q);
  const fallback: SeoAssets = {
    altTexts: [],
    metaTitle: input.title.slice(0, 60),
    metaDescription: '',
    faqSchema: null,
  };
  try {
    const jsonText = res.text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(jsonText.slice(jsonText.indexOf('{'))) as Partial<SeoAssets>;
    return {
      altTexts: Array.isArray(parsed.altTexts) ? parsed.altTexts.filter((x) => typeof x === 'string').slice(0, n) : [],
      metaTitle: typeof parsed.metaTitle === 'string' ? parsed.metaTitle.slice(0, 70) : fallback.metaTitle,
      metaDescription: typeof parsed.metaDescription === 'string' ? parsed.metaDescription.slice(0, 170) : '',
      faqSchema: parsed.faqSchema && typeof parsed.faqSchema === 'object' ? parsed.faqSchema : null,
    };
  } catch {
    return fallback;
  }
}

/** Brand-voice summary for prompts (empty string when no profile). */
export async function brandVoiceForSite(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<string> {
  const r = await q(
    `SELECT tone, vocabulary, do_rules, dont_rules FROM content_profiles WHERE tenant_id = $1 AND site_id = $2`,
    [tenantId, siteId],
  );
  if (r.rows.length === 0) return '';
  const p = r.rows[0] as { tone: string | null; vocabulary: string | null; do_rules: string | null; dont_rules: string | null };
  return [p.tone, p.vocabulary, p.do_rules, p.dont_rules].filter(Boolean).join(' | ');
}

/**
 * F-04: generate an outline from a content brief (LLM, metered).
 * Uses the content-brief-outline prompt template + the site's brand voice.
 */
export async function generateOutlineFromBrief(
  tenantId: string,
  input: { keyword: string; title: string; brief: string; tone: string; siteDomain: string; siteId: string },
  q: QueryFn = defaultQuery,
): Promise<string> {
  const { renderPrompt } = await import('./prompt.js');
  const brandVoice = await brandVoiceForSite(tenantId, input.siteId, q);
  const prompt = await renderPrompt('content-brief-outline', {
    keyword: input.keyword,
    title: input.title,
    tone: input.tone,
    siteDomain: input.siteDomain,
    brandVoice: brandVoice || '(no brand voice profile set)',
    brief: delimitUntrusted(input.brief.slice(0, 4000), { label: 'brief', maxChars: 4000 }),
  });
  const res = await generateMetered(tenantId, { prompt, maxWords: 500, siteId: input.siteId }, q);
  return res.text;
}
