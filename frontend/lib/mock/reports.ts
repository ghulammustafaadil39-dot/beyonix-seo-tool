/**
 * lib/mock/reports.ts — F-08 Reporting v2 UI (mock-data adapter).
 * Pending backend endpoints (Backend Lead):
 *   GET/PATCH /api/v1/settings/white-label  → logo, colors, company name
 *   GET/POST/DELETE /api/v1/sites/:id/reports/schedules → scheduled delivery
 *   POST /api/v1/reports/:id/share          → client share link
 * The report list/generate endpoints are real and stay primary.
 * Rendered with <MockBanner/>.
 */

export interface WhiteLabel {
  company_name: string;
  logo_url: string | null;
  primary_color: string;
  footer_text: string;
}

export interface ReportSchedule {
  id: string;
  frequency: 'weekly' | 'monthly';
  recipients: string[];
  next_run: string;
  enabled: boolean;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockWhiteLabel(): Promise<WhiteLabel> {
  await delay(200);
  return {
    company_name: 'Acme Marketing Co.',
    logo_url: null,
    primary_color: '#14b8a6',
    footer_text: 'Prepared by Acme Marketing Co. · Confidential',
  };
}

export async function mockSchedules(): Promise<ReportSchedule[]> {
  await delay(250);
  return [
    {
      id: 'rs_1',
      frequency: 'weekly',
      recipients: ['client@example.com'],
      next_run: '2026-10-12T08:00:00Z',
      enabled: true,
    },
  ];
}

export async function mockShareLink(reportId: string): Promise<{ share_url: string }> {
  await delay(300);
  return {
    share_url: `https://app.beyonixseo.com/share/report/${reportId}/mock-token-9c1e`,
  };
}
