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
  // config.stripePrices is a snapshot at import; tests/ops may set
  // STRIPE_PRICE_* later, so consult the live env too (env wins).
  const live: Record<string, string | undefined> = {
    starter: process.env.STRIPE_PRICE_STARTER || config.stripePrices.starter,
    growth: process.env.STRIPE_PRICE_GROWTH || config.stripePrices.growth,
    pro: process.env.STRIPE_PRICE_PRO || config.stripePrices.pro,
  };
  for (const [plan, id] of Object.entries(live)) {
    if (id && id === priceId && isPlanId(plan)) return plan;
  }
  return null;
}

export type BillingInterval = 'monthly' | 'annual';

/**
 * Price id for a plan + interval (C-01). Monthly prices come from the frozen
 * STRIPE_PRICE_* config; annual prices are optional STRIPE_PRICE_*_ANNUAL
 * env vars (read here so config.ts — Security-owned — stays untouched).
 * Returns null when not configured so callers fail with an honest 400.
 */
export function priceIdForPlan(planId: PlanId, interval: BillingInterval = 'monthly'): string | null {
  if (interval === 'annual') {
    return process.env[`STRIPE_PRICE_${planId.toUpperCase()}_ANNUAL`] || null;
  }
  return config.stripePrices[planId] || null;
}

/**
 * Pure builder for the real Stripe checkout-session params (unit-tested).
 * P0-04: subscription_data.metadata {tenantId, planId} is what
 * customer.subscription.updated carries later — session-level metadata alone
 * never reaches the subscription object.
 * C-01: trialDays / couponCode / interval ride along in subscription_data so
 * the real subscription object reflects them; the mock reads them back from
 * the flattened metadata in applyPaymentEvent.
 */
export function buildCheckoutSessionParams(p: {
  customerId: string;
  planId: PlanId;
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
}) {
  const interval: BillingInterval = p.metadata?.interval === 'annual' ? 'annual' : 'monthly';
  const priceId = priceIdForPlan(p.planId, interval);
  if (!priceId) {
    throw new Error(
      interval === 'annual'
        ? `No STRIPE_PRICE_${p.planId.toUpperCase()}_ANNUAL configured`
        : `No STRIPE_PRICE_${p.planId.toUpperCase()} configured`,
    );
  }
  const trialDays = p.metadata?.trialDays ? parseInt(p.metadata.trialDays, 10) : 0;
  const couponCode = p.metadata?.couponCode;
  return {
    customer: p.customerId,
    mode: 'subscription' as const,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: p.successUrl,
    cancel_url: p.cancelUrl,
    metadata: { planId: p.planId, interval, ...p.metadata },
    subscription_data: {
      metadata: { tenantId: p.metadata?.tenantId ?? '', planId: p.planId },
      ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
      ...(couponCode ? { discounts: [{ coupon: couponCode }] } : {}),
    },
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

  async createCheckoutSession(p: { customerId: string; planId: PlanId; successUrl: string; cancelUrl: string; metadata?: Record<string, string> }) {
    const sessionId = `cs_mock_${Date.now()}`;
    // The mock "checkout page" is our own confirm URL; visiting it with the
    // session id simulates a completed payment (dev/test only). Trial,
    // coupon and interval selections ride along as query params so the mock
    // mirrors the real subscription_data.
    const md = p.metadata ?? {};
    const extra = [
      md.interval ? `&interval=${encodeURIComponent(md.interval)}` : '',
      md.trialDays ? `&trial_days=${encodeURIComponent(md.trialDays)}` : '',
      md.couponCode ? `&coupon=${encodeURIComponent(md.couponCode)}` : '',
    ].join('');
    const url = `${config.apiUrl}/api/v1/billing/mock-confirm?session_id=${sessionId}&plan=${p.planId}&customer=${encodeURIComponent(p.customerId)}${extra}`;
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

/** Stripe unix timestamp -> JS Date (null-safe). */
function fromStripeTs(ts: unknown): Date | null {
  const n = typeof ts === 'number' ? ts : typeof ts === 'string' ? parseInt(ts, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null;
}

function subObject(data: any): { id?: string; obj?: any } {
  const s = data.subscription;
  if (s && typeof s === 'object') return { id: s.id as string | undefined, obj: s };
  return { id: typeof s === 'string' ? s : undefined };
}

async function resolveTenantForSubscription(
  q: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>,
  data: any,
  /** For subscription.* events the id is data.id, not data.subscription. */
  subscriptionId?: string,
): Promise<string | null> {
  const { id: subIdFromData } = subObject(data);
  const subId = subscriptionId ?? subIdFromData;
  if (subId) {
    const r = await q(`SELECT tenant_id FROM subscriptions WHERE stripe_sub_id = $1`, [subId]);
    if (r.rows[0]?.tenant_id) return r.rows[0].tenant_id as string;
  }
  const customerId: string | undefined = data.customer;
  if (customerId) {
    const t = await q(`SELECT id FROM tenants WHERE stripe_customer_id = $1`, [customerId]);
    if (t.rows[0]?.id) return t.rows[0].id as string;
  }
  const metaTenant: string | undefined = data.metadata?.tenantId;
  return metaTenant ?? null;
}

/**
 * Applies a Stripe (or mock) event to our billing tables. Shared by the
 * webhook route + tests. C-01: idempotent via stripe_webhook_events
 * (pass eventId), all period/status/plan values come FROM Stripe, never
 * now()+30d. Returns { deduplicated } so the route can report replays.
 */
export async function applyPaymentEvent(
  evt: { type: string; data: any },
  q: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> = query,
  eventId?: string,
): Promise<{ deduplicated: boolean }> {
  const { type, data } = evt;
  // Webhook idempotency (N-A2-6): the event id is inserted BEFORE any
  // processing; a redelivery hits the conflict and becomes a no-op.
  // Direct callers (tests, mock-confirm) carry it on evt.id.
  eventId = eventId ?? (typeof (evt as any).id === 'string' ? (evt as any).id : undefined);
  if (eventId) {
    const ins = await q(
      `INSERT INTO stripe_webhook_events (event_id, event_type)
       VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, type],
    );
    if ((ins.rowCount ?? 0) === 0) return { deduplicated: true };
  }
  let tenantForLedger: string | null = null;

  if (type === 'checkout.session.completed') {
    let tenantId: string | undefined = data.metadata?.tenantId ?? data.tenant_id;
    const customerId: string | undefined = data.customer;
    const { id: subId, obj: subObj } = subObject(data);
    if (!tenantId && customerId) {
      const t = await q(`SELECT id FROM tenants WHERE stripe_customer_id = $1`, [customerId]);
      tenantId = t.rows[0]?.id;
    }
    // Security review: never trust an unvalidated plan id — an unsigned mock
    // webhook (or a tampered event) could otherwise escalate any tenant.
    // (Lookup runs first so customerId-resolved tenants aren't skipped.)
    const rawPlanId = data.metadata?.planId ?? data.plan_id;
    if (!tenantId || !isPlanId(rawPlanId)) return { deduplicated: false };
    const planId: PlanId = rawPlanId;
    tenantForLedger = tenantId;

    // C-01: period comes FROM Stripe (the subscription object when the
    // session payload expands it). Mock checkouts have no Stripe object —
    // they record a local 30-day period, clearly a mock artifact.
    const periodStart = fromStripeTs(subObj?.current_period_start) ?? new Date();
    const periodEnd = fromStripeTs(subObj?.current_period_end) ?? new Date(Date.now() + 30 * 86400_000);
    const trialDays = parseInt(data.metadata?.trialDays ?? data.metadata?.trial_days ?? '0', 10) || 0;
    const couponCode: string | undefined = data.metadata?.couponCode ?? data.metadata?.coupon;
    const interval = data.metadata?.interval === 'annual' ? 'annual' : 'monthly';
    const status = trialDays > 0 ? 'trialing' : 'active';
    const trialEndsAt = trialDays > 0 ? new Date(Date.now() + trialDays * 86400_000) : null;
    await q(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status,
                                 current_period_start, current_period_end, trial_ends_at,
                                 billing_interval, coupon_code, grace_until)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL)
       ON CONFLICT (tenant_id) DO UPDATE SET
         stripe_sub_id = EXCLUDED.stripe_sub_id,
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         plan_id = EXCLUDED.plan_id, status = EXCLUDED.status,
         current_period_start = EXCLUDED.current_period_start,
         current_period_end = EXCLUDED.current_period_end,
         trial_ends_at = EXCLUDED.trial_ends_at,
         billing_interval = EXCLUDED.billing_interval,
         coupon_code = EXCLUDED.coupon_code, grace_until = NULL`,
      [tenantId, subId ?? `sub_mock_${Date.now()}`, customerId ?? null, planId, status, periodStart, periodEnd, trialEndsAt, interval, couponCode ?? null],
    );
    await q(`UPDATE tenants SET plan_id = $2, stripe_customer_id = $3, read_only = FALSE WHERE id = $1`, [tenantId, planId, customerId ?? null]);
    if (couponCode) {
      await q(`UPDATE billing_coupons SET redeemed_count = redeemed_count + 1 WHERE code = $1`, [couponCode]);
    }
    const { emitBillingEvent } = await import('../services/billing.js');
    await emitBillingEvent({
      type: trialDays > 0 ? 'trial.started' : 'checkout.completed',
      tenantId,
      detail: { planId, interval },
    });
  } else if (type === 'customer.subscription.created' || type === 'customer.subscription.updated') {
    const subId: string | undefined = data.id;
    if (!subId) return { deduplicated: false };
    const status: string = data.status ?? 'active';
    // P0-04: the plan is authoritative from the Stripe price id (single source
    // of truth = STRIPE_PRICE_*), falling back to subscription metadata, then
    // the stored plan. Unknown values never reach tenants.plan_id.
    const priceId: string | undefined = data.items?.data?.[0]?.price?.id;
    const fromPrice = planIdFromStripePrice(priceId);
    const fromMeta = data.metadata?.planId ?? data.plan_id;
    const planFromEvent = fromPrice ?? (isPlanId(fromMeta) ? fromMeta : null);
    const tenantId = await resolveTenantForSubscription(q, data, subId);
    if (!tenantId) return { deduplicated: false };
    tenantForLedger = tenantId;

    const r = await q(`SELECT plan_id FROM subscriptions WHERE stripe_sub_id = $1`, [subId]);
    const storedPlan = r.rows[0]?.plan_id as string | null | undefined;
    const periodStart = fromStripeTs(data.current_period_start);
    const periodEnd = fromStripeTs(data.current_period_end);
    const trialEndsAt = fromStripeTs(data.trial_end);
    const cancelAtPeriodEnd = data.cancel_at_period_end === true;
    const { emitBillingEvent, graceDeadline, downgradeTenant } = await import('../services/billing.js');

    if (status === 'past_due' || status === 'unpaid') {
      // C-01: payment trouble -> grace period, NOT an instant downgrade.
      // The tenant keeps paid limits until grace_until; processBillingGrace()
      // (daily scheduler job) downgrades afterwards.
      const cur = await q(`SELECT grace_until FROM subscriptions WHERE stripe_sub_id = $1`, [subId]);
      const existingGrace = cur.rows[0]?.grace_until as string | null | undefined;
      const graceUntil = existingGrace ? new Date(existingGrace) : graceDeadline();
      const pastDuePlan = planFromEvent ?? storedPlan ?? 'starter';
      await q(
        `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, plan_id, status,
                                   current_period_start, current_period_end, grace_until)
         VALUES (gen_random_uuid(), $1, $2, $3, 'past_due', $4, $5, $6)
         ON CONFLICT (tenant_id) DO UPDATE SET
           stripe_sub_id = EXCLUDED.stripe_sub_id, status = 'past_due',
           current_period_start = COALESCE(EXCLUDED.current_period_start, subscriptions.current_period_start),
           current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
           grace_until = COALESCE(subscriptions.grace_until, EXCLUDED.grace_until)`,
        [tenantId, subId, pastDuePlan, periodStart, periodEnd, graceUntil],
      );
      await emitBillingEvent({ type: 'subscription.past_due', tenantId, detail: { status, graceUntil } });
    } else if (status === 'canceled' || status === 'incomplete_expired') {
      // Ended subscription -> downgrade now (data kept; read-only if over
      // the starter limits — never deleted).
      await downgradeTenant(tenantId, `subscription_${status}`);
      await emitBillingEvent({ type: 'subscription.deleted', tenantId, detail: { status } });
    } else {
      const effectivePlan = planFromEvent ?? (storedPlan && isPlanId(storedPlan) ? storedPlan : 'starter');
      await q(
        `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, plan_id, status,
                                   current_period_start, current_period_end,
                                   trial_ends_at, cancel_at_period_end, grace_until)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NULL)
         ON CONFLICT (tenant_id) DO UPDATE SET
           stripe_sub_id = EXCLUDED.stripe_sub_id, status = EXCLUDED.status,
           plan_id = EXCLUDED.plan_id,
           current_period_start = COALESCE(EXCLUDED.current_period_start, subscriptions.current_period_start),
           current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
           trial_ends_at = COALESCE(EXCLUDED.trial_ends_at, subscriptions.trial_ends_at),
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           grace_until = NULL`,
        [tenantId, subId, effectivePlan, status, periodStart, periodEnd, trialEndsAt, cancelAtPeriodEnd],
      );
      // Clear read-only when the (re)activated plan covers current usage.
      const { getPlan } = await import('../plans.js');
      const p = getPlan(effectivePlan);
      const sites = Number(
        (await q('SELECT COUNT(*)::int c FROM sites WHERE tenant_id=$1 AND deleted_at IS NULL', [tenantId])).rows[0].c,
      );
      const kws = Number(
        (await q('SELECT COUNT(*)::int c FROM keywords WHERE tenant_id=$1 AND tracked=TRUE', [tenantId])).rows[0].c,
      );
      const overLimit = sites > p.max_sites || kws > p.max_keywords_tracked;
      await q(`UPDATE tenants SET plan_id = $2, read_only = $3 WHERE id = $1`, [tenantId, effectivePlan, overLimit]);
    }
  } else if (type === 'customer.subscription.deleted') {
    const subId: string | undefined = data.id;
    if (!subId) return { deduplicated: false };
    const tenantId = await resolveTenantForSubscription(q, data, subId);
    if (!tenantId) return { deduplicated: false };
    tenantForLedger = tenantId;
    const { downgradeTenant, emitBillingEvent } = await import('../services/billing.js');
    await downgradeTenant(tenantId, 'subscription_deleted');
    await emitBillingEvent({ type: 'subscription.deleted', tenantId });
  } else if (type === 'invoice.paid' || type === 'invoice.payment_failed') {
    const invoiceId: string | undefined = data.id;
    const tenantId = await resolveTenantForSubscription(q, data);
    if (!tenantId || !invoiceId) return { deduplicated: false };
    tenantForLedger = tenantId;
    const paid = type === 'invoice.paid';
    const amount = Number(data.amount_due ?? data.amount_paid ?? 0);
    await q(
      `INSERT INTO invoices (id, tenant_id, stripe_invoice_id, stripe_customer_id,
                             amount_due_cents, currency, status,
                             period_start, period_end, hosted_invoice_url)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (stripe_invoice_id) DO UPDATE SET
         status = EXCLUDED.status, amount_due_cents = EXCLUDED.amount_due_cents,
         period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
         hosted_invoice_url = EXCLUDED.hosted_invoice_url`,
      [
        tenantId, invoiceId, data.customer ?? null, Math.round(amount),
        (data.currency as string | undefined) ?? 'usd', paid ? 'paid' : 'failed',
        fromStripeTs(data.period_start), fromStripeTs(data.period_end),
        (data.hosted_invoice_url as string | undefined) ?? null,
      ],
    );
    const { emitBillingEvent, graceDeadline } = await import('../services/billing.js');
    if (paid) {
      // Recovery: a paid invoice clears past_due + grace.
      await q(
        `UPDATE subscriptions SET status = 'active', grace_until = NULL
         WHERE tenant_id = $1 AND status = 'past_due'`,
        [tenantId],
      );
      await emitBillingEvent({ type: 'invoice.paid', tenantId, detail: { invoiceId, amount } });
    } else {
      const cur = await q(`SELECT grace_until FROM subscriptions WHERE tenant_id = $1`, [tenantId]);
      const existingGrace = cur.rows[0]?.grace_until as string | null | undefined;
      if (!existingGrace) {
        await q(`UPDATE subscriptions SET status = 'past_due', grace_until = $2 WHERE tenant_id = $1`, [
          tenantId,
          graceDeadline(),
        ]);
      } else {
        await q(`UPDATE subscriptions SET status = 'past_due' WHERE tenant_id = $1`, [tenantId]);
      }
      await emitBillingEvent({ type: 'invoice.payment_failed', tenantId, detail: { invoiceId, amount } });
    }
  } else if (type === 'charge.refunded') {
    const invoiceId: string | undefined =
      (typeof data.invoice === 'string' ? data.invoice : data.invoice?.id) ?? data.metadata?.invoiceId;
    const tenantId: string | null =
      (data.metadata?.tenantId as string | undefined) ?? (await resolveTenantForSubscription(q, data));
    if (!tenantId) return { deduplicated: false };
    tenantForLedger = tenantId;
    const amount = Math.round(Number(data.amount_refunded ?? data.amount ?? 0));
    if (invoiceId) {
      await q(`UPDATE invoices SET status = 'refunded' WHERE stripe_invoice_id = $1 AND tenant_id = $2`, [
        invoiceId,
        tenantId,
      ]);
    }
    // Credit note helper (F-14): the refund is recorded as a tenant credit
    // so support can reconcile it against future invoices.
    await q(
      `INSERT INTO tenant_credits (id, tenant_id, amount_cents, reason)
       VALUES (gen_random_uuid(), $1, $2, $3)`,
      [tenantId, amount, `Refund ${data.id ?? ''}${invoiceId ? ` for invoice ${invoiceId}` : ''}`.trim()],
    );
    const { emitBillingEvent } = await import('../services/billing.js');
    await emitBillingEvent({ type: 'charge.refunded', tenantId, detail: { amount, invoiceId } });
  } else {
    console.warn(`[billing] unhandled webhook event type: ${type}`);
  }

  if (eventId) {
    await q(`UPDATE stripe_webhook_events SET processed_at = now(), tenant_id = $2 WHERE event_id = $1`, [
      eventId,
      tenantForLedger,
    ]);
  }
  return { deduplicated: false };
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
