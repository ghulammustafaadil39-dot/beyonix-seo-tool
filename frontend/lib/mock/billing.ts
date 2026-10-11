/**
 * lib/mock/billing.ts — F-11.
 *
 * Mock-data adapters for billing surfaces whose backend endpoints have
 * not landed yet (Backend Lead owns them; shapes relayed by LA):
 *
 *   GET    /api/v1/billing/invoices      → Invoice[]
 *   PATCH  /api/v1/settings (billing_email) → BillingEmail update
 *   DELETE /api/v1/billing/subscription  → schedule cancellation
 *
 * Rendered with <MockBanner/> wherever these are shown. Swap to real
 * fetch via withMockFallback when the endpoints land.
 */
import type { Invoice, BillingEmailState } from '@/lib/api';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockInvoices(): Promise<Invoice[]> {
  await delay(250);
  return [
    {
      id: 'in_mock_1042',
      number: 'BSEO-1042',
      amount: 7900,
      currency: 'usd',
      status: 'paid',
      period_start: '2026-09-11T00:00:00Z',
      period_end: '2026-10-11T00:00:00Z',
      pdf_url: null,
      created_at: '2026-09-11T08:12:00Z',
    },
    {
      id: 'in_mock_1038',
      number: 'BSEO-1038',
      amount: 7900,
      currency: 'usd',
      status: 'paid',
      period_start: '2026-08-11T00:00:00Z',
      period_end: '2026-09-11T00:00:00Z',
      pdf_url: null,
      created_at: '2026-08-11T08:12:00Z',
    },
    {
      id: 'in_mock_1031',
      number: 'BSEO-1031',
      amount: 2900,
      currency: 'usd',
      status: 'paid',
      period_start: '2026-07-11T00:00:00Z',
      period_end: '2026-08-11T00:00:00Z',
      pdf_url: null,
      created_at: '2026-07-11T08:12:00Z',
    },
  ];
}

export async function mockBillingEmail(): Promise<BillingEmailState> {
  await delay(200);
  return { billing_email: null };
}

/**
 * Pretends to schedule end-of-period cancellation. Returns the
 * cancellation record the real endpoint is expected to return.
 */
export async function mockScheduleCancellation(reason: string): Promise<{
  scheduled: boolean;
  cancel_at: string;
  reason: string;
}> {
  await delay(400);
  return {
    scheduled: true,
    cancel_at: new Date(Date.now() + 19 * 24 * 3600 * 1000).toISOString(),
    reason,
  };
}
