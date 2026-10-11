/**
 * lib/mock/audit.ts — F-02 Audit v2 UI (mock-data adapter).
 * Pending backend endpoints (Backend Lead):
 *   GET /api/v1/audits/:id/history      → crawl-over-crawl score/issues history
 *   POST /api/v1/audits/:id/share       → { share_url, token }
 *   PATCH /api/v1/issues/:id  {status:'wont_fix'} (v2: new status value)
 * Rendered with <MockBanner/>. Real CSV export is client-side (no backend).
 */
import type { AuditIssue } from '@/lib/api';

export interface AuditHistoryPoint {
  audit_id: string;
  finished_at: string;
  score: number | null;
  issues_count: number;
  pages_crawled: number;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockAuditHistory(): Promise<AuditHistoryPoint[]> {
  await delay(250);
  return [
    { audit_id: 'au_101', finished_at: '2026-08-12T10:00:00Z', score: 71, issues_count: 34, pages_crawled: 48 },
    { audit_id: 'au_102', finished_at: '2026-08-26T10:00:00Z', score: 76, issues_count: 28, pages_crawled: 52 },
    { audit_id: 'au_103', finished_at: '2026-09-09T10:00:00Z', score: 82, issues_count: 21, pages_crawled: 55 },
    { audit_id: 'au_104', finished_at: '2026-09-30T10:00:00Z', score: 84, issues_count: 18, pages_crawled: 57 },
    { audit_id: 'au_105', finished_at: '2026-10-07T10:00:00Z', score: 87, issues_count: 15, pages_crawled: 59 },
  ];
}

export async function mockShareLink(siteDomain: string): Promise<{ share_url: string }> {
  await delay(300);
  return {
    share_url: `https://app.beyonixseo.com/share/audit/${encodeURIComponent(siteDomain)}/mock-token-7f3a`,
  };
}

/** Group issues by their `type` for the grouped-fixes view (client-side). */
export function groupIssues(issues: AuditIssue[]): Array<{ type: string; items: AuditIssue[] }> {
  const map = new Map<string, AuditIssue[]>();
  for (const i of issues) {
    const arr = map.get(i.type) ?? [];
    arr.push(i);
    map.set(i.type, arr);
  }
  return [...map.entries()]
    .map(([type, items]) => ({ type, items }))
    .sort((a, b) => b.items.length - a.items.length);
}
