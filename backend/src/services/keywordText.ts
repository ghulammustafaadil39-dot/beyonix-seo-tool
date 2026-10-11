// Keyword text helpers (F-03) — pure text transforms, no network.
// - Question-keyword detection (what/how/why/... + trailing '?').
// - Seed expansion: deterministic long-tail/question variants of a seed.
//   Expansion only *proposes* candidates; metrics come from the provider.

const QUESTION_STARTERS = [
  'who', 'what', 'where', 'when', 'why', 'how',
  'can', 'should', 'is', 'are', 'do', 'does', 'which',
];

/** True when the keyword is phrased as a question. */
export function isQuestionKeyword(keyword: string): boolean {
  const k = keyword.trim().toLowerCase();
  if (!k) return false;
  if (k.endsWith('?')) return true;
  const first = k.split(/\s+/)[0];
  return QUESTION_STARTERS.includes(first);
}

const LONGTAIL_PREFIXES = ['best', 'top', 'affordable'];
const LONGTAIL_SUFFIXES = ['cost', 'price', 'near me', 'for small business', 'services', 'company', 'guide', 'tips', 'checklist'];
const QUESTION_TEMPLATES = [
  'what is {s}',
  'how does {s} work',
  'why is {s} important',
  'how to choose {s}',
  '{s} vs alternatives',
];

/**
 * Deterministic seed expansion: question forms + long-tail variants.
 * Returns unique candidates (lowercased, trimmed), capped at `limit`.
 */
export function expandSeed(seed: string, limit = 25): string[] {
  const s = seed.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return [];
  const out = new Set<string>();
  const add = (k: string): void => {
    const c = k.trim().replace(/\s+/g, ' ');
    if (c && c !== s && out.size < limit) out.add(c);
  };
  for (const t of QUESTION_TEMPLATES) add(t.replace('{s}', s));
  for (const p of LONGTAIL_PREFIXES) add(`${p} ${s}`);
  for (const suf of LONGTAIL_SUFFIXES) add(`${s} ${suf}`);
  add(`how much does ${s} cost`);
  add(`${s} for beginners`);
  return [...out];
}

/**
 * Parse a bulk keyword CSV/text into clean keyword strings.
 * Accepts: one keyword per line, or comma-separated; ignores blanks,
 * strips quotes; caps at maxRows.
 */
export function parseKeywordBulkImport(text: string, maxRows = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    for (const cell of rawLine.split(',')) {
      const k = cell.trim().replace(/^"|"$/g, '').replace(/\s+/g, ' ');
      if (!k || k.length > 200) continue;
      const key = k.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(k);
      if (out.length >= maxRows) return out;
    }
  }
  return out;
}

/** Serialize keywords to a simple CSV (keyword,volume,difficulty,intent). */
export function keywordsToCsv(rows: Array<{ keyword: string; volume?: number | null; difficulty?: number | null; intent?: string | null }>): string {
  const esc = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ['keyword,volume,difficulty,intent'];
  for (const r of rows) {
    lines.push([esc(r.keyword), String(r.volume ?? ''), String(r.difficulty ?? ''), esc(r.intent ?? '')].join(','));
  }
  return lines.join('\n');
}
