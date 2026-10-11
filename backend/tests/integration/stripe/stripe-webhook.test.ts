/**
 * Q-01(a) / BUG-QA-W2-3: REAL Stripe-shape webhook integration tests.
 *
 * This file populates the previously-empty `integration-stripe` vitest
 * project. The stripe profile (tests/integration/setup.stripe.ts) sets fake
 * Stripe TEST-MODE keys, so `getPayments()` returns the REAL provider and
 * the webhook route verifies signatures through the real Stripe SDK
 * (`webhooks.constructEvent`, offline HMAC — no network).
 *
 * Every payload below is a genuine Stripe envelope:
 *   { id, object:'event', type, created, data: { object: { ... } } }
 * signed with `signStripePayload` (t=...,v1=HMAC-SHA256(secret, "<t>.<body>")).
 * That `data.object` envelope is exactly the parity BUG-QA-W2-2 fixed on
 * the mock path — these tests pin the real path against the same shape.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../helpers/app.js';
import { query, resetDb } from '../helpers/db.js';
import { resetRedis } from '../helpers/redis.js';
import {
  signStripePayload,
  stripeEvent,
  TEST_STRIPE_WEBHOOK_SECRET,
} from '../helpers/stripe.js';
import { verifyMockWebhookEvent, signMockWebhookEvent } from '../../../src/providers/stripe.js';

let app: FastifyInstance;
let seq = 0;

beforeAll(async () => {
  // Price ids are read live by planIdFromStripePrice(); set them before any
  // subscription.updated event is applied.
  process.env.STRIPE_PRICE_STARTER = 'price_test_starter_qa3';
  process.env.STRIPE_PRICE_GROWTH = 'price_test_growth_qa3';
  process.env.STRIPE_PRICE_PRO = 'price_test_pro_qa3';
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  await resetRedis();
});

async function makeTenant(customerId: string, plan = 'starter'): Promise<string> {
  const r = await query(
    `INSERT INTO tenants (id, name, plan_id, stripe_customer_id)
     VALUES (gen_random_uuid(), 'stripe-qa', $1, $2) RETURNING id`,
    [plan, customerId],
  );
  return r.rows[0].id as string;
}

async function postWebhook(payload: Record<string, unknown>, secret = TEST_STRIPE_WEBHOOK_SECRET) {
  const raw = JSON.stringify(payload);
  const sig = signStripePayload(raw, secret);
  return app.inject({
    method: 'POST',
    url: '/api/v1/billing/webhook',
    headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
    payload: raw,
  });
}

function evt(type: string, object: Record<string, unknown>): Record<string, unknown> {
  seq += 1;
  const e = stripeEvent(type, object);
  e.id = `evt_qa3_${Date.now()}_${seq}`;
  return e;
}

describe('integration-stripe: signed webhook HTTP flow (real provider)', () => {
  it('checkout.session.completed (data.object envelope) creates the subscription and upgrades the plan, period FROM Stripe', async () => {
    const tenantId = await makeTenant('cus_qa3_checkout');
    const start = 1_760_000_000;
    const end = start + 30 * 86400;
    const res = await postWebhook(
      evt('checkout.session.completed', {
        id: 'cs_qa3_1',
        object: 'checkout.session',
        customer: 'cus_qa3_checkout',
        subscription: {
          id: 'sub_qa3_1',
          object: 'subscription',
          status: 'active',
          current_period_start: start,
          current_period_end: end,
        },
        metadata: { tenantId, planId: 'growth' },
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, deduplicated: false });
    const sub = await query(`SELECT * FROM subscriptions WHERE tenant_id = $1`, [tenantId]);
    expect(sub.rows).toHaveLength(1);
    expect(sub.rows[0].plan_id).toBe('growth');
    expect(sub.rows[0].status).toBe('active');
    expect(new Date(sub.rows[0].current_period_end).getTime()).toBe(end * 1000);
    const t = await query(`SELECT plan_id FROM tenants WHERE id = $1`, [tenantId]);
    expect(t.rows[0].plan_id).toBe('growth');
  });

  it('redelivery of the same event id is deduplicated (no double-apply)', async () => {
    const tenantId = await makeTenant('cus_qa3_replay');
    const payload = evt('checkout.session.completed', {
      id: 'cs_qa3_2',
      object: 'checkout.session',
      customer: 'cus_qa3_replay',
      subscription: 'sub_qa3_2',
      metadata: { tenantId, planId: 'pro' },
    });
    const first = await postWebhook(payload);
    expect(first.statusCode).toBe(200);
    expect(first.json().deduplicated).toBe(false);
    const second = await postWebhook(payload);
    expect(second.statusCode).toBe(200);
    expect(second.json().deduplicated).toBe(true);
    const subs = await query(`SELECT * FROM subscriptions WHERE tenant_id = $1`, [tenantId]);
    expect(subs.rows).toHaveLength(1);
  });

  it('customer.subscription.updated maps the plan from the Stripe price id', async () => {
    const tenantId = await makeTenant('cus_qa3_upd');
    await query(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status)
       VALUES (gen_random_uuid(), $1, 'sub_qa3_upd', 'cus_qa3_upd', 'starter', 'active')`,
      [tenantId],
    );
    const res = await postWebhook(
      evt('customer.subscription.updated', {
        id: 'sub_qa3_upd',
        object: 'subscription',
        customer: 'cus_qa3_upd',
        status: 'active',
        current_period_start: 1_760_000_000,
        current_period_end: 1_762_592_000,
        metadata: {},
        items: {
          object: 'list',
          data: [{ id: 'si_qa3_1', price: { id: 'price_test_pro_qa3', object: 'price' } }],
        },
      }),
    );
    expect(res.statusCode).toBe(200);
    const t = await query(`SELECT plan_id FROM tenants WHERE id = $1`, [tenantId]);
    expect(t.rows[0].plan_id).toBe('pro');
  });

  it('invoice.paid records an invoice row for the resolved tenant', async () => {
    const tenantId = await makeTenant('cus_qa3_inv', 'growth');
    await query(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status)
       VALUES (gen_random_uuid(), $1, 'sub_qa3_inv', 'cus_qa3_inv', 'growth', 'active')`,
      [tenantId],
    );
    const res = await postWebhook(
      evt('invoice.paid', {
        id: 'in_qa3_1',
        object: 'invoice',
        customer: 'cus_qa3_inv',
        subscription: 'sub_qa3_inv',
        amount_paid: 4900,
        amount_due: 4900,
        currency: 'usd',
        period_start: 1_760_000_000,
        period_end: 1_762_592_000,
        hosted_invoice_url: 'https://invoice.stripe.test/in_qa3_1',
      }),
    );
    expect(res.statusCode).toBe(200);
    const inv = await query(`SELECT * FROM invoices WHERE tenant_id = $1`, [tenantId]);
    expect(inv.rows).toHaveLength(1);
    expect(inv.rows[0].stripe_invoice_id).toBe('in_qa3_1');
    expect(inv.rows[0].status).toBe('paid');
    expect(Number(inv.rows[0].amount_due_cents)).toBe(4900);
  });

  it('customer.subscription.deleted downgrades the tenant to starter', async () => {
    const tenantId = await makeTenant('cus_qa3_del', 'pro');
    await query(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status)
       VALUES (gen_random_uuid(), $1, 'sub_qa3_del', 'cus_qa3_del', 'pro', 'active')`,
      [tenantId],
    );
    const res = await postWebhook(
      evt('customer.subscription.deleted', {
        id: 'sub_qa3_del',
        object: 'subscription',
        customer: 'cus_qa3_del',
        status: 'canceled',
        metadata: {},
        items: { object: 'list', data: [] },
      }),
    );
    expect(res.statusCode).toBe(200);
    const t = await query(`SELECT plan_id FROM tenants WHERE id = $1`, [tenantId]);
    expect(t.rows[0].plan_id).toBe('starter');
  });

  it('rejects a tampered payload (signature no longer matches)', async () => {
    await makeTenant('cus_qa3_tamper');
    const payload = evt('checkout.session.completed', {
      id: 'cs_qa3_tamper',
      object: 'checkout.session',
      customer: 'cus_qa3_tamper',
      subscription: 'sub_qa3_tamper',
      metadata: { tenantId: 'x', planId: 'pro' },
    });
    const raw = JSON.stringify(payload);
    const sig = signStripePayload(raw, TEST_STRIPE_WEBHOOK_SECRET);
    const tampered = raw.replace('pro', 'growth');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      payload: tampered,
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    const subs = await query(`SELECT * FROM subscriptions`);
    expect(subs.rows).toHaveLength(0);
  });

  it('rejects a payload signed with the wrong secret', async () => {
    const payload = evt('invoice.paid', {
      id: 'in_qa3_wrong',
      object: 'invoice',
      customer: 'cus_nobody',
      amount_paid: 100,
    });
    const res = await postWebhook(payload, 'whsec_totally_wrong_secret_0000000000');
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects an unsigned webhook delivery', async () => {
    const payload = evt('invoice.paid', {
      id: 'in_qa3_unsigned',
      object: 'invoice',
      customer: 'cus_nobody',
      amount_paid: 100,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('integration-stripe: mock/real envelope parity (BUG-QA-W2-2)', () => {
  it('mock verifier unwraps data.object exactly like the real provider', () => {
    const secret = 'qa3_mock_parity_secret';
    const raw = JSON.stringify({
      id: 'evt_mock_parity',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_parity',
          object: 'checkout.session',
          customer: 'cus_parity',
          metadata: { tenantId: 't-parity', planId: 'growth' },
        },
      },
    });
    const sig = signMockWebhookEvent(raw, secret);
    const out = verifyMockWebhookEvent(raw, sig, secret);
    expect(out.type).toBe('checkout.session.completed');
    // Real provider returns data.object as `data` — the mock must match.
    expect((out.data as any).id).toBe('cs_parity');
    expect((out.data as any).metadata.planId).toBe('growth');
    expect((out.data as any).object).toBe('checkout.session');
  });

  it('mock verifier keeps the direct-object convention working', () => {
    const secret = 'qa3_mock_direct_secret';
    const raw = JSON.stringify({
      id: 'evt_mock_direct',
      type: 'checkout.session.completed',
      data: { id: 'cs_direct', object: 'checkout.session', metadata: { planId: 'pro' } },
    });
    const sig = signMockWebhookEvent(raw, secret);
    const out = verifyMockWebhookEvent(raw, sig, secret);
    expect((out.data as any).id).toBe('cs_direct');
  });

  it('mock verifier rejects a bad signature', () => {
    const raw = JSON.stringify({ id: 'evt_x', type: 'ping', data: { object: {} } });
    expect(() => verifyMockWebhookEvent(raw, 't=1,v1=' + '0'.repeat(64), 's')).toThrow();
  });
});
