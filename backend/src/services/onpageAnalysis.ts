import type { QueryFn } from '../db.js';

// Phase 8: Onpage auto per-page — analysis straight from the audit crawl.
// NO re-fetching, NO LLM cost. Deterministic checks on data the crawler
// already stored in audit_pages (migration 058 enriches it).
//
// NOTE: db is imported lazily (dynamic import) so the pure scoring
// functions stay importable in unit tests without Redis/DB.

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface OnpageCheck {
  key: string;
  label: string;
  status: CheckStatus;
  points: number;
  max: number;
  detail: string; // what we found, plain language
  fix: string;    // specific fix, plain language
}

export interface CrawledPageRow {
  url: string;
  status_code: number;
  title: string | null;
  word_count: number;
  load_ms: number;
  canonical: string | null;
  hreflangs: unknown;
  inlinks: number;
  outlinks: unknown;
  images: unknown;
  meta_description: string | null;
  h1s: unknown;
  robots_noindex: boolean;
  schema_types: unknown;
  has_og_tags: boolean;
  has_faq_schema: boolean;
  has_article_schema: boolean;
}

export interface PageSummary {
  url: string;
  title: string | null;
  status_code: number;
  word_count: number;
  score: number;
  grade: string;
}

export interface PageAnalysis {
  url: string;
  score: number;
  grade: string;
  checks: OnpageCheck[];
}

async function latestDoneAuditId(
  q: QueryFn,
  tenantId: string,
  siteId: string,
): Promise<string | null> {
  const r = await q(
    `SELECT id FROM audits
     WHERE tenant_id = $1 AND site_id = $2 AND status = 'done'
     ORDER BY finished_at DESC LIMIT 1`,
    [tenantId, siteId],
  );
  const row = (r.rows as any[])[0];
  return row ? row.id : null;
}

function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function parseJsonObjArray(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function gradeFor(score: number): string {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * Deterministic 0-100 score + checks for one crawled page.
 * `peerStats` carries site-wide duplicate counts computed once per audit.
 */
export function analyzePageRow(
  row: CrawledPageRow,
  peerStats: { titleCounts: Map<string, number>; metaCounts: Map<string, number> },
): PageAnalysis {
  const checks: OnpageCheck[] = [];
  const add = (c: OnpageCheck) => checks.push(c);

  const title = (row.title ?? '').trim();
  const tLen = title.length;
  const dupTitle = title ? (peerStats.titleCounts.get(title.toLowerCase()) ?? 1) : 0;

  // ---- Title (20) ----
  if (!title) {
    add({ key: 'title', label: 'Title tag', status: 'fail', points: 0, max: 20,
      detail: 'Is page ka title tag missing hai — Google ko nahi pata page kis bare me hai.',
      fix: 'Page ka main topic + brand likho, 30-60 characters me. Example: "Best Plumbers in Lahore | Beyonix".' });
  } else if (tLen < 30 || tLen > 60) {
    add({ key: 'title', label: 'Title tag', status: 'warn', points: 10, max: 20,
      detail: `Title hai (${tLen} characters) lekin ideal range 30-60 se bahar hai.` + (dupTitle > 1 ? ` Ye title ${dupTitle} pages pe repeat ho raha hai.` : ''),
      fix: tLen < 30
        ? 'Title me main keyword aur thodi detail add karo taake 30+ characters ho.'
        : 'Title chhota karo — 60 characters se zyada Google cut kar deta hai.' });
  } else if (dupTitle > 1) {
    add({ key: 'title', label: 'Title tag', status: 'warn', points: 14, max: 20,
      detail: `Title ki length theek hai (${tLen} chars) lekin ye ${dupTitle} pages pe duplicate hai.`,
      fix: 'Har page ka title unique rakho — page ka specific topic usme likho.' });
  } else {
    add({ key: 'title', label: 'Title tag', status: 'pass', points: 20, max: 20,
      detail: `Title perfect hai (${tLen} characters, unique).`,
      fix: '' });
  }

  // ---- Meta description (15) ----
  const md = (row.meta_description ?? '').trim();
  const mdLen = md.length;
  const dupMd = md ? (peerStats.metaCounts.get(md.toLowerCase()) ?? 1) : 0;
  if (!md) {
    add({ key: 'meta', label: 'Meta description', status: 'fail', points: 0, max: 15,
      detail: 'Meta description missing hai — Google search result me jo snippet dikhta hai wo tum control nahi kar rahe.',
      fix: '120-160 characters ki selling description likho — keyword + benefit + call-to-action.' });
  } else if (mdLen < 120 || mdLen > 160) {
    add({ key: 'meta', label: 'Meta description', status: 'warn', points: 8, max: 15,
      detail: `Meta description hai lekin ${mdLen} characters — ideal 120-160 hai.` + (dupMd > 1 ? ` ${dupMd} pages pe duplicate hai.` : ''),
      fix: mdLen < 120
        ? 'Description me 1 benefit aur call-to-action add karo taake 120+ characters ho.'
        : '160 characters se zyada Google cut kar deta hai — chhota aur punchy rakho.' });
  } else if (dupMd > 1) {
    add({ key: 'meta', label: 'Meta description', status: 'warn', points: 10, max: 15,
      detail: `Length theek hai (${mdLen} chars) lekin ${dupMd} pages pe duplicate hai.`,
      fix: 'Har page ki description unique likho — page ka apna topic mention karo.' });
  } else {
    add({ key: 'meta', label: 'Meta description', status: 'pass', points: 15, max: 15,
      detail: `Meta description perfect hai (${mdLen} characters, unique).`,
      fix: '' });
  }

  // ---- H1 (15) ----
  const h1s = parseJsonArray(row.h1s);
  if (h1s.length === 0) {
    add({ key: 'h1', label: 'H1 heading', status: 'fail', points: 0, max: 15,
      detail: 'Is page pe koi H1 heading nahi hai — Google ko page ka main topic samajhne me mushkil hoti hai.',
      fix: 'Sirf ek H1 add karo jo page ke main keyword/topic ko describe kare.' });
  } else if (h1s.length > 1) {
    add({ key: 'h1', label: 'H1 heading', status: 'warn', points: 8, max: 15,
      detail: `Is page pe ${h1s.length} H1 headings hain — best practice sirf ek H1 hai.`,
      fix: 'Ek hi H1 rakho (main topic). Baqi headings ko H2 me convert karo.' });
  } else {
    add({ key: 'h1', label: 'H1 heading', status: 'pass', points: 15, max: 15,
      detail: `Exactly one clear H1: "${h1s[0].slice(0, 80)}${h1s[0].length > 80 ? '…' : ''}".`,
      fix: '' });
  }

  // ---- Images (10) ----
  const images = parseJsonObjArray(row.images);
  const missingAlt = images.filter((im) => !String(im?.alt ?? '').trim()).length;
  if (images.length === 0) {
    add({ key: 'images', label: 'Images', status: 'pass', points: 10, max: 10,
      detail: 'Is page pe koi image nahi hai — alt-text ka issue nahi.',
      fix: '' });
  } else if (missingAlt === 0) {
    add({ key: 'images', label: 'Images', status: 'pass', points: 10, max: 10,
      detail: `${images.length} images, sab me alt text hai.`,
      fix: '' });
  } else {
    add({ key: 'images', label: 'Images', status: missingAlt > 3 ? 'fail' : 'warn', points: missingAlt > 3 ? 3 : 6, max: 10,
      detail: `${images.length} images me se ${missingAlt} me alt text missing hai — screen readers aur Google Images inhe samajh nahi sakte.`,
      fix: `${missingAlt} images me descriptive alt text add karo (image me jo dikhta hai wo likho, keyword stuffing nahi).` });
  }

  // ---- Schema (10) ----
  const schemaTypes = parseJsonArray(row.schema_types);
  if (schemaTypes.length > 0) {
    const nice = schemaTypes.slice(0, 4).join(', ');
    add({ key: 'schema', label: 'Schema markup', status: 'pass', points: 10, max: 10,
      detail: `Structured data present: ${nice}${schemaTypes.length > 4 ? ` (+${schemaTypes.length - 4} more)` : ''}.`,
      fix: '' });
  } else if (row.has_faq_schema || row.has_article_schema) {
    add({ key: 'schema', label: 'Schema markup', status: 'warn', points: 6, max: 10,
      detail: 'Basic schema signals hain lekin full structured data nahi mila.',
      fix: 'Page type ke hisab se JSON-LD schema add karo (Article, FAQ, ya Organization).' });
  } else {
    add({ key: 'schema', label: 'Schema markup', status: 'warn', points: 0, max: 10,
      detail: 'Koi schema markup nahi mila — rich results aur AI answers ke liye schema madad karta hai.',
      fix: 'Page type ke hisab se JSON-LD schema add karo (Article/FAQ/Organization). GEO tab se ready-made snippet le sakte ho.' });
  }

  // ---- Internal links (10) ----
  const outlinks = parseJsonArray(row.outlinks);
  const inlinks = row.inlinks ?? 0;
  if (inlinks === 0 && outlinks.length === 0) {
    add({ key: 'links', label: 'Internal links', status: 'warn', points: 4, max: 10,
      detail: 'Is page ke koi internal links (in ya out) nahi mile — ye page site se alag-thalag hai.',
      fix: 'Related pages se is page ko link karo, aur is page se related pages ko link karo (natural anchor text).' });
  } else if (inlinks === 0) {
    add({ key: 'links', label: 'Internal links', status: 'warn', points: 6, max: 10,
      detail: `Is page ko koi aur page link nahi karta (0 inlinks) — orphan jaisa page hai. ${outlinks.length} outgoing links hain.`,
      fix: 'Related pages (homepage, category, blogs) se is page ko link karo.' });
  } else {
    add({ key: 'links', label: 'Internal links', status: 'pass', points: 10, max: 10,
      detail: `${inlinks} pages is page ko link karte hain, ${outlinks.length} outgoing internal links hain.`,
      fix: '' });
  }

  // ---- Content depth (15) ----
  const wc = row.word_count ?? 0;
  if (wc >= 800) {
    add({ key: 'content', label: 'Content depth', status: 'pass', points: 15, max: 15,
      detail: `Content kaafi detailed hai (${wc} words).`,
      fix: '' });
  } else if (wc >= 400) {
    add({ key: 'content', label: 'Content depth', status: 'warn', points: 9, max: 15,
      detail: `Content ${wc} words ka hai — decent hai lekin competitive queries ke liye aur depth chahiye.`,
      fix: 'Sections, examples, ya FAQ add karo taake 800+ words ho.' });
  } else {
    add({ key: 'content', label: 'Content depth', status: 'fail', points: 4, max: 15,
      detail: `Content bohat thin hai (sirf ${wc} words) — Google thin pages ko rank nahi karta.`,
      fix: 'Useful detail add karo: examples, steps, FAQ — kam se kam 400 words ka target rakho.' });
  }

  // ---- Technical basics (5) ----
  const tech: string[] = [];
  let techPts = 5;
  let techStatus: CheckStatus = 'pass';
  if (row.status_code !== 200) {
    tech.push(`HTTP ${row.status_code} return karta hai`);
    techPts = 0; techStatus = 'fail';
  }
  if (row.robots_noindex) {
    tech.push('noindex set hai — Google is page ko index nahi karega');
    techPts = Math.min(techPts, 1); techStatus = 'fail';
  }
  if (!row.canonical) {
    tech.push('canonical tag missing');
    techPts = Math.min(techPts, 3); if (techStatus === 'pass') techStatus = 'warn';
  }
  const hreflangs = parseJsonArray(row.hreflangs);
  const techDetail = tech.length > 0
    ? `Issues: ${tech.join('; ')}.`
    : `HTTP 200, canonical ${row.canonical ? 'present' : 'missing'}, ${hreflangs.length} hreflang${hreflangs.length === 1 ? '' : 's'}${row.has_og_tags ? ', OG tags present' : ', OG tags missing'}.`;
  add({ key: 'technical', label: 'Technical basics', status: techStatus, points: techPts, max: 5,
    detail: techDetail,
    fix: tech.length > 0
      ? (row.robots_noindex ? 'Agar ye page index hona chahiye to noindex hatao. ' : '') +
        (!row.canonical ? 'Self-referencing canonical tag add karo. ' : '') +
        (row.status_code !== 200 ? 'Page ka HTTP status theek karo (200 hona chahiye).' : '')
      : '' });

  const score = checks.reduce((a, c) => a + c.points, 0);
  return { url: row.url, score, grade: gradeFor(score), checks };
}

/** Pages of the latest finished audit, with quick deterministic scores. */
export async function listCrawledPages(
  tenantId: string,
  siteId: string,
  q?: QueryFn,
): Promise<{ auditId: string | null; pages: PageSummary[] }> {
  const query: QueryFn = q ?? (await import('../db.js')).query;
  const auditId = await latestDoneAuditId(query, tenantId, siteId);
  if (!auditId) return { auditId: null, pages: [] };

  const r = await query(
    `SELECT url, status_code, title, word_count, load_ms, canonical, hreflangs,
            inlinks, outlinks, images, meta_description, h1s, robots_noindex,
            schema_types, has_og_tags, has_faq_schema, has_article_schema
     FROM audit_pages
     WHERE tenant_id = $1 AND site_id = $2 AND audit_id = $3
     ORDER BY inlinks DESC, url ASC
     LIMIT 500`,
    [tenantId, siteId, auditId],
  );
  const rows = r.rows as CrawledPageRow[];

  // Duplicate-title/meta counts across this audit (once, for all pages).
  const titleCounts = new Map<string, number>();
  const metaCounts = new Map<string, number>();
  for (const row of rows) {
    const t = (row.title ?? '').trim().toLowerCase();
    if (t) titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
    const m = (row.meta_description ?? '').trim().toLowerCase();
    if (m) metaCounts.set(m, (metaCounts.get(m) ?? 0) + 1);
  }

  const pages: PageSummary[] = rows.map((row) => {
    const a = analyzePageRow(row, { titleCounts, metaCounts });
    return {
      url: row.url,
      title: row.title,
      status_code: row.status_code,
      word_count: row.word_count,
      score: a.score,
      grade: a.grade,
    };
  });
  return { auditId, pages };
}

/** Full per-page analysis from the latest audit's crawl data. */
export async function getCrawledPageAnalysis(
  tenantId: string,
  siteId: string,
  pageUrl: string,
  q?: QueryFn,
): Promise<PageAnalysis | null> {
  const query: QueryFn = q ?? (await import('../db.js')).query;
  const auditId = await latestDoneAuditId(query, tenantId, siteId);
  if (!auditId) return null;

  const all = await query(
    `SELECT url, status_code, title, word_count, load_ms, canonical, hreflangs,
            inlinks, outlinks, images, meta_description, h1s, robots_noindex,
            schema_types, has_og_tags, has_faq_schema, has_article_schema
     FROM audit_pages
     WHERE tenant_id = $1 AND site_id = $2 AND audit_id = $3`,
    [tenantId, siteId, auditId],
  );
  const rows = all.rows as CrawledPageRow[];

  const titleCounts = new Map<string, number>();
  const metaCounts = new Map<string, number>();
  for (const row of rows) {
    const t = (row.title ?? '').trim().toLowerCase();
    if (t) titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
    const m = (row.meta_description ?? '').trim().toLowerCase();
    if (m) metaCounts.set(m, (metaCounts.get(m) ?? 0) + 1);
  }

  // Match by exact URL, falling back to trailing-slash-insensitive match.
  const norm = pageUrl.replace(/\/$/, '');
  const row = rows.find((r) => r.url === pageUrl || r.url.replace(/\/$/, '') === norm);
  if (!row) return null;

  return analyzePageRow(row, { titleCounts, metaCounts });
}
