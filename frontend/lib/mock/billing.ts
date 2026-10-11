/**
 * lib/mock/billing.ts — F-11. SUPERSEDED (Wave 2 wiring): the billing
 * page no longer imports this file — invoices, checkout (coupon +
 * interval), billing email (via settings notify_email), and cancellation
 * (via the Stripe portal) are all wired to real endpoints in
 * app/dashboard/billing/page.tsx. Kept only so the mock shapes remain
 * reviewable; do not re-import without a MockBanner.
 */
import type { Invoice } from '@/lib/api';

/** Former billing-email mock shape (no such field exists in the backend;
 *  receipts go to the tenant notify_email — see lib/api.ts billingApi). */
export interface BillingEmailState {
  billing_email: string | null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockInvoices(): Promise<Invoice[]> {
  await delay(250);
  return [
    {
      id: '0f8f6d6a-0000-4000-8000-000000001042',
      stripe_invoice_id: 'in_mock_1042',
      amount_due_cents: 7900,
      currency: 'usd',
      status: 'paid',
      period_start: '2026-09-11T00:00:00Z',
      period_end: '2026-10-11T00:00:00Z',
      hosted_invoice_url: null,
      created_at: '2026-09-11T08:12:00Z',
    },
    {
      id: '0f8f6d6a-0000-4000-8000-000000001038',
      stripe_invoice_id: 'in_mock_1038',
      amount_due_cents: 7900,
      currency: 'usd',
      status: 'paid',
      period_start: '2026-08-11T00:00:00Z',
      period_end: '2026-09-11T00:00:00Z',
      hosted_invoice_url: null,
      created_at: '2026-08-11T08:12:00Z',
    },
  ];
}

export async function mockBillingEmail(): Promise<BillingEmailState> {
  await delay(200);
  return { billing_email: null };
}
