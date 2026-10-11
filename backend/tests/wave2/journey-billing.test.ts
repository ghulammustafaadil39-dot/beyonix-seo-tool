/**
 * Wave-2 PHASE GATE — billing journey (mock Stripe, real HTTP webhooks).
 *
 *   checkout (mock Stripe) → signed webhook checkout.session.completed →
 *   subscription active with the plan/period FROM the event → signed
 *   webhook invoice.paid → usage metering reserve/commit → portal flow →
 *   subscription.updated with cancel_at_period_end → invoice.payment_failed
 *   → past_due + grace → grace expiry → downgrade to starter + read-only
 *   (data kept, mutations 403) → duplicate webhook redelivery is a no-op.
 *
 * The mock webhook path requires MOCK_WEBHOOK_SECRET (P0-05: unsigned mock
 * events are never accepted, and the path is disabled in production). The
 * integration setup does not configure one, so this file sets it on the
 * shared config object for its own run and restores it afterwards — the
 * events below still travel the REAL route + REAL HMAC verification
 * (signMockWebhookEvent / verifyMockWebhookEvent), they are not applied
 * by calling applyPaymentEvent directly.
 *
 * Cancel is exercised BEFORE the past_due sequence on purpose: the portal
 * flow's observable state (cancel_at_period_end=true while still active)
 * is asserted while the subscription is active, which is the only state
 * in which a portal cancellation is meaningful.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../integration/helpers/app.js';
import { query, resetDb, uniqueEmail } from '../integration/helpers/db.js';
import { resetRedis } from '../integration/helpers/redis.js';
import { sessionTokenFromResponse } from '../helpers.js';
import { config } from '../../src/config.js';
import { signMockWebhookEvent } from '../../src/providers/stripe.js';
import { reserveUsage, commitUsage, getUsage } from '../../src/metering.js';
import { processBillingGrace } from '../../src/services/billing.js';

const MOCK_SECRET = 'qa-gate-mock-webhook-secret';

let app: FastifyInstance;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let token: string;
let tenantId: string;
let customerId: string;
const SUB_ID = 'sub_gate_1';
const periodStart = Math.floor(Date.now() / 1000) - 86400; // yesterday
const periodEnd = periodStart + 30 * 86400;
let invoicePaidRaw: string;

async function sendWebhook(rawBody: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/billing/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signMockWebhookEvent(rawBody, MOCK_SECRET),
    },
    payload: rawBody,
  });
}

function eventRaw(id: string, type: string, data: Record<string, unknown>): string {
  // Mock-provider envelope convention (see tests/p0-05.test.ts): the mock's
  // constructWebhookEvent returns evt.data AS the event object, unlike the
  // real provider which unwraps evt.data.object. So `data` here IS the
  // Stripe object (no {object: ...} wrapper). The divergence — and the
  // fact that a real-shaped payload is silently ignored with HTTP 200 —
  // is filed as a gate finding (mock/real shape mismatch).
  return JSON.stringify({
    id,
    created: Math.floor(Date.now() / 1000),
    type,
    data,
  });
}

beforeAll(async () => {
  await resetDb();
  await resetRedis();
  (config as any).mockWebhookSecret = MOCK_SECRET;
  app = await buildTestApp();

  const email = uniqueEmail('gatebilling');
  const password = `Gate!${Date.now()}${Math.floor(Math.random() * 1e9)}xQ9#Zz`;
  const s = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, password, name: 'Gate Billing' },
  });
  expect(s.statusCode).toBe(201);
  const body = s.json() as any;
  tenantId = body.tenant.id as string;
  token = sessionTokenFromResponse(s);
  const v = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/email/verify',
    payload: { token: body.verifyToken },
  });
  expect(v.statusCode).toBe(200);
}, 60000);

afterAll(async () => {
  (config as any).mockWebhookSecret = '';
  await app?.close();
});

describe('Wave-2 gate: billing journey', () => {
  it('checkout (mock Stripe) → signed webhook → subscription active with plan/period FROM the event', async () => {
    const checkout = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { ...auth(token), 'idempotency-key': `gate-billing-${Date.now()}` },
      payload: { planId: 'growth' },
    });
    expect(checkout.statusCode).toBe(200);
    expect((checkout.json() as any).url).toContain('/api/v1/billing/mock-confirm');

    const t = await query(`SELECT stripe_customer_id FROM tenants WHERE id = $1`, [tenantId]);
    customerId = t.rows[0].stripe_customer_id as string;
    expect(customerId).toMatch(/^cus_mock_/);

    const raw = eventRaw(`evt_gate_co_${Date.now()}`, 'checkout.session.completed', {
      id: 'cs_gate_1',
      object: 'checkout.session',
      customer: customerId,
      subscription: {
        id: SUB_ID,
        object: 'subscription',
        status: 'active',
        current_period_start: periodStart,
        current_period_end: periodEnd,
      },
      metadata: { tenantId, planId: 'growth' },
    });
    const wh = await sendWebhook(raw);
    expect(wh.statusCode).toBe(200);
    expect((wh.json() as any)).toMatchObject({ received: true, deduplicated: false });

    const sub = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: auth(token) });
    expect(sub.statusCode).toBe(200);
    const subBody = sub.json() as any;
    expect(subBody.status).toBe('active');
    expect(subBody.plan_id).toBe('growth');
    expect(subBody.stripe_sub_id).toBe(SUB_ID);
    // Period comes FROM the event — not now()+30d.
    expect(new Date(subBody.current_period_start).getTime()).toBe(periodStart * 1000);
    expect(new Date(subBody.current_period_end).getTime()).toBe(periodEnd * 1000);

    const tenant = await query(`SELECT plan_id FROM tenants WHERE id = $1`, [tenantId]);
    expect(tenant.rows[0].plan_id).toBe('growth');
  }, 60000);

  it('webhook invoice.paid records the paid invoice and keeps the subscription active', async () => {
    invoicePaidRaw = eventRaw(`evt_gate_inv_${Date.now()}`, 'invoice.paid', {
      id: 'in_gate_1',
      object: 'invoice',
      customer: customerId,
      subscription: SUB_ID,
      amount_paid: 2900,
      amount_due: 2900,
      currency: 'usd',
      period_start: periodStart,
      period_end: periodEnd,
      hosted_invoice_url: 'https://inv.test/gate1',
    });
    const wh = await sendWebhook(invoicePaidRaw);
    expect(wh.statusCode).toBe(200);
    expect((wh.json() as any).deduplicated).toBe(false);

    const invoices = await app.inject({ method: 'GET', url: '/api/v1/billing/invoices', headers: auth(token) });
    expect(invoices.statusCode).toBe(200);
    const list = invoices.json() as any;
    expect(list.total).toBeGreaterThanOrEqual(1);
    const inv = (list.data as any[]).find((i) => i.stripe_invoice_id === 'in_gate_1');
    expect(inv).toBeTruthy();
    expect(inv.status).toBe('paid');
    expect(Number(inv.amount_due_cents)).toBe(2900);

    const sub = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: auth(token) });
    expect((sub.json() as any).status).toBe('active');
  }, 60000);

  it('usage metering: reserve holds budget, commit settles at actuals, over-limit reserve 402s', async () => {
    const reservation = await reserveUsage(tenantId, 'growth', 'ai_words', 100);
    expect(reservation.used).toBe(100);
    expect(reservation.limit).toBe(30000); // growth ai_words_month

    // While reserved, the hold counts against the window total.
    expect(await getUsage(tenantId, 'ai_words')).toBe(100);

    await commitUsage(reservation.reservationId, 40);
    expect(await getUsage(tenantId, 'ai_words')).toBe(40);

    const summary = await app.inject({ method: 'GET', url: '/api/v1/usage', headers: auth(token) });
    expect(summary.statusCode).toBe(200);
    expect((summary.json() as any).limits.ai_words.used).toBe(40);
    expect((summary.json() as any).limits.ai_words.limit).toBe(30000);

    await expect(reserveUsage(tenantId, 'growth', 'ai_words', 999999)).rejects.toMatchObject({
      status: 402,
      code: 'LIMIT_EXCEEDED',
    });
    // The failed reserve consumed nothing.
    expect(await getUsage(tenantId, 'ai_words')).toBe(40);
  }, 60000);

  it('portal flow → subscription.updated carries cancel_at_period_end (still active until period end)', async () => {
    const portal = await app.inject({ method: 'POST', url: '/api/v1/billing/portal', headers: auth(token) });
    expect(portal.statusCode).toBe(200);
    expect(typeof (portal.json() as any).url).toBe('string');

    const raw = eventRaw(`evt_gate_cancel_${Date.now()}`, 'customer.subscription.updated', {
      id: SUB_ID,
      object: 'subscription',
      customer: customerId,
      status: 'active',
      cancel_at_period_end: true,
      current_period_start: periodStart,
      current_period_end: periodEnd,
      metadata: { planId: 'growth' },
    });
    const wh = await sendWebhook(raw);
    expect(wh.statusCode).toBe(200);

    const sub = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: auth(token) });
    const body = sub.json() as any;
    expect(body.status).toBe('active');
    expect(body.cancel_at_period_end).toBe(true);
  }, 60000);

  it('invoice.payment_failed → past_due with grace; tenant keeps the paid plan during grace', async () => {
    // Two sites: within growth (max 3), over starter (max 1) — needed to
    // prove read-only (not deletion) after the grace downgrade below.
    for (const domain of ['gate-billing-one.test', 'gate-billing-two.test']) {
      const s = await app.inject({
        method: 'POST',
        url: '/api/v1/sites',
        headers: auth(token),
        payload: { domain },
      });
      expect(s.statusCode).toBe(201);
    }

    const raw = eventRaw(`evt_gate_fail_${Date.now()}`, 'invoice.payment_failed', {
      id: 'in_gate_2',
      object: 'invoice',
      customer: customerId,
      subscription: SUB_ID,
      amount_due: 2900,
      currency: 'usd',
      period_start: periodStart,
      period_end: periodEnd,
      hosted_invoice_url: 'https://inv.test/gate2',
    });
    const wh = await sendWebhook(raw);
    expect(wh.statusCode).toBe(200);

    const sub = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: auth(token) });
    const body = sub.json() as any;
    expect(body.status).toBe('past_due');
    expect(new Date(body.grace_until).getTime()).toBeGreaterThan(Date.now() + 2 * 86400_000);
    expect(body.plan_id).toBe('growth');

    const tenant = await query(`SELECT plan_id, read_only FROM tenants WHERE id = $1`, [tenantId]);
    expect(tenant.rows[0].plan_id).toBe('growth');
    expect(tenant.rows[0].read_only).toBe(false);
  }, 60000);

  it('grace expiry → downgrade to starter + read-only; excess data is kept, mutations blocked', async () => {
    // Simulate the grace window passing (the scheduler's daily job would
    // do this in real time; the gate forces the deadline, as c-01 does).
    await query(`UPDATE subscriptions SET grace_until = now() - interval '1 hour' WHERE tenant_id = $1`, [tenantId]);
    const processed = await processBillingGrace();
    expect(processed).toBeGreaterThanOrEqual(1);

    const tenant = await query(`SELECT plan_id, read_only FROM tenants WHERE id = $1`, [tenantId]);
    expect(tenant.rows[0].plan_id).toBe('starter');
    expect(tenant.rows[0].read_only).toBe(true);

    // Data is NOT deleted by the downgrade.
    const sites = await app.inject({ method: 'GET', url: '/api/v1/sites', headers: auth(token) });
    expect(sites.statusCode).toBe(200);
    expect((sites.json() as any).data.length).toBe(2);

    // Read-only blocks mutations on non-billing routes.
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: auth(token),
      payload: { domain: 'gate-billing-three.test' },
    });
    expect(blocked.statusCode).toBe(403);
    expect((blocked.json() as any).error.code).toBe('READ_ONLY_MODE');
  }, 60000);

  it('duplicate webhook redelivery is a no-op (idempotency ledger)', async () => {
    const invoicesBefore = await query(`SELECT COUNT(*)::int AS c FROM invoices WHERE tenant_id = $1`, [tenantId]);
    // Redeliver the EXACT invoice.paid event from earlier (same event id).
    const wh = await sendWebhook(invoicePaidRaw);
    expect(wh.statusCode).toBe(200);
    expect((wh.json() as any)).toMatchObject({ received: true, deduplicated: true });

    const invoicesAfter = await query(`SELECT COUNT(*)::int AS c FROM invoices WHERE tenant_id = $1`, [tenantId]);
    expect(invoicesAfter.rows[0].c).toBe(invoicesBefore.rows[0].c);

    // The replay did NOT resurrect the downgraded subscription/plan.
    const tenant = await query(`SELECT plan_id FROM tenants WHERE id = $1`, [tenantId]);
    expect(tenant.rows[0].plan_id).toBe('starter');
    const sub = await query(`SELECT status FROM subscriptions WHERE tenant_id = $1`, [tenantId]);
    expect(sub.rows[0].status).toBe('canceled');

    const ledger = await query(`SELECT COUNT(*)::int AS c FROM stripe_webhook_events WHERE event_type = 'invoice.paid'`);
    expect(ledger.rows[0].c).toBe(1);
  }, 60000);
});
