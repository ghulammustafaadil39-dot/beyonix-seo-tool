import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { buildApp } from '../src/index.js';
import {
  applyPaymentEvent,
  buildCheckoutSessionParams,
  getPayments,
  planIdFromStripePrice,
} from '../src/providers/stripe.js';
import { pool, query, runMigrations } from '../src/db.js';

/**
 * P0-04 (HIGH): Stripe plan changes never applied.
 *  - Checkout metadata was set on the session only, not the subscription, so
 *    customer.subscription.updated carried no planId.
 *  - Fix: set subscription_data.metadata {tenantId, planId} at checkout AND
 *    map plan from the Stripe price id -> plan (single source of truth =
 *    STRIPE_PRICE_*), with subscription metadata as fallback.
 *
 * Run with STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET + STRIPE_PRICE_* set so
 * the webhook tests exercise the REAL provider's signature verification
 * against Stripe-shaped signed fixtures (offline HMAC, no network).
 * DB-backed parts need DATABASE_URL pointing at bseo_test_backend.
 *
 * Without the Stripe env vars the Stripe-specific describes self-skip so a
 * plain `npm test` (mock billing) stays green; CI sets the vars for full
 * coverage.
 */
const HAS_PRICES = !!process.env.STRIPE_PRICE_GROWTH && !!process.env.STRIPE_PRICE_PRO;
const HAS_STRIPE_ENV =
  HAS_PRICES && !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_WEBHOOK_SECRET;
const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');
if (!HAS_STRIPE_ENV) {
  console.warn('[p0-04] Stripe env not set — Stripe-specific tests self-skip (mock mode)');
}
if (!HAS_TEST_DB) {
  console.warn('[p0-04] skipping DB-backed tests: DATABASE_URL does not point at a test database');
}

describe.runIf(HAS_PRICES)('P0-04 checkout params', () => {
  it('buildCheckoutSessionParams sets subscription_data.metadata {tenantId, planId}', () => {
    const params = buildCheckoutSessionParams({
      customerId: 'cus_123',
      planId: 'growth',
      successUrl: 'https://app/success',
      cancelUrl: 'https://app/cancel',
      metadata: { tenantId: 'tenant-abc' },
    });
    expect(params.subscription_data).toEqual({ metadata: { tenantId: 'tenant-abc', planId: 'growth' } });
    expect(params.metadata).toMatchObject({ planId: 'growth', tenantId: 'tenant-abc' });
    expect(params.line_items).toEqual([{ price: process.env.STRIPE_PRICE_GROWTH, quantity: 1 }]);
  });

  it('throws when no STRIPE_PRICE_* is configured for the plan', () => {
    expect(() =>
      buildCheckoutSessionParams({
        customerId: 'cus_123',
        planId: 'starter',
        successUrl: 'https://app/success',
        cancelUrl: 'https://app/cancel',
      }),
    ).toThrow(/STRIPE_PRICE_STARTER/);
  });
});

describe.runIf(HAS_PRICES)('P0-04 price -> plan mapping', () => {
  it('maps a configured price id to its plan (single source of truth)', () => {
    expect(planIdFromStripePrice(process.env.STRIPE_PRICE_GROWTH)).toBe('growth');
    expect(planIdFromStripePrice(process.env.STRIPE_PRICE_PRO)).toBe('pro');
  });

  it('returns null for unknown or empty price ids', () => {
    expect(planIdFromStripePrice('price_unknown_xyz')).toBeNull();
    expect(planIdFromStripePrice('')).toBeNull();
    expect(planIdFromStripePrice(undefined)).toBeNull();
  });
});

describe.runIf(HAS_STRIPE_ENV && HAS_TEST_DB)('P0-04 signed webhook fixtures (real signature verification)', () => {
  let tenantA: string;
  let tenantB: string;

  /** Builds a Stripe-shaped event, signs it with the real SDK (offline). */
  async function signedEvent(type: string, object: Record<string, unknown>) {
    const stripe = new Stripe('sk_test_dummy_no_network');
    const payload = JSON.stringify({
      id: `evt_${Date.now()}`,
      object: 'event',
      type,
      data: { object },
    });
    const sig = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: process.env.STRIPE_WEBHOOK_SECRET!,
    });
    // The REAL provider verifies the signature — proves the fixture is
    // shaped exactly like a Stripe webhook delivery.
    const evt = await getPayments().constructWebhookEvent(Buffer.from(payload), sig);
    expect(evt.type).toBe(type);
    return evt;
  }

  beforeAll(async () => {
    await runMigrations();
    const mk = async (plan: string, subId: string | null, customer: string | null) => {
      const t = await query(
        `INSERT INTO tenants (id, name, plan_id, stripe_customer_id)
         VALUES (gen_random_uuid(), 'p004', $1, $2) RETURNING id`,
        [plan, customer],
      );
      const tenantId = t.rows[0].id as string;
      if (subId) {
        await query(
          `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active')`,
          [tenantId, subId, customer, plan],
        );
      }
      return tenantId;
    };
    tenantA = await mk('starter', 'sub_test_123', 'cus_test_123');
    tenantB = await mk('pro', 'sub_test_456', 'cus_test_456');
  }, 60000);

  afterAll(async () => {
    await query('DELETE FROM tenants WHERE id = ANY($1)', [[tenantA, tenantB]]);
    await pool.end();
  });

  it('customer.subscription.updated maps plan from the Stripe price id', async () => {
    const evt = await signedEvent('customer.subscription.updated', {
      id: 'sub_test_123',
      object: 'subscription',
      status: 'active',
      metadata: {},
      items: {
        object: 'list',
        data: [{ id: 'si_1', price: { id: process.env.STRIPE_PRICE_GROWTH, object: 'price' } }],
      },
    });
    await applyPaymentEvent(evt);
    const r = await query('SELECT plan_id FROM tenants WHERE id = $1', [tenantA]);
    expect(r.rows[0].plan_id).toBe('growth');
    const s = await query('SELECT plan_id, status FROM subscriptions WHERE stripe_sub_id = $1', ['sub_test_123']);
    expect(s.rows[0].plan_id).toBe('growth');
    expect(s.rows[0].status).toBe('active');
    // Other tenants untouched (tenant scoping).
    const b = await query('SELECT plan_id FROM tenants WHERE id = $1', [tenantB]);
    expect(b.rows[0].plan_id).toBe('pro');
  });

  it('falls back to subscription metadata planId when no price items present', async () => {
    const evt = await signedEvent('customer.subscription.updated', {
      id: 'sub_test_456',
      object: 'subscription',
      status: 'active',
      metadata: { planId: 'growth' },
      items: { object: 'list', data: [] },
    });
    await applyPaymentEvent(evt);
    const r = await query('SELECT plan_id FROM tenants WHERE id = $1', [tenantB]);
    expect(r.rows[0].plan_id).toBe('growth');
  });

  it('customer.subscription.deleted restricts the tenant to starter', async () => {
    const evt = await signedEvent('customer.subscription.deleted', {
      id: 'sub_test_123',
      object: 'subscription',
      status: 'canceled',
      metadata: {},
      items: { object: 'list', data: [] },
    });
    await applyPaymentEvent(evt);
    const r = await query('SELECT plan_id FROM tenants WHERE id = $1', [tenantA]);
    expect(r.rows[0].plan_id).toBe('starter');
  });

  it('rejects a tampered payload (bad signature)', async () => {
    const stripe = new Stripe('sk_test_dummy_no_network');
    const payload = JSON.stringify({ id: 'evt_x', object: 'event', type: 'ping', data: { object: {} } });
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_wrong' });
    await expect(getPayments().constructWebhookEvent(Buffer.from(payload), sig)).rejects.toThrow();
  });

  it('the HTTP webhook route accepts a signed subscription.updated event', async () => {
    const app = await buildApp();
    await app.ready();
    try {
      // Reset tenantB to starter first so the assertion is meaningful.
      await query(`UPDATE tenants SET plan_id = 'starter' WHERE id = $1`, [tenantB]);
      const stripe = new Stripe('sk_test_dummy_no_network');
      const payload = JSON.stringify({
        id: 'evt_http_1',
        object: 'event',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_test_456',
            object: 'subscription',
            status: 'active',
            metadata: {},
            items: { object: 'list', data: [{ id: 'si_2', price: { id: process.env.STRIPE_PRICE_PRO, object: 'price' } }] },
          },
        },
      });
      const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(200);
      const r = await query('SELECT plan_id FROM tenants WHERE id = $1', [tenantB]);
      expect(r.rows[0].plan_id).toBe('pro');
    } finally {
      await app.close();
    }
  }, 60000);
});

/**
 * Security-review regression (no Stripe env needed): checkout.session.completed
 * must isPlanId-guard the plan before writing — an unsigned mock webhook (or a
 * tampered event) must not be able to escalate an arbitrary tenant.
 */
describe('P0-04 checkout plan guard', () => {
  it('writes only isPlanId-validated plans from checkout.session.completed', async () => {
    const writes: unknown[][] = [];
    const q = async (text: string, params?: unknown[]) => {
      writes.push([text, params]);
      return { rows: [], rowCount: 0 };
    };
    const evt = (planId: unknown) => ({
      type: 'checkout.session.completed',
      data: { metadata: { tenantId: 't-victim', planId }, subscription: 'sub_x' },
    });
    await applyPaymentEvent(evt('pro'), q as any);
    expect(writes.length).toBe(1);
    expect((writes[0][1] as unknown[])[3]).toBe('pro');
    writes.length = 0;
    await applyPaymentEvent(evt('enterprise'), q as any);
    expect(writes.length).toBe(0);
    await applyPaymentEvent(evt(undefined), q as any);
    expect(writes.length).toBe(0);
    await applyPaymentEvent(evt(''), q as any);
    expect(writes.length).toBe(0);
  });
});
