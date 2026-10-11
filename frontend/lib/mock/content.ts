/**
 * lib/mock/content.ts — F-04 Content v2 UI (mock-data adapter).
 * Pending backend endpoints (Backend Lead):
 *   GET /api/v1/content/:id/versions       → version history
 *   GET /api/v1/content/:id/plagiarism      → { score, matches }
 *   POST /api/v1/content/:id/publish       → WordPress/Webflow connector
 * Rendered with <MockBanner/>. Approval uses the real /approve endpoint.
 */

export interface ContentVersion {
  id: string;
  version: number;
  title: string;
  created_at: string;
  words: number;
  author: string;
}

export interface PlagiarismResult {
  score: number; // 0–100 uniqueness
  matches: Array<{ url: string; percent: number }>;
  checked_at: string;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockVersions(): Promise<ContentVersion[]> {
  await delay(200);
  return [
    { id: 'v3', version: 3, title: 'Final draft — approved', created_at: '2026-10-09T14:20:00Z', words: 1840, author: 'A. Khan' },
    { id: 'v2', version: 2, title: 'Added NLP terms + internal links', created_at: '2026-10-08T11:02:00Z', words: 1712, author: 'AI draft' },
    { id: 'v1', version: 1, title: 'First AI draft', created_at: '2026-10-07T09:44:00Z', words: 1588, author: 'AI draft' },
  ];
}

export async function mockPlagiarism(): Promise<PlagiarismResult> {
  await delay(600);
  return {
    score: 96,
    matches: [{ url: 'https://example.com/similar-article', percent: 4 }],
    checked_at: new Date().toISOString(),
  };
}

export const PUBLISH_TARGETS = ['wordpress', 'webflow'] as const;
