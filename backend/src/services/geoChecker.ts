// Phase 5 (GEO readiness): FREE AI-visibility audit.
// No paid APIs, no LLM calls — we fetch the site's own files (llms.txt,
// robots.txt, homepage HTML) with SSRF protection and score AI readiness.
// This is the "AI tumhara naam lega ya nahi" check, explained plainly.

import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';
import { requireSite } from './sites.js';
import { safeFetch } from './safeFetch.js';

// AI crawlers to look for in robots.txt (allow = good, disallow = blocks AI).
const AI_CRAWLERS = [
  'GPTBot',
  'ChatGPT-User',
  'ClaudeBot',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Bytespider',
  'Google-Extended', // controls Gemini/AI Overviews training use
  'CCBot',
  'FacebookBot', // Meta AI
];

export interface GeoReadinessCheck {
  key: string;
  label: string;
  /** Plain-language explanation (beginner-friendly). */
  detail: string;
  passed: boolean;
  points: number;
  maxPoints: number;
  /** What to do if failed — shown next to the Fix button. */
  fixHint: string;
}

export interface GeoReadinessResult {
  score: number; // 0-100
  checks: GeoReadinessCheck[];
  /** One-line plain-language verdict. */
  verdict: string;
  checkedAt: string;
}

const FETCH_MS = 10000;

async function fetchText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const res = await safeFetch(url, { headers: { 'User-Agent': 'BeyonixSEO-GEOCheck/1.0' } }, FETCH_MS, 3, {
      maxBytes: 2 * 1024 * 1024,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: text.slice(0, 500_000) };
  } catch {
    return { ok: false, status: 0, text: '' };
  }
}

function baseUrl(domain: string): string {
  const d = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return `https://${d}`;
}

/** Parse robots.txt: returns map of user-agent (lowercased) -> disallowed paths. */
function parseRobots(txt: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let current: string[] = [];
  for (const rawLine of txt.split('\n')) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      const ua = value.toLowerCase();
      if (!map.has(ua)) map.set(ua, []);
      current = map.get(ua)!;
      // '*' applies to all; keep it as its own entry too
    } else if (field === 'disallow') {
      current.push(value);
    }
  }
  return map;
}

/** Extract JSON-LD blocks from HTML and return parsed @type values. */
function extractJsonLdTypes(html: string): string[] {
  const types: string[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      const walk = (obj: unknown) => {
        if (!obj || typeof obj !== 'object') return;
        const o = obj as Record<string, unknown>;
        const t = o['@type'];
        if (typeof t === 'string') types.push(t);
        else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') types.push(x);
        const graph = o['@graph'];
        if (Array.isArray(graph)) for (const g of graph) walk(g);
      };
      for (const it of items) walk(it);
    } catch {
      // invalid JSON-LD — ignore
    }
  }
  return types;
}

/** Heuristic: does the page have clear, quotable definition content? */
function hasDefinitionContent(html: string): { ok: boolean; detail: string } {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // FAQ-like signals: question headings or FAQ schema already checked separately
  const questionCount = (text.match(/\?\s/g) ?? []).length;
  const h2Count = (html.match(/<h2[^>]*>/gi) ?? []).length;
  const wordCount = text.split(' ').filter(Boolean).length;
  if (wordCount < 300) {
    return { ok: false, detail: `Homepage has only ~${wordCount} words of text — AI needs clear, substantial content to quote.` };
  }
  if (questionCount >= 2 || h2Count >= 3) {
    return { ok: true, detail: `Found ${questionCount} questions and ${h2Count} sections — good quotable structure for AI answers.` };
  }
  return { ok: false, detail: 'No clear Q&A or definition blocks found — AI prefers pages that directly answer questions.' };
}

/**
 * Run the full FREE AI-readiness audit for a site.
 * Scoring: llms.txt (25) + robots AI-allow (15) + Organization schema (20)
 * + FAQ schema (20) + definition content (20) = 100.
 */
export async function checkAiVisibility(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<GeoReadinessResult> {
  const site = await requireSite(tenantId, siteId, q);
  const base = baseUrl(site.domain);
  const checks: GeoReadinessCheck[] = [];

  // 1. llms.txt (25)
  const llms = await fetchText(`${base}/llms.txt`);
  const llmsOk = llms.ok && llms.text.trim().length > 100;
  checks.push({
    key: 'llms_txt',
    label: 'llms.txt file',
    detail: llmsOk
      ? 'llms.txt found — AI crawlers get a structured intro to your site.'
      : 'No llms.txt found — AI assistants have no ready-made summary of your site to quote from.',
    passed: llmsOk,
    points: llmsOk ? 25 : 0,
    maxPoints: 25,
    fixHint: 'Click "Generate llms.txt" below — you\'ll get a ready file to add to your site.',
  });

  // 2. robots.txt AI crawlers (15)
  const robots = await fetchText(`${base}/robots.txt`);
  let robotsOk = false;
  let robotsDetail = 'robots.txt not found or could not be read.';
  if (robots.ok && robots.text.trim()) {
    const parsed = parseRobots(robots.text);
    const blocked: string[] = [];
    const starDisallows = parsed.get('*') ?? [];
    const starBlocksAll = starDisallows.includes('/');
    for (const crawler of AI_CRAWLERS) {
      const rules = parsed.get(crawler.toLowerCase());
      if (rules?.includes('/')) blocked.push(crawler);
      else if (!rules && starBlocksAll) blocked.push(crawler);
    }
    if (blocked.length === 0) {
      robotsOk = true;
      robotsDetail = 'No AI crawlers blocked — GPTBot, ClaudeBot, PerplexityBot can all access your site.';
    } else {
      robotsDetail = `These AI crawlers are blocked: ${blocked.join(', ')} — AI cannot read your site.`;
    }
  }
  checks.push({
    key: 'robots_ai',
    label: 'AI crawlers allowed',
    detail: robotsDetail,
    passed: robotsOk,
    points: robotsOk ? 15 : 0,
    maxPoints: 15,
    fixHint: 'Click "Fix robots.txt" below — you\'ll get lines that allow AI crawlers.',
  });

  // 3+4+5. Homepage: schema + content
  const home = await fetchText(base + '/');
  let orgOk = false;
  let faqOk = false;
  let defOk = false;
  let defDetail = 'Homepage did not load — schema check could not run.';
  if (home.ok && home.text) {
    const types = extractJsonLdTypes(home.text).map((t) => t.toLowerCase());
    orgOk = types.some((t) => t === 'organization' || t === 'localbusiness' || t.includes('business'));
    faqOk = types.some((t) => t === 'faqpage');
    const def = hasDefinitionContent(home.text);
    defOk = def.ok;
    defDetail = def.detail;
  }
  checks.push({
    key: 'org_schema',
    label: 'Organization schema',
    detail: orgOk
      ? 'Organization/LocalBusiness schema found — AI knows what business this site belongs to.'
      : 'No Organization schema found — AI cannot understand your business name, type, or contact info.',
    passed: orgOk,
    points: orgOk ? 20 : 0,
    maxPoints: 20,
    fixHint: 'Click "Copy schema" — you\'ll get ready JSON-LD to add to your homepage.',
  });
  checks.push({
    key: 'faq_schema',
    label: 'FAQ schema',
    detail: faqOk
      ? 'FAQ schema found — AI can directly quote your Q&A content.'
      : 'No FAQ schema found — your site is less likely to be quoted in AI answers.',
    passed: faqOk,
    points: faqOk ? 20 : 0,
    maxPoints: 20,
    fixHint: 'Click "Copy FAQ schema" — you\'ll get sample FAQ markup.',
  });
  checks.push({
    key: 'definition_content',
    label: 'Quotable content',
    detail: defDetail,
    passed: defOk,
    points: defOk ? 20 : 0,
    maxPoints: 20,
    fixHint: 'Add clear headings (H2) and Q&A blocks to your homepage.',
  });

  const score = checks.reduce((s, c) => s + c.points, 0);
  const verdict =
    score >= 80
      ? 'Excellent! Your site is ready for AI — AI will mention your brand.'
      : score >= 50
        ? 'Decent, but AI will often miss you. Fix the items below.'
        : 'Warning! AI cannot see your site at all. Fix this now.';

  return { score, checks, verdict, checkedAt: new Date().toISOString() };
}

export interface GeoFix {
  fixType: string;
  title: string;
  /** Ready-to-use content (file text, code snippet, or instructions). */
  content: string;
  contentKind: 'file' | 'code' | 'instructions';
}

/**
 * Generate specific, ready-to-use fixes for failed readiness checks.
 * All FREE — no paid APIs.
 */
export async function generateGeoFixes(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<GeoFix[]> {
  const site = await requireSite(tenantId, siteId, q);
  const domain = site.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const fixes: GeoFix[] = [];

  // llms.txt content
  const pages = await q(
    `SELECT title, url FROM audit_pages ap
     JOIN audits a ON a.id = ap.audit_id
     WHERE a.site_id = $1 AND ap.tenant_id = $2 AND ap.status_code = 200 AND ap.title IS NOT NULL
     ORDER BY ap.title LIMIT 30`,
    [siteId, tenantId],
  );
  const lines = [
    `# ${domain}`,
    '',
    `> ${domain} ki official website ka AI assistants ke liye summary.`,
    `> Official summary of ${domain} for AI assistants.`,
    '',
    '## About',
    `- Website: https://${domain}`,
    '',
    '## Key pages',
    '',
  ];
  for (const p of (pages.rows as Array<{ title: string; url: string }>).slice(0, 30)) {
    lines.push(`- [${p.title}](${p.url})`);
  }
  lines.push('', '## Contact', `Visit https://${domain} for contact information.`, '');
  fixes.push({
    fixType: 'llms_txt',
    title: 'llms.txt file banayein',
    content: lines.join('\n'),
    contentKind: 'file',
  });

  // robots.txt additions
  fixes.push({
    fixType: 'robots_txt',
    title: 'robots.txt me AI crawlers allow karein',
    content: [
      '# AI crawlers ko allow karein — ye lines robots.txt me add karein:',
      '',
      'User-agent: GPTBot',
      'Allow: /',
      '',
      'User-agent: ChatGPT-User',
      'Allow: /',
      '',
      'User-agent: ClaudeBot',
      'Allow: /',
      '',
      'User-agent: PerplexityBot',
      'Allow: /',
      '',
      'User-agent: Google-Extended',
      'Allow: /',
    ].join('\n'),
    contentKind: 'file',
  });

  // Organization schema
  fixes.push({
    fixType: 'org_schema',
    title: 'Organization schema (homepage ke <head> me lagayein)',
    content: JSON.stringify(
      {
        '@context': 'https://schema.org',
        '@type': 'Organization',
        name: domain,
        url: `https://${domain}`,
      },
      null,
      2,
    ),
    contentKind: 'code',
  });

  // FAQ schema sample
  fixes.push({
    fixType: 'faq_schema',
    title: 'FAQ schema sample (apne sawal-jawab se replace karein)',
    content: JSON.stringify(
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: 'Yahan apna sawal likhein?',
            acceptedAnswer: { '@type': 'Answer', text: 'Yahan jawab likhein.' },
          },
        ],
      },
      null,
      2,
    ),
    contentKind: 'code',
  });

  return fixes;
}

/** Save a readiness result to history. */
export async function saveReadinessResult(
  tenantId: string,
  siteId: string,
  result: GeoReadinessResult,
  q: QueryFn = defaultQuery,
): Promise<void> {
  await q(
    `INSERT INTO geo_readiness (tenant_id, site_id, score, checks)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [tenantId, siteId, result.score, JSON.stringify(result.checks)],
  );
}

/** Latest readiness result, or null if never checked. */
export async function latestReadiness(
  tenantId: string,
  siteId: string,
  q: QueryFn = defaultQuery,
): Promise<{ score: number; checks: GeoReadinessCheck[]; created_at: string } | null> {
  const r = await q(
    `SELECT score, checks, created_at FROM geo_readiness
     WHERE site_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [siteId, tenantId],
  );
  return (r.rows[0] as { score: number; checks: GeoReadinessCheck[]; created_at: string } | undefined) ?? null;
}

/** Score history for charts/insights. */
export async function readinessHistory(
  tenantId: string,
  siteId: string,
  days = 90,
  q: QueryFn = defaultQuery,
): Promise<Array<{ date: string; score: number }>> {
  const r = await q(
    `SELECT to_char(created_at, 'YYYY-MM-DD') AS date, MAX(score)::int AS score
     FROM geo_readiness
     WHERE site_id = $1 AND tenant_id = $2 AND created_at > now() - ($3 || ' days')::interval
     GROUP BY 1 ORDER BY 1`,
    [siteId, tenantId, String(days)],
  );
  return r.rows as Array<{ date: string; score: number }>;
}
