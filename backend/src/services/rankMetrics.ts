// Rank metrics (C-05): visibility share + pixel rank helpers. Pure.

/**
 * Per-keyword visibility points from a position. A decaying curve:
 * position 1 = 100, top 3 = strong, page 1 = meaningful, page 2+ = trace.
 * `null` (not in top 100) = 0. Documented approximation, not a CTR model.
 */
export function positionVisibility(position: number | null): number {
  if (position === null || position < 1) return 0;
  if (position === 1) return 100;
  if (position === 2) return 60;
  if (position === 3) return 40;
  if (position <= 5) return 25;
  if (position <= 10) return 12;
  if (position <= 20) return 5;
  if (position <= 50) return 2;
  return 1;
}

export interface KeywordVisibility {
  keywordId: string;
  keyword: string;
  position: number | null;
  notRanked: boolean;
  visibility: number;
}

/**
 * Site visibility share 0..100: mean of per-keyword visibility points.
 * Also returns avg position (ranked only) and coverage counts.
 */
export function siteVisibilityShare(rows: KeywordVisibility[]): {
  visibilityShare: number;
  avgPosition: number | null;
  ranked: number;
  total: number;
} {
  const total = rows.length;
  if (total === 0) return { visibilityShare: 0, avgPosition: null, ranked: 0, total: 0 };
  const rankedRows = rows.filter((r) => r.position !== null);
  const ranked = rankedRows.length;
  const visibilityShare = Math.round(
    (rows.reduce((sum, r) => sum + r.visibility, 0) / total) * 10,
  ) / 10;
  const avgPosition =
    ranked === 0 ? null : Math.round((rankedRows.reduce((s, r) => s + (r.position as number), 0) / ranked) * 10) / 10;
  return { visibilityShare, avgPosition, ranked, total };
}

/** Competitor visibility from the same snapshot: position of their domain. */
export function competitorPositions(
  items: Array<{ position: number; domain: string }>,
  competitorDomains: string[],
): Record<string, number | null> {
  const norm = (d: string): string => d.trim().toLowerCase().replace(/^www\./, '');
  const out: Record<string, number | null> = {};
  for (const c of competitorDomains) {
    const want = norm(c);
    const hit = items.find((i) => norm(i.domain) === want);
    out[c] = hit ? hit.position : null;
  }
  return out;
}
