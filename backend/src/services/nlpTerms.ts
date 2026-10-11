// NLP term extraction + coverage scoring (F-04 content optimizer).
// Extracts the characteristic terms of the top-ranking SERP pages and scores
// how many of them a draft covers. Pure — callers supply the page texts.

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'that', 'this', 'from', 'have',
  'are', 'was', 'were', 'been', 'has', 'had', 'will', 'would', 'can', 'could',
  'should', 'they', 'their', 'them', 'its', 'our', 'all', 'any', 'each',
  'how', 'what', 'when', 'where', 'which', 'who', 'why', 'not', 'but', 'about',
  'into', 'than', 'then', 'there', 'these', 'those', 'such', 'more', 'most',
  'other', 'some', 'also', 'just', 'like', 'over', 'under', 'between', 'through',
  'because', 'while', 'after', 'before', 'both', 'few', 'does', 'did', 'doing',
  'her', 'his', 'him', 'she', 'its', 'may', 'might', 'must', 'shall', 'very',
  'well', 'even', 'ever', 'get', 'got', 'make', 'made', 'many', 'much', 'new',
  'now', 'one', 'two', 'use', 'used', 'using', 'way', 'best', 'top', 'guide',
]);

export interface TermStat {
  term: string;
  /** in how many of the input texts the term appears */
  df: number;
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/**
 * Characteristic terms of a corpus of top-ranking page texts: terms sorted
 * by document frequency (appear in >= minDf texts), topN returned.
 */
export function topTerms(texts: string[], topN = 30, minDf = 2): TermStat[] {
  const df = new Map<string, number>();
  for (const text of texts) {
    const seen = new Set(tokens(text));
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return [...df.entries()]
    .filter(([, d]) => d >= Math.min(minDf, texts.length))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([term, d]) => ({ term, df: d }));
}

export interface CoverageResult {
  /** 0..100 */
  coveragePct: number;
  present: string[];
  missing: string[];
}

/** Scores how many of `terms` appear in `draft`. Pure. */
export function termCoverage(draft: string, terms: TermStat[]): CoverageResult {
  const draftTokens = new Set(tokens(draft));
  const present: string[] = [];
  const missing: string[] = [];
  for (const t of terms) {
    (draftTokens.has(t.term) ? present : missing).push(t.term);
  }
  const coveragePct = terms.length === 0 ? 0 : Math.round((present.length / terms.length) * 100);
  return { coveragePct, present, missing };
}

/**
 * Extract plain text for term analysis from crawled HTML. Pure.
 * (Lightweight: strips scripts/styles; used by the optimizer.)
 */
export function pageTextForTerms(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
