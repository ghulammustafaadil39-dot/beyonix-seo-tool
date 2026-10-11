// W-05: tiny subsequence fuzzy matcher for the command palette.
// Lower score = better. Returns Infinity when the query is not a
// subsequence of the target.

/** Score how well `query` matches `target`; Infinity = no match. */
export function fuzzyScore(query: string, target: string): number {
  const q = query.trim().toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Prefer matches that start at a word boundary or are consecutive.
      const boundary = ti === 0 || t[ti - 1] === ' ' || t[ti - 1] === '/' || t[ti - 1] === '.';
      const consecutive = ti === lastMatch + 1;
      score += ti + (consecutive ? -5 : 0) + (boundary ? -10 : 0);
      lastMatch = ti;
      qi++;
    }
  }
  return qi === q.length ? score : Infinity;
}

/** Filter + sort items by fuzzy score across their haystack fields. */
export function fuzzyFilter<T>(
  query: string,
  items: T[],
  haystack: (item: T) => string,
): T[] {
  const q = query.trim();
  if (!q) return items;
  return items
    .map((item) => ({ item, score: fuzzyScore(q, haystack(item)) }))
    .filter((r) => r.score !== Infinity)
    .sort((a, b) => a.score - b.score)
    .map((r) => r.item);
}
