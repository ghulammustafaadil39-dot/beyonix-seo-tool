import crypto from 'node:crypto';
import Stripe from 'stripe';
import { config, hasStripe } from '../config.js';
import { query } from '../db.js';
import { ApiError } from '../errors.js';
import type { PaymentsProvider } from './types.js';
import { isPlanId, type PlanId } from '../plans.js';

/**
 * Single source of truth mapping a Stripe price id -> plan, derived from the
 * STRIPE_PRICE_* env config (P0-04). Returns null for unknown/empty price ids
 * so callers can fall back instead of writing garbage into tenants.plan_id.
 */
export function planIdFromStripePrice(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  for (const [plan, id] of Object.entries(config.stripePrices)) {
    if (id && id === priceId && isPlanId(plan)) return plan;
  }
  return null;
}

/**
 * Pure builder for the real Stripe checkout-session params (unit-tested).
 * P0-04: subscription_data.metadata {tenantId, planId} is what
 * customer.subscription.updated carries later — session-level metadata alone
 * never reaches the subscription object.
 */
export function buildCheckoutSessionParams(p: {
  customerId: string;
  planId: PlanId;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}) {
  const priceId = config.stripePrices[p.planId];
  if (!priceId) throw new Error(`No STRIPE_PRICE_${p.planId.toUpperCase()} configured`);
  return {
    customer: p.customerId,
    mode: 'subscription' as const,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    metadata: { planId: p.planId, ...p.metadata },
    subscription_data: { metadata: { tenantId: p.metadata?.tenantId ?? '', planId: p.planId } },
  };
}

/** Dev/test mock routes (mock-confirm) exist only outside production builds. */
export function mockBillingRoutesEnabled(nodeEnv: string = config.nodeEnv): boolean {
  return nodeEnv !== 'production';
}

const MOCK_WEBHOOK_TOLERANCE_SEC = 300;

/**
 * Signs a mock webhook payload with the local MOCK_WEBHOOK_SECRET.
 * Stripe-style header: `t=<unix>,v1=<hmac-sha256(secret, "<t>.<body>")>`.
 * Used by tests and local dev tooling; never in production.
 */
export function signMockWebhookEvent(rawBody: Buffer | string, secret: string): string {
  const t = Math.floor(Date.now() / 1000);
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body.toString('utf8')}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/**
 * Verifies a mock webhook signature (timing-safe) with replay protection.
 * Throws ApiError(401) on any mismatch, missing/expired timestamp.
 */
export function verifyMockWebhookEvent(
  rawBody: Buffer | string,
  signature: string,
  secret: string,
): { type: string; data: any } {
  const fail = (msg: string): never => {
    throw new ApiError(401, 'INVALID_WEBHOOK_SIGNATURE', `Mock webhook rejected: ${msg}`);
  };
  if (!signature) fail('missing signature');
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature.trim());
  if (!m) fail('malformed signature');
  const t = parseInt(m![1], 10);
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > MOCK_WEBHOOK_TOLERANCE_SEC) fail('stale timestamp');
  const body = (Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)).toString('utf8');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest();
  const got = Buffer.from(m![2], 'hex');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) fail('signature mismatch');
  let evt: any;
  try {
    evt = JSON.parse(body);
  } catch {
    fail('invalid JSON payload');
  }
  if (!evt.type) fail('missing event type');
  return { type: evt.type as string, data: evt.data ?? {} };
}

class RealStripeProvider implements PaymentsProvider {
  name = 'stripe';
  isMock = false;
  private stripe = new Stripe(config.stripeSecretKey);

  async createCustomer(email: string, tenantId: string) {
    const c = await this.stripe.customers.create({ email, metadata: { tenantId } });
    return { customerId: c.id };
  }

  async createCheckoutSession(p: { customerId: string; planId: PlanId; successUrl: string; cancelUrl: string; metadata?: Record<string, string> }) {
    const s = await this.stripe.checkout.sessions.create(buildCheckoutSessionParams(p));
    return { url: s.url!, sessionId: s.id };
  }

  async createPortalSession(customerId: string, returnUrl: string) {
    const s = await this.stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
    return { url: s.url };
  }

  async constructWebhookEvent(rawBody: Buffer | string, signature: string) {
    if (!config.stripeWebhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
    const evt = this.stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
    return { type: evt.type, data: evt.data.object as any };
  }
}

/**
 * Mock Stripe: keeps subscriptions in the DB with status='mock'.
 * Checkout returns a fake URL that points back to a local confirm endpoint
 * so the full subscribe flow is testable without Stripe.
 */
class MockStripeProvider implements PaymentsProvider {
  name = 'mock-stripe';
  isMock = true;

  async createCustomer(email: string, tenantId: string) {
    return { customerId: `cus_mock_${tenantId.slice(0, 8)}` };
  }

  async createCheckoutSession(p: { customerId: string; planId: PlanId; successUrl: string; cancelUrl: string }) {
    const sessionId = `cs_mock_${Date.now()}`;
    // The mock "checkout page" is our own confirm URL; visiting it with the
    // session id simulates a completed payment (dev/test only).
    const url = `${config.apiUrl}/api/v1/billing/mock-confirm?session_id=${sessionId}&plan=${p.planId}&customer=${encodeURIComponent(p.customerId)}`;
    return { url, sessionId };
  }

  async createPortalSession(_customerId: string, returnUrl: string) {
    return { url: returnUrl };
  }

  async constructWebhookEvent(rawBody: Buffer | string, signature: string) {
    // The mock webhook is a dev/test convenience. Unsigned events are never
    // accepted: callers must sign with the local MOCK_WEBHOOK_SECRET, and the
    // whole mock path is disabled in production (fail-closed).
    if (config.nodeEnv === 'production') {
      throw new ApiError(403, 'MOCK_WEBHOOK_DISABLED', 'Mock webhooks are disabled in production');
    }
    const secret = config.mockWebhookSecret;
    if (!secret) {
      throw new ApiError(
        503,
        'MOCK_WEBHOOK_NOT_CONFIGURED',
        'Set MOCK_WEBHOOK_SECRET in dev/test to accept mock webhook events',
      );
    }
    return verifyMockWebhookEvent(rawBody, signature, secret);
  }
}

/** Applies a Stripe (or mock) event to our subscriptions table. Shared by webhook route + tests. */
export async function applyPaymentEvent(
  evt: { type: string; data: any },
  q: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> = query,
): Promise<void> {
  const { type, data } = evt;
  if (type === 'checkout.session.completed') {
    let tenantId: string | undefined = data.metadata?.tenantId ?? data.tenant_id;
    const customerId: string | undefined = data.customer;
    const subId: string | undefined = data.subscription;
    if (!tenantId && customerId) {
      const t = await q(`SELECT id FROM tenants WHERE stripe_customer_id = $1`, [customerId]);
      tenantId = t.rows[0]?.id;
    }
    // Security review: never trust an unvalidated plan id — an unsigned mock
    // webhook (or a tampered event) could otherwise escalate any tenant.
    // (Lookup runs first so customerId-resolved tenants aren't skipped.)
    const rawPlanId = data.metadata?.planId ?? data.plan_id;
    if (!tenantId || !isPlanId(rawPlanId)) return;
    const planId: PlanId = rawPlanId;
    await q(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status, current_period_end)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active', now() + interval '30 days')
       ON CONFLICT (tenant_id) DO UPDATE SET
         stripe_sub_id = EXCLUDED.stripe_sub_id,
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         plan_id = EXCLUDED.plan_id, status = 'active',
         current_period_end = now() + interval '30 days'`,
      [tenantId, subId ?? `sub_mock_${Date.now()}`, customerId ?? null, planId],
    );
    await q(`UPDATE tenants SET plan_id = $2, stripe_customer_id = $3 WHERE id = $1`, [tenantId, planId, customerId ?? null]);
  } else if (type === 'customer.subscription.updated' || type === 'customer.subscription.deleted') {
    const subId: string | undefined = data.id;
    const status = type === 'customer.subscription.deleted' ? 'canceled' : (data.status ?? 'active');
    // P0-04: the plan is authoritative from the Stripe price id (single source
    // of truth = STRIPE_PRICE_*), falling back to subscription metadata, then
    // the stored plan. Unknown values never reach tenants.plan_id.
    const priceId: string | undefined = data.items?.data?.[0]?.price?.id;
    const fromPrice = planIdFromStripePrice(priceId);
    const fromMeta = data.metadata?.planId ?? data.plan_id;
    const planFromEvent = fromPrice ?? (isPlanId(fromMeta) ? fromMeta : null);
    if (!subId) return;
    const r = await q(`SELECT tenant_id, plan_id FROM subscriptions WHERE stripe_sub_id = $1`, [subId]);
    if (r.rows.length === 0) return;
    const tenantId = r.rows[0].tenant_id as string;
    const storedPlan = r.rows[0].plan_id as string | null;
    // Payment trouble -> restrict to starter until the customer pays.
    // (deleted/canceled/unpaid/past_due/incomplete_expired all lose paid limits.)
    const restricted = new Set(['canceled', 'unpaid', 'past_due', 'incomplete_expired']);
    if (restricted.has(status)) {
      await q(`UPDATE subscriptions SET status=$2 WHERE stripe_sub_id=$1`, [subId, status]);
      await q(`UPDATE tenants SET plan_id='starter' WHERE id=$1`, [tenantId]);
    } else {
      const effectivePlan = planFromEvent ?? (storedPlan && isPlanId(storedPlan) ? storedPlan : 'starter');
      await q(`UPDATE subscriptions SET status=$2, plan_id=$3 WHERE stripe_sub_id=$1`, [subId, status, effectivePlan]);
      await q(`UPDATE tenants SET plan_id=$2 WHERE id=$1`, [tenantId, effectivePlan]);
    }
  }
}

let cached: PaymentsProvider | null = null;

/**
 * Mocking billing in production would let anyone subscribe for free, so in
 * production without Stripe keys every billing operation fails closed with
 * a clear 503 instead of silently using the mock.
 */
class DisabledPaymentsProvider implements PaymentsProvider {
  name = 'disabled';
  isMock = false;
  private err(): ApiError {
    return new ApiError(
      503,
      'BILLING_NOT_CONFIGURED',
      'Billing is not configured on this server yet. Please contact support.',
    );
  }
  async createCustomer(): Promise<{ customerId: string }> {
    throw this.err();
  }
  async createCheckoutSession(): Promise<{ url: string; sessionId: string }> {
    throw this.err();
  }
  async createPortalSession(): Promise<{ url: string }> {
    throw this.err();
  }
  async constructWebhookEvent(): Promise<{ type: string; data: any }> {
    throw this.err();
  }
}

export function getPayments(): PaymentsProvider {
  if (hasStripe()) return new RealStripeProvider();
  if (config.nodeEnv === 'production') return new DisabledPaymentsProvider();
  if (!cached) {
    console.log('[provider] using MOCK stripe (no STRIPE_SECRET_KEY configured)');
    cached = new MockStripeProvider();
  }
  return cached;
}
