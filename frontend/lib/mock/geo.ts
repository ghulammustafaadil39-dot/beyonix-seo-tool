/**
 * lib/mock/geo.ts — F-05 GEO v2 UI (mock-data adapter).
 * Pending backend endpoints (Backend Lead):
 *   GET /api/v1/sites/:id/geo/prompts        → prompt sets per site
 *   GET /api/v1/sites/:id/geo/share-of-voice → SoV vs competitors
 *   GET /api/v1/sites/:id/geo/recommendations → citation recommendations
 * Rendered with <MockBanner/>. geoApi.score/check are real and stay primary.
 */

export interface GeoPrompt {
  id: string;
  prompt: string;
  engines: string[];
  last_checked: string;
}

export interface ShareOfVoice {
  brand: string;
  you: boolean;
  mention_rate: number;
  citation_rate: number;
}

export interface GeoRecommendation {
  id: string;
  title: string;
  detail: string;
  effort: 'quick win' | 'medium' | 'project';
  done: boolean;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockPrompts(): Promise<GeoPrompt[]> {
  await delay(250);
  return [
    {
      id: 'gp_1',
      prompt: 'best invoicing software for freelancers',
      engines: ['chatgpt', 'perplexity', 'gemini'],
      last_checked: '2026-10-10T08:00:00Z',
    },
    {
      id: 'gp_2',
      prompt: 'how to track seo rankings automatically',
      engines: ['chatgpt', 'claude', 'gemini'],
      last_checked: '2026-10-10T08:00:00Z',
    },
    {
      id: 'gp_3',
      prompt: 'what is the easiest seo tool for small business',
      engines: ['perplexity', 'gemini', 'ai_overviews'],
      last_checked: '2026-10-09T08:00:00Z',
    },
  ];
}

export async function mockShareOfVoice(): Promise<ShareOfVoice[]> {
  await delay(300);
  return [
    { brand: 'You', you: true, mention_rate: 34, citation_rate: 22 },
    { brand: 'Competitor A', you: false, mention_rate: 41, citation_rate: 35 },
    { brand: 'Competitor B', you: false, mention_rate: 25, citation_rate: 18 },
  ];
}

export async function mockGeoRecommendations(): Promise<GeoRecommendation[]> {
  await delay(250);
  return [
    {
      id: 'gr_1',
      title: 'Publish an llms.txt file',
      detail: 'Give AI crawlers a map of your best pages. One file at your domain root.',
      effort: 'quick win',
      done: false,
    },
    {
      id: 'gr_2',
      title: 'Add Organization + Product schema',
      detail: 'Structured data helps AI engines attribute facts to your brand.',
      effort: 'quick win',
      done: false,
    },
    {
      id: 'gr_3',
      title: 'Create an entity / about page',
      detail: 'A single factual page: who you are, what you do, where you operate.',
      effort: 'medium',
      done: false,
    },
  ];
}
