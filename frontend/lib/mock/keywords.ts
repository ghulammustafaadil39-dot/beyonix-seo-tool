/**
 * lib/mock/keywords.ts — F-03 Keyword v2 UI (mock-data adapter).
 * Pending backend endpoints (Backend Lead):
 *   GET /api/v1/sites/:id/keywords/clusters      → clusters by intent/topic
 *   GET /api/v1/sites/:id/keywords/cannibalization → cannibalization flags
 *   GET /api/v1/sites/:id/keywords/gap            → keyword gap vs competitors
 *   POST /api/v1/sites/:id/keywords/import        → bulk CSV import
 *   PATCH /api/v1/keywords/:id {lists, tags}
 * Rendered with <MockBanner/>.
 */
import type { Keyword } from '@/lib/api';

export interface KeywordCluster {
  id: string;
  name: string;
  intent: 'informational' | 'commercial' | 'transactional' | 'navigational';
  keywords: string[];
  total_volume: number;
}

export interface Cannibalization {
  keyword: string;
  urls: string[];
  recommendation: string;
}

export interface KeywordGap {
  keyword: string;
  volume: number;
  difficulty: number;
  competitors_ranking: string[];
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockClusters(): Promise<KeywordCluster[]> {
  await delay(250);
  return [
    {
      id: 'cl_1',
      name: 'invoicing software',
      intent: 'transactional',
      keywords: ['invoicing software', 'best invoicing software', 'free invoicing software'],
      total_volume: 14800,
    },
    {
      id: 'cl_2',
      name: 'seo reporting',
      intent: 'commercial',
      keywords: ['seo reporting tool', 'white label seo report', 'seo report template'],
      total_volume: 9300,
    },
    {
      id: 'cl_3',
      name: 'what is geo',
      intent: 'informational',
      keywords: ['what is geo seo', 'generative engine optimization', 'ai search optimization'],
      total_volume: 22100,
    },
  ];
}

export async function mockCannibalization(): Promise<Cannibalization[]> {
  await delay(250);
  return [
    {
      keyword: 'invoicing software',
      urls: ['/features/invoicing', '/blog/best-invoicing-software'],
      recommendation:
        'Two pages compete for this keyword. Keep /features/invoicing as the money page and re-target the blog post to “invoicing software for freelancers”.',
    },
  ];
}

export async function mockKeywordGap(): Promise<KeywordGap[]> {
  await delay(300);
  return [
    {
      keyword: 'ai visibility tracker',
      volume: 2400,
      difficulty: 28,
      competitors_ranking: ['competitor-a.com', 'competitor-b.com'],
    },
    {
      keyword: 'llms.txt generator',
      volume: 1900,
      difficulty: 22,
      competitors_ranking: ['competitor-a.com'],
    },
  ];
}

/** Parse a CSV/pasted list of keywords client-side for the bulk import UI. */
export function parseKeywordList(text: string): string[] {
  return text
    .split(/[\n,;]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 1 && s.length <= 100)
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .slice(0, 500);
}

/** Tag helpers for the lists/tags UI (local state until PATCH lands). */
export function withTags(kw: Keyword): Keyword & { tags: string[] } {
  return { ...kw, tags: [] };
}
