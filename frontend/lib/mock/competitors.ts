/**
 * lib/mock/competitors.ts — F-07 Competitor analysis UI (mock-data adapter).
 * Pending backend endpoints (Backend Lead):
 *   GET/POST /api/v1/sites/:id/competitors
 *   GET /api/v1/sites/:id/competitors/compare → visibility, keywords, gaps, links
 * Rendered with <MockBanner/>.
 */

export interface Competitor {
  id: string;
  domain: string;
  visibility: number; // 0–100 index
  keywords_overlap: number;
  backlinks: number;
  added_at: string;
}

export interface CompetitorGap {
  keyword: string;
  volume: number;
  their_position: number;
  your_position: number | null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockCompetitors(): Promise<Competitor[]> {
  await delay(250);
  return [
    { id: 'c1', domain: 'competitor-a.com', visibility: 78, keywords_overlap: 214, backlinks: 1840, added_at: '2026-09-02T10:00:00Z' },
    { id: 'c2', domain: 'competitor-b.com', visibility: 64, keywords_overlap: 142, backlinks: 960, added_at: '2026-09-02T10:00:00Z' },
  ];
}

export async function mockContentGaps(): Promise<CompetitorGap[]> {
  await delay(300);
  return [
    { keyword: 'ai visibility tracker', volume: 2400, their_position: 4, your_position: null },
    { keyword: 'white label seo dashboard', volume: 1300, their_position: 7, your_position: 38 },
    { keyword: 'seo report automation', volume: 2100, their_position: 5, your_position: 21 },
  ];
}
