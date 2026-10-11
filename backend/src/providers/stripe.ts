import crypto from 'node:crypto';
import Stripe from 'stripe';
import { config, hasStripe } from '../config.js';
import { query } from '../db.js';
import { ApiError } from '../errors.js';
import type { PaymentsProvider } from './types.js';
import { isPlanId, type PlanId } from '../plans.js';
// F2-L-4: static import is cycle-safe (services/billing.ts only depends on
// db/notify/plans — it never imports this provider module).
import { LIVE_SUBSCRIPTION_STATUSES, TERMINAL_SUBSCRIPTION_STATUSES } from '../services/billing.js';

/**
 * Single source of truth mapping a Stripe price id -> plan, derived from the
 * STRIPE_PRICE_* env config (P0-04). Returns null for unknown/empty price ids
 * so callers can fall back instead of writing garbage into tenants.plan_id.
 */
export function planIdFromStripePrice(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  // config.stripePrices is a snapshot at import; tests/ops may set
  // STRIPE_PRICE_* later, so consult the live env too (env wins).
  // B1-6: annual prices included — without them, annual subscribers'
  // plan resolution depended entirely on the subscription metadata
  // fallback, breaking the "price id is the single source of truth" claim
  // for dashboard-created subscriptions without metadata.
  const live: Record<string, string | undefined> = {
    starter: process.env.STRIPE_PRICE_STARTER || config.stripePrices.starter,
    growth: process.env.STRIPE_PRICE_GROWTH || config.stripePrices.growth,
    pro: process.env.STRIPE_PRICE_PRO || config.stripePrices.pro,
    starter_annual: process.env.STRIPE_PRICE_STARTER_ANNUAL,
    growth_annual: process.env.STRIPE_PRICE_GROWTH_ANNUAL,
    pro_annual: process.env.STRIPE_PRICE_PRO_ANNUAL,
  };
  for (const [key, id] of Object.entries(live)) {
    if (id && id === priceId) {
      const plan = key.replace(/_annual$/, '');
      if (isPlanId(plan)) return plan;
    }
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
  // A2-L5: discounts reference the RESOLVED Stripe coupon id
  // (metadata.stripeCouponId), never the raw local code.
  const stripeCouponId = p.metadata?.stripeCouponId;
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
      ...(stripeCouponId ? { discounts: [{ coupon: stripeCouponId }] } : {}),
    },
  };
}

/** Dev/test mock routes (mock-confirm) exist only outside production builds. */
export function mockBillingRoutesEnabled(nodeEnv: string = config.nodeEnv): boolean {
  return nodeEnv !== 'production';
}

/**
 * C5-M-6 / C1-L-3: collision-free Stripe coupon id for a local code.
 * The sanitized code alone collides (`SAVE-20` vs `SAVE_20` vs `SAVE20`
 * all map to `bseo_SAVE20`), so a sha256 hash suffix of the RAW code is
 * appended — distinct local codes always map to distinct Stripe ids.
 * Pure and unit-tested.
 */
export function stripeCouponIdFor(code: string): string {
  const upper = code.toUpperCase();
  const sanitized = upper.replace(/[^A-Z0-9]/g, '');
  const hash = crypto.createHash('sha256').update(upper).digest('hex').slice(0, 8);
  return `bseo_${sanitized}_${hash}`;
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
  // BUG-QA-W2-2: mirror the real provider's envelope. Real Stripe events
  // (and the RealStripeProvider) carry the Stripe object at
  // `data.object` and constructWebhookEvent returns THAT object as
  // `data`. A genuine Stripe-shaped payload posted to the mock path was
  // previously returned as `{type, data: evt.data}`, so applyPaymentEvent
  // saw the envelope (no metadata/customer at top level) and silently
  // ignored the event with HTTP 200. Unwrap when `data.object` is an
  // object; when it is absent — or is the string object-tag of the
  // direct convention (`data: {id, object: 'checkout.session', ...}`
  // used by existing tests) — keep `data` as-is.
  const rawData = evt.data ?? {};
  const inner =
    rawData && typeof rawData === 'object' ? (rawData as any).object : undefined;
  const data =
    inner && typeof inner === 'object' ? inner : rawData;
  return { type: evt.type as string, data };
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

  /**
   * A2-L5: creates the Stripe coupon for a local coupon definition.
   * The Stripe coupon id is namespaced (bseo_<CODE>_<hash>) so a local
   * code is never passed to Stripe as-is (C5-M-6: the hash suffix makes
   * the namespace collision-free); creation is idempotent — a second call
   * with the same code returns the existing coupon.
   */
  async ensureCoupon(def: { code: string; percentOff?: number | null; amountOffCents?: number | null; duration: string }): Promise<string> {
    const stripeId = stripeCouponIdFor(def.code);
    try {
      const existing = await this.stripe.coupons.retrieve(stripeId);
      if (!existing.deleted) return existing.id;
    } catch {
      /* not found — create below */
    }
    const duration = def.duration === 'repeating' || def.duration === 'forever' ? def.duration : 'once';
    const params: { id: string; duration: 'once' | 'repeating' | 'forever'; percent_off?: number; amount_off?: number; duration_in_months?: number } = { id: stripeId, duration };
    if (def.percentOff != null) params.percent_off = def.percentOff;
    else if (def.amountOffCents != null) params.amount_off = def.amountOffCents;
    else throw new Error(`coupon ${def.code}: needs percent_off or amount_off_cents`);
    if (duration === 'repeating') params.duration_in_months = 12;
    const created = await this.stripe.coupons.create(params);
    return created.id;
  }

  async constructWebhookEvent(rawBody: Buffer | string, signature: string) {
    if (!config.stripeWebhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
    const evt = this.stripe.webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
    return { type: evt.type, data: evt.data.object as any };
  }

  /**
   * C1-H-1: cancels every active subscription for the Stripe customer,
   * immediately. Called by the account-delete / GDPR-erase flows BEFORE
   * any tenant rows are removed, so a deleted account can never keep
   * billing. Returns the canceled subscription ids.
   */
  async cancelSubscription(customerId: string): Promise<{ canceled: string[] }> {
    const canceled: string[] = [];
    const subs = await this.stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    for (const s of subs.data) {
      if (['active', 'trialing', 'past_due', 'incomplete'].includes(s.status)) {
        const c = await this.stripe.subscriptions.cancel(s.id);
        canceled.push(c.id);
      }
    }
    return { canceled };
  }

  /**
   * D5-L-2: pauses billing for every active subscription of the customer via
   * Stripe pause_collection (behavior mark_uncollectible: no invoices while
   * paused, the subscription itself stays alive and resumes cleanly).
   * Reversible via resumeSubscription — used by admin suspend/unsuspend.
   */
  async pauseSubscription(customerId: string): Promise<{ paused: string[] }> {
    const paused: string[] = [];
    const subs = await this.stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    for (const s of subs.data) {
      if (['active', 'trialing', 'past_due', 'incomplete'].includes(s.status) && !s.pause_collection) {
        await this.stripe.subscriptions.update(s.id, { pause_collection: { behavior: 'mark_uncollectible' } });
        paused.push(s.id);
      }
    }
    return { paused };
  }

  /**
   * D5-L-2: clears pause_collection on subscriptions paused via
   * pauseSubscription.
   */
  async resumeSubscription(customerId: string): Promise<{ resumed: string[] }> {
    const resumed: string[] = [];
    const subs = await this.stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 100 });
    for (const s of subs.data) {
      if (s.pause_collection) {
        await this.stripe.subscriptions.update(s.id, { pause_collection: null as unknown as undefined });
        resumed.push(s.id);
      }
    }
    return { resumed };
  }
}

/**
 * Mock Stripe: keeps subscriptions in the DB with status='mock'.
 * Checkout returns a fake URL that points back to a local confirm endpoint
 * so the full subscribe flow is testable without Stripe.
 */
/** D5-L-2 (mock): remembers pre-pause statuses for pauseSubscription. */
const mockPausedStatus = new Map<string, string>();

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

  /**
   * A2-L5: mock mode has no Stripe — the local code passes through
   * verbatim (no sanitization, so unlike the real bseo_ namespace it
   * never had the C5-M-6 collision; the format is pinned by
   * w4-low.test.ts).
   */
  async ensureCoupon(def: { code: string }): Promise<string> {
    return `mock_${def.code.toUpperCase()}`;
  }

  /**
   * C1-H-1 (mock): the mock keeps subscriptions in the DB — cancel means
   * flipping every billable local subscription row to 'canceled'.
   */
  async cancelSubscription(customerId: string): Promise<{ canceled: string[] }> {
    const r = await query(
      `UPDATE subscriptions SET status = 'canceled', cancel_at_period_end = false, grace_until = NULL
       WHERE stripe_customer_id = $1 AND status IN ('active', 'trialing', 'past_due', 'incomplete')
       RETURNING stripe_sub_id`,
      [customerId],
    );
    return { canceled: r.rows.map((x: any) => (x.stripe_sub_id as string) ?? 'mock') };
  }

  /**
   * D5-L-2 (mock): pause flips billable rows to status 'paused' and remembers
   * the pre-pause status in memory; resume restores it. Dev/test only.
   */
  async pauseSubscription(customerId: string): Promise<{ paused: string[] }> {
    const r = await query(
      `UPDATE subscriptions SET status = 'paused'
       WHERE stripe_customer_id = $1 AND status IN ('active', 'trialing', 'past_due', 'incomplete')
       RETURNING stripe_sub_id, status`,
      [customerId],
    );
    const paused: string[] = [];
    for (const row of r.rows) {
      const subId = (row.stripe_sub_id as string) ?? 'mock';
      mockPausedStatus.set(`${customerId}:${subId}`, 'active');
      paused.push(subId);
    }
    return { paused };
  }

  async resumeSubscription(customerId: string): Promise<{ resumed: string[] }> {
    const r = await query(
      `UPDATE subscriptions SET status = 'active'
       WHERE stripe_customer_id = $1 AND status = 'paused'
       RETURNING stripe_sub_id`,
      [customerId],
    );
    const resumed = r.rows.map((x: any) => (x.stripe_sub_id as string) ?? 'mock');
    for (const subId of resumed) mockPausedStatus.delete(`${customerId}:${subId}`);
    return { resumed };
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
    // verifyMockWebhookEvent unwraps the real Stripe envelope
    // (`data.object`) to match RealStripeProvider (BUG-QA-W2-2).
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
  evt: { type: string; data: any; created?: number | string },
  q: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> = query,
  eventId?: string,
): Promise<{ deduplicated: boolean; stale?: boolean }> {
  const { type, data } = evt;
  // C-01 ordering guard: Stripe's top-level `created` (unix seconds). The
  // webhook route threads it through from the raw payload (the frozen
  // provider interface's constructWebhookEvent drops it).
  const eventAt = fromStripeTs((evt as any).created);
  // Webhook idempotency (N-A2-6): the event id is inserted BEFORE any
  // processing; a redelivery hits the conflict and becomes a no-op.
  // Direct callers (tests, mock-confirm) carry it on evt.id.
  eventId = eventId ?? (typeof (evt as any).id === 'string' ? (evt as any).id : undefined);
  let tenantForLedger: string | null = null;
  // B2-L7: the webhook ledger's processed_at must be stamped on EVERY exit
  // path (early returns included) — otherwise handled events show as
  // perpetually unprocessed. tenantForLedger is read at call time.
  const markProcessed = (): Promise<unknown> =>
    eventId
      ? q(`UPDATE stripe_webhook_events SET processed_at = now(), tenant_id = $2 WHERE event_id = $1`, [
          eventId,
          tenantForLedger,
        ])
      : Promise.resolve();
  if (eventId) {
    const ins = await q(
      `INSERT INTO stripe_webhook_events (event_id, event_type)
       VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING`,
      [eventId, type],
    );
    if ((ins.rowCount ?? 0) === 0) {
      // E4-M-2: if the existing row was never marked processed (previous
      // attempt crashed), reprocess instead of swallowing as duplicate.
      // F2-L-1: a concurrent duplicate (insert-race loser) also lands here.
      // Reprocessing is safe because every non-idempotent handler below is
      // guarded by an event-id idempotency key (coupon_redemptions for
      // coupons, tenant_credits.webhook_event_id for refund credits), so a
      // reprocessed duplicate cannot double-apply money effects.
      const prev = await q(`SELECT processed_at FROM stripe_webhook_events WHERE event_id = $1`, [eventId]);
      if (prev.rows[0]?.processed_at) {
        await markProcessed(); // redelivery of an already-handled event
        return { deduplicated: true };
      }
      // Fall through to reprocess the crashed event.
    }
  }

  // Ordering guard (C-01 fix): an event OLDER than the newest event already
  // applied to this subscription must not overwrite newer state (e.g. a
  // late-delivered "updated(active)" resurrecting a canceled subscription).
  // Stale events are still recorded in the ledger above and marked
  // processed below — they are deduplicated work, not errors.
  // charge.refunded does not mutate subscription state, so it is exempt.
  if (eventAt && type !== 'charge.refunded') {
    let preTenant: string | null = null;
    if (type === 'checkout.session.completed') {
      preTenant =
        (data.metadata?.tenantId as string | undefined) ??
        (await resolveTenantForSubscription(q, data).catch(() => null));
    } else if (
      type === 'customer.subscription.created' ||
      type === 'customer.subscription.updated' ||
      type === 'customer.subscription.deleted'
    ) {
      preTenant = await resolveTenantForSubscription(q, data, data.id as string | undefined).catch(
        () => null,
      );
    } else if (type === 'invoice.paid' || type === 'invoice.payment_failed') {
      preTenant = await resolveTenantForSubscription(q, data).catch(() => null);
    }
    if (preTenant) {
      const cur = await q(`SELECT last_event_at FROM subscriptions WHERE tenant_id = $1`, [preTenant]);
      const last = cur.rows[0]?.last_event_at as string | Date | null | undefined;
      if (last && new Date(last).getTime() > eventAt.getTime()) {
        if (eventId) {
          await q(
            `UPDATE stripe_webhook_events SET processed_at = now(), tenant_id = $2 WHERE event_id = $1`,
            [eventId, preTenant],
          );
        }
        return { deduplicated: false, stale: true };
      }
    }
  }

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
    if (!tenantId || !isPlanId(rawPlanId)) {
      await markProcessed();
      return { deduplicated: false };
    }
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
    // G5-M#1: three cases.
    // (a) Mock path — data.subscription is ABSENT entirely (no sub id):
    //     keep the old behavior (treated as paid).
    // (b) Expanded subscription object: use its real status (C5-L-2).
    // (c) Real Stripe path — data.subscription is a plain STRING id
    //     (Stripe never expands it in checkout.session.completed): the
    //     true status is UNKNOWN, so FAIL CLOSED to 'incomplete' — no paid
    //     limits, no tenant plan activation (the if (!incomplete) guard
    //     below handles it). The customer.subscription.created/updated
    //     events carry the full object and flip the row to
    //     active/trialing within seconds. (The old code read
    //     subObj?.status — always undefined on the real path — recorded
    //     'active', and the ON CONFLICT upsert below CLOBBERED a correct
    //     'incomplete' row written by the earlier
    //     customer.subscription.created event, wiping grace_until: up to
    //     ~23h of free Pro-limit spend for a never-payer.)
    const subStatus: string | undefined = subObj?.status;
    let status: string;
    if (!subId) {
      status = trialDays > 0 ? 'trialing' : 'active'; // (a) mock path
    } else if (subObj) {
      // (b) expanded object — use its status
      const inc = subStatus === 'incomplete' || subStatus === 'incomplete_expired';
      status = trialDays > 0 ? 'trialing' : inc ? (subStatus ?? 'incomplete') : 'active';
    } else {
      status = 'incomplete'; // (c) unexpanded string id → fail closed
    }
    const incomplete = status === 'incomplete' || status === 'incomplete_expired';
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
         coupon_code = EXCLUDED.coupon_code,
         -- G5-M#1: a fail-closed 'incomplete' write must not wipe a grace
         -- minted by the earlier customer.subscription.created(incomplete)
         -- event — otherwise the next invoice.payment_failed sees
         -- grace_until IS NULL and mints a fresh grace while flipping the
         -- row to billable 'past_due', re-opening the free-spend hole.
         grace_until = CASE
           WHEN EXCLUDED.status IN ('incomplete', 'incomplete_expired')
           THEN subscriptions.grace_until
           ELSE NULL
         END`,
      [tenantId, subId ?? `sub_mock_${Date.now()}`, customerId ?? null, planId, status, periodStart, periodEnd, trialEndsAt, interval, couponCode ?? null],
    );
    // C5-L-2: an incomplete subscription must NOT activate the paid plan —
    // the tenant keeps its current plan until Stripe confirms payment.
    if (!incomplete) {
      await q(`UPDATE tenants SET plan_id = $2, stripe_customer_id = $3, read_only = FALSE WHERE id = $1`, [tenantId, planId, customerId ?? null]);
    } else {
      await q(`UPDATE tenants SET stripe_customer_id = $2 WHERE id = $1`, [tenantId, customerId ?? null]);
    }
    if (couponCode) {
      // C5-H-1 / C1-M-6: the checkout reserved a slot (reserved_count+1
      // under a row lock, cap-checked) BEFORE the Stripe discount was
      // attached; completion converts reserved → redeemed atomically. The
      // AND active predicate (C5-L-3) stops coupons deactivated mid-flight
      // from redeeming (the Stripe-side discount attached at session
      // creation cannot be revoked locally — documented limitation).
      // F1-L-2: make the redeem idempotent on the webhook event id. The
      // E4-M-2 fix reprocesses crashed events (ledger row exists but
      // processed_at IS NULL); the coupon increment is the one
      // non-idempotent handler path (the subscription upsert above is
      // ON CONFLICT-idempotent), so a crash between the increment and
      // markProcessed used to double-count redeemed_count and
      // double-release the reserved slot. The guard insert is atomic
      // (ON CONFLICT DO NOTHING on coupon_redemptions.event_id): the first
      // attempt records the event id and redeems; a crash-retry (or a
      // concurrent duplicate delivery) sees the conflict and skips.
      // Accepted residual trade-off: a crash BETWEEN the guard insert and
      // the UPDATE below leaks one reserved slot instead of
      // double-counting — a far narrower window than the reprocess one,
      // and the same class of leak the D5-L-1 release path already
      // handles. Without an eventId (direct callers) there is no guard —
      // behavior unchanged.
      const upperCoupon = couponCode.toUpperCase();
      let redeemSkipped = false;
      if (eventId) {
        const guard = await q(
          `INSERT INTO coupon_redemptions (event_id, tenant_id, coupon_code)
           VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING`,
          [eventId, tenantId, upperCoupon],
        );
        redeemSkipped = (guard.rowCount ?? 0) === 0;
      }
      if (!redeemSkipped) {
        const red = await q(
          `UPDATE billing_coupons
           SET redeemed_count = redeemed_count + 1,
               reserved_count = GREATEST(reserved_count - 1, 0)
           WHERE code = $1 AND active
             AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)`,
          [upperCoupon],
        );
        if ((red.rowCount ?? 0) === 0) {
          console.warn(`[billing] coupon ${couponCode} not redeemed: exhausted, inactive, or unknown at completion`);
          // D5-L-1: the reserved hold must be released even when the redeem
          // predicate fails (e.g. admin deactivated the coupon mid-flight) —
          // otherwise the slot leaks against max_redemptions forever.
          await q(
            `UPDATE billing_coupons SET reserved_count = GREATEST(reserved_count - 1, 0) WHERE code = $1`,
            [upperCoupon],
          );
        }
      }
    }
    const { emitBillingEvent } = await import('../services/billing.js');
    await emitBillingEvent({
      type: trialDays > 0 ? 'trial.started' : 'checkout.completed',
      tenantId,
      detail: { planId, interval },
      eventId,
    });
  } else if (type === 'checkout.session.expired') {
    // C5-H-1: an abandoned checkout releases its reserved coupon slot so
    // the cap isn't permanently burned by sessions that never paid.
    const couponCode: string | undefined =
      data.metadata?.couponCode ?? data.metadata?.coupon;
    if (couponCode) {
      await q(
        `UPDATE billing_coupons SET reserved_count = GREATEST(reserved_count - 1, 0)
         WHERE code = $1`,
        [couponCode.toUpperCase()],
      );
    }
    await markProcessed();
    return { deduplicated: false };
  } else if (type === 'customer.subscription.created' || type === 'customer.subscription.updated') {
    const subId: string | undefined = data.id;
    if (!subId) {
      await markProcessed();
      return { deduplicated: false };
    }
    const status: string = data.status ?? 'active';
    // P0-04: the plan is authoritative from the Stripe price id (single source
    // of truth = STRIPE_PRICE_*), falling back to subscription metadata, then
    // the stored plan. Unknown values never reach tenants.plan_id.
    const priceId: string | undefined = data.items?.data?.[0]?.price?.id;
    const fromPrice = planIdFromStripePrice(priceId);
    const fromMeta = data.metadata?.planId ?? data.plan_id;
    const planFromEvent = fromPrice ?? (isPlanId(fromMeta) ? fromMeta : null);
    const tenantId = await resolveTenantForSubscription(q, data, subId);
    if (!tenantId) {
      await markProcessed();
      return { deduplicated: false };
    }
    tenantForLedger = tenantId;

    // E4-H-2: never let a stale subscription's events clobber the current
    // subscription's row. If the tenant already tracks a DIFFERENT
    // subscription id, this event belongs to a superseded subscription —
    // log and skip (the D1-H-1 incomplete/past_due double-subscription
    // scenario).
    // F2-L-4: ...unless it is a REPLACEMENT subscription created
    // out-of-band. A live-subscription event (created / updated with a
    // live status) for a NEW sub id while the tracked row is TERMINAL
    // (canceled / incomplete_expired) means support created the
    // replacement in the Stripe dashboard / API — no
    // checkout.session.completed will ever adopt it. Adopt the new sub id
    // by falling through to the upsert below instead of warn-and-ignore;
    // otherwise the payer stays canceled locally and 402s forever with
    // only a console.warn as the trace. The supersede guard still
    // protects the reverse case: a tracked LIVE row means any event for
    // a different sub id is stale (e.g. a late incomplete_expired for a
    // superseded sub) and is ignored. The C-01 ordering guard above adds
    // a second layer: an event older than the newest applied event is
    // dropped before this check.
    const cur = await q(`SELECT stripe_sub_id, status FROM subscriptions WHERE tenant_id = $1`, [tenantId]);
    const storedSubId = cur.rows[0]?.stripe_sub_id as string | null | undefined;
    const storedStatus = cur.rows[0]?.status as string | null | undefined;
    if (storedSubId && storedSubId !== subId) {
      // Adopt only when the incoming subscription is NEWER: tracked row
      // TERMINAL (canceled / incomplete_expired) and the incoming event
      // carries a LIVE subscription. Every other mismatch stays on the
      // E4-H-2 warn-and-ignore path — notably a tracked LIVE row (a late
      // event for a superseded sub must never clobber it) and a tracked
      // terminal row with an incoming non-live event (nothing to adopt).
      const storedTerminal = !!storedStatus && TERMINAL_SUBSCRIPTION_STATUSES.includes(storedStatus);
      const incomingLive = LIVE_SUBSCRIPTION_STATUSES.includes(status);
      if (!storedTerminal || !incomingLive) {
        console.warn(
          `[billing] ignoring ${type} for superseded subscription ${subId} (tenant ${tenantId} tracks ${storedSubId})`,
        );
        await markProcessed();
        return { deduplicated: false };
      }
      console.log(
        `[billing] adopting out-of-band subscription ${subId} for tenant ${tenantId} ` +
          `(tracked ${storedSubId} was ${storedStatus}) — fall through to upsert`,
      );
      // Fall through: the upsert below replaces stripe_sub_id + status.
    }

    // C5-M-2: a price id Stripe sent but we cannot map must NEVER silently
    // land a payer on Starter (portal upgrades carry no metadata planId, so
    // the old fallback chain ended at 'starter' while Stripe billed the
    // higher price). Fail loudly — 502 → Stripe retries the event — so ops
    // notices the missing STRIPE_PRICE_* mapping. Canceled/expired
    // subscriptions downgrade legitimately and don't need the price.
    if (priceId && !fromPrice && status !== 'canceled' && status !== 'incomplete_expired') {
      console.error(
        `[billing] UNRESOLVED_STRIPE_PRICE: price ${priceId} on subscription ${subId} ` +
          `for tenant ${tenantId} maps to no plan — refusing to write plan state (C5-M-2)`,
      );
      // D5-M-1: do NOT leave the idempotency-ledger row behind. A retained
      // unprocessed row turns every Stripe retry into a permanent
      // deduplicated no-op (the tenant would be billed the higher price
      // while stuck on the old plan forever). Deleting the row lets the
      // retry re-insert and reprocess once ops configures the price.
      if (eventId) {
        await q(`DELETE FROM stripe_webhook_events WHERE event_id = $1`, [eventId]);
      }
      throw new ApiError(
        502,
        'PRICE_NOT_CONFIGURED',
        `Stripe price ${priceId} is not mapped to a plan (missing STRIPE_PRICE_* env). ` +
          'No plan change was applied; configure the price mapping and the event will be retried.',
      );
    }

    // F2-L-4: look up the tracked plan by tenant, not by the incoming sub
    // id — after an out-of-band adoption the new sub id has no row yet,
    // and the tenant's last known plan is the right fallback.
    const r = await q(`SELECT plan_id FROM subscriptions WHERE tenant_id = $1`, [tenantId]);
    const storedPlan = r.rows[0]?.plan_id as string | null | undefined;
    const periodStart = fromStripeTs(data.current_period_start);
    const periodEnd = fromStripeTs(data.current_period_end);
    const trialEndsAt = fromStripeTs(data.trial_end);
    const cancelAtPeriodEnd = data.cancel_at_period_end === true;
    const { emitBillingEvent, graceDeadline, downgradeTenant } = await import('../services/billing.js');

    // C5-L-2: 'incomplete' (first payment failed/unconfirmed) is payment
    // trouble like past_due — grace, not full activation.
    if (status === 'past_due' || status === 'unpaid' || status === 'incomplete') {
      // C-01: payment trouble -> grace period, NOT an instant downgrade.
      // The tenant keeps paid limits until grace_until; processBillingGrace()
      // (daily scheduler job) downgrades afterwards.
      const cur = await q(`SELECT grace_until FROM subscriptions WHERE stripe_sub_id = $1`, [subId]);
      const existingGrace = cur.rows[0]?.grace_until as string | null | undefined;
      const graceUntil = existingGrace ? new Date(existingGrace) : graceDeadline();
      const pastDuePlan = planFromEvent ?? storedPlan ?? 'starter';
      const recordedStatus = status === 'incomplete' ? 'incomplete' : 'past_due';
      await q(
        `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, plan_id, status,
                                   current_period_start, current_period_end, grace_until)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id) DO UPDATE SET
           stripe_sub_id = EXCLUDED.stripe_sub_id, status = EXCLUDED.status,
           plan_id = EXCLUDED.plan_id,
           current_period_start = COALESCE(EXCLUDED.current_period_start, subscriptions.current_period_start),
           current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
           grace_until = COALESCE(subscriptions.grace_until, EXCLUDED.grace_until)`,
        [tenantId, subId, pastDuePlan, recordedStatus, periodStart, periodEnd, graceUntil],
      );
      await emitBillingEvent({ type: 'subscription.past_due', tenantId, detail: { status, graceUntil }, eventId });
    } else if (status === 'canceled' || status === 'incomplete_expired') {
      // Ended subscription -> downgrade now (data kept; read-only if over
      // the starter limits — never deleted).
      await downgradeTenant(tenantId, `subscription_${status}`, q, { eventId });
      await emitBillingEvent({ type: 'subscription.deleted', tenantId, detail: { status }, eventId });
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
      // A1-M5: shared helper — the admin plan override uses the same check.
      const { recomputeReadOnly } = await import('../services/billing.js');
      await q(`UPDATE tenants SET plan_id = $2 WHERE id = $1`, [tenantId, effectivePlan]);
      await recomputeReadOnly(tenantId, effectivePlan, q);
    }
  } else if (type === 'customer.subscription.deleted') {
    const subId: string | undefined = data.id;
    if (!subId) {
      await markProcessed();
      return { deduplicated: false };
    }
    const tenantId = await resolveTenantForSubscription(q, data, subId);
    if (!tenantId) {
      await markProcessed();
      return { deduplicated: false };
    }
    tenantForLedger = tenantId;
    // E4-H-2: same superseded-subscription guard as above — a deleted event
    // for an old subscription must not downgrade a tenant with a live one.
    const curDel = await q(`SELECT stripe_sub_id FROM subscriptions WHERE tenant_id = $1`, [tenantId]);
    const storedDelSubId = curDel.rows[0]?.stripe_sub_id as string | null | undefined;
    if (storedDelSubId && storedDelSubId !== subId) {
      console.warn(
        `[billing] ignoring customer.subscription.deleted for superseded subscription ${subId} (tenant ${tenantId} tracks ${storedDelSubId})`,
      );
      await markProcessed();
      return { deduplicated: false };
    }
    const { downgradeTenant, emitBillingEvent } = await import('../services/billing.js');
    await downgradeTenant(tenantId, 'subscription_deleted', q, { eventId });
    await emitBillingEvent({ type: 'subscription.deleted', tenantId, eventId });
  } else if (type === 'invoice.paid' || type === 'invoice.payment_failed') {
    const invoiceId: string | undefined = data.id;
    const tenantId = await resolveTenantForSubscription(q, data);
    if (!tenantId || !invoiceId) {
      await markProcessed();
      return { deduplicated: false };
    }
    tenantForLedger = tenantId;
    const paid = type === 'invoice.paid';
    // C5-M-1: on invoice.paid Stripe reports amount_due = 0 (fully paid) —
    // `??` doesn't fall through on 0, so every paid invoice was recorded at
    // $0. Paid invoices use amount_paid; failed ones use amount_due.
    const amount = paid
      ? Number(data.amount_paid ?? data.total ?? data.amount_due ?? 0)
      : Number(data.amount_due ?? data.total ?? 0);
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
      // D1-H-1 / D5-M-2: reconcile with Stripe — recover from a LOCAL
      // 'canceled' too when the invoice proves the Stripe subscription is
      // still alive (the subscription id on the invoice matches the stored
      // one). Otherwise a payer whose Stripe retry succeeded after a local
      // downgrade keeps paying while the product shows Starter. The plan is
      // re-resolved from the invoice's price so the product matches what
      // Stripe billed.
      const { id: invSubId } = subObject(data);
      const curSub = await q(`SELECT status, stripe_sub_id, plan_id FROM subscriptions WHERE tenant_id = $1`, [
        tenantId,
      ]);
      const curStatus = curSub.rows[0]?.status as string | undefined;
      if (curStatus === 'past_due' || curStatus === 'incomplete') {
        // G5-M#2: revive the PAID plan, not just the status. After grace
        // expiry, downgradeTenant() set tenants.plan_id='starter' (and
        // possibly read_only=TRUE) while the row stayed 'past_due' — and
        // for 'incomplete' the tenant plan was never upgraded at checkout
        // (G5-M#1). Flipping status to 'active' alone would leave the
        // payer billed Growth/Pro while the product serves Starter,
        // possibly fully read-only. Mirror the 'canceled'-revival branch:
        // resolve the plan from the invoice's price, write it to both
        // rows, and recompute read_only.
        const recPriceId: string | undefined = data.lines?.data?.[0]?.price?.id;
        const recPlanFromEvent =
          planIdFromStripePrice(recPriceId) ?? (isPlanId(data.metadata?.planId) ? data.metadata.planId : null);
        if (recPlanFromEvent) {
          await q(
            `UPDATE subscriptions SET status = 'active', plan_id = $2, grace_until = NULL WHERE tenant_id = $1`,
            [tenantId, recPlanFromEvent],
          );
          await q(`UPDATE tenants SET plan_id = $2 WHERE id = $1`, [tenantId, recPlanFromEvent]);
          const { recomputeReadOnly } = await import('../services/billing.js');
          await recomputeReadOnly(tenantId, recPlanFromEvent, q);
        } else {
          // No resolvable plan on the invoice — revive the status, keep
          // the stored plan, and log loudly for ops instead of guessing.
          console.error(
            `[billing] invoice.paid for ${curStatus} subscription ` +
              `(tenant ${tenantId}): no resolvable plan on the invoice — status revived, plan kept`,
          );
          await q(`UPDATE subscriptions SET status = 'active', grace_until = NULL WHERE tenant_id = $1`, [
            tenantId,
          ]);
        }
      } else if (
        curStatus === 'canceled' &&
        invSubId &&
        invSubId === (curSub.rows[0]?.stripe_sub_id as string | undefined)
      ) {
        const invPriceId: string | undefined = data.lines?.data?.[0]?.price?.id;
        const planFromEvent =
          planIdFromStripePrice(invPriceId) ?? (isPlanId(data.metadata?.planId) ? data.metadata.planId : null);
        if (planFromEvent) {
          await q(
            `UPDATE subscriptions SET status = 'active', plan_id = $2, grace_until = NULL WHERE tenant_id = $1`,
            [tenantId, planFromEvent],
          );
          await q(`UPDATE tenants SET plan_id = $2 WHERE id = $1`, [tenantId, planFromEvent]);
          const { recomputeReadOnly } = await import('../services/billing.js');
          await recomputeReadOnly(tenantId, planFromEvent, q);
        } else {
          // The invoice proves the subscription is alive but carries no
          // resolvable plan — revive the status, keep the stored plan, and
          // log loudly for ops instead of guessing.
          console.error(
            `[billing] invoice.paid for locally-canceled subscription ${invSubId} ` +
              `(tenant ${tenantId}): no resolvable plan on the invoice — status revived, plan kept`,
          );
          await q(`UPDATE subscriptions SET status = 'active', grace_until = NULL WHERE tenant_id = $1`, [
            tenantId,
          ]);
        }
      }
      await emitBillingEvent({ type: 'invoice.paid', tenantId, detail: { invoiceId, amount }, eventId });
    } else {
      const cur = await q(`SELECT status, grace_until FROM subscriptions WHERE tenant_id = $1`, [tenantId]);
      const existingGrace = cur.rows[0]?.grace_until as string | null | undefined;
      const curStatus = cur.rows[0]?.status as string | undefined;
      if (curStatus === 'canceled') {
        // E4-M-3: genuinely canceled — a late payment_failed must NOT resurrect.
      } else if (curStatus === 'past_due' && !existingGrace) {
        // D1-H-1: grace already consumed (post-downgrade) and Stripe is
        // still retrying. Do NOT mint a fresh grace or re-dun — that would
        // restart the downgrade cycle on every failed retry. Just record
        // the invoice; a later invoice.paid recovers via the branch above.
      } else if (!existingGrace) {
        await q(`UPDATE subscriptions SET status = 'past_due', grace_until = $2 WHERE tenant_id = $1`, [
          tenantId,
          graceDeadline(),
        ]);
        await emitBillingEvent({ type: 'invoice.payment_failed', tenantId, detail: { invoiceId, amount }, eventId });
      } else {
        await q(`UPDATE subscriptions SET status = 'past_due' WHERE tenant_id = $1`, [tenantId]);
        await emitBillingEvent({ type: 'invoice.payment_failed', tenantId, detail: { invoiceId, amount }, eventId });
      }
    }
  } else if (type === 'charge.refunded') {
    const invoiceId: string | undefined =
      (typeof data.invoice === 'string' ? data.invoice : data.invoice?.id) ?? data.metadata?.invoiceId;
    const tenantId: string | null =
      (data.metadata?.tenantId as string | undefined) ?? (await resolveTenantForSubscription(q, data));
    if (!tenantId) {
      await markProcessed();
      return { deduplicated: false };
    }
    tenantForLedger = tenantId;
    const chargeId: string = (data.id as string | undefined) ?? '';
    // G5-L#1: data.amount_refunded is the CUMULATIVE refunded total on the
    // charge, and every partial refund generates its own charge.refunded
    // event (distinct event id → passes the F2-L-1 guard). Crediting the
    // cumulative amount per event over-credits: two $5 partials on a $10
    // charge used to credit 500 + 1000 = 1500¢. Credit only the DELTA over
    // what was already credited for this charge (matched by the charge id
    // embedded in the credit reason); skip the insert when delta <= 0.
    // (Without a charge id — the mock path — keep the old behavior.)
    const cumulativeRefunded = Math.round(Number(data.amount_refunded ?? data.amount ?? 0));
    let amount = cumulativeRefunded;
    if (chargeId) {
      const prev = await q(
        `SELECT COALESCE(SUM(amount_cents), 0)::int AS c FROM tenant_credits
         WHERE tenant_id = $1 AND starts_with(reason, $2)`,
        [tenantId, `Refund ${chargeId}`],
      );
      amount = Math.max(0, cumulativeRefunded - Number(prev.rows[0]?.c ?? 0));
    }
    if (invoiceId) {
      await q(`UPDATE invoices SET status = 'refunded' WHERE stripe_invoice_id = $1 AND tenant_id = $2`, [
        invoiceId,
        tenantId,
      ]);
    }
    // Credit note helper (F-14): the refund is recorded as a tenant credit
    // so support can reconcile it against future invoices.
    // F2-L-1: idempotency-guarded by the webhook event id — a reprocessed
    // (crash-retry, E4-M-2) or concurrently-duplicate-delivered refund must
    // not credit the tenant twice. NULL event ids (mock path without one)
    // never conflict, preserving the old behavior there.
    if (amount > 0) {
      await q(
        `INSERT INTO tenant_credits (id, tenant_id, amount_cents, reason, webhook_event_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)
         ON CONFLICT (webhook_event_id) DO NOTHING`,
        [
          tenantId,
          amount,
          `Refund ${chargeId}${invoiceId ? ` for invoice ${invoiceId}` : ''}`.trim(),
          eventId ?? null,
        ],
      );
    }
    const { emitBillingEvent } = await import('../services/billing.js');
    await emitBillingEvent({ type: 'charge.refunded', tenantId, detail: { amount, invoiceId }, eventId });
  } else {
    console.warn(`[billing] unhandled webhook event type: ${type}`);
  }

  // Record the newest applied event time for the ordering guard. Only
  // flows that actually applied state reach here with a tenant.
  // NEW-4: charge.refunded is EXEMPT — it does not mutate subscription
  // state (it only marks an invoice + records a credit), so it must not
  // advance the watermark; doing so could make a later-delivered,
  // earlier-created subscription event look stale and be dropped.
  if (eventAt && tenantForLedger && type !== 'charge.refunded') {
    await q(
      `UPDATE subscriptions SET last_event_at = GREATEST(COALESCE(last_event_at, $2), $2)
       WHERE tenant_id = $1`,
      [tenantForLedger, eventAt],
    ).catch(() => undefined);
  }
  if (eventId) {
    await q(`UPDATE stripe_webhook_events SET processed_at = now(), tenant_id = $2 WHERE event_id = $1`, [
      eventId,
      tenantForLedger,
    ]);
  }
  return { deduplicated: false };
}

/**
 * C1-H-1/H-2: cancels a tenant's Stripe subscription(s) BEFORE any account
 * rows are deleted, and reports outstanding tenant_credits (money owed to
 * the customer). Callers must write the forfeit/refund record for the
 * credits and ABORT the deletion (502) when cancellation fails — never
 * silently delete a paying tenant's rows while Stripe keeps charging.
 *
 * Returns { canceled, creditsCents }: canceled subscription ids and the
 * outstanding credit balance the caller must reconcile (refund or explicit
 * forfeit record — never a silent hard-delete).
 */
export async function cancelTenantBilling(
  tenantId: string,
  q: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> = query,
): Promise<{ canceled: string[]; creditsCents: number }> {
  const t = await q(`SELECT stripe_customer_id FROM tenants WHERE id = $1`, [tenantId]);
  const customerId = (t.rows[0]?.stripe_customer_id as string | null) ?? null;
  let canceled: string[] = [];
  if (customerId) {
    try {
      canceled = (await getPayments().cancelSubscription(customerId)).canceled;
    } catch (err) {
      throw new ApiError(
        502,
        'BILLING_CANCEL_FAILED',
        'Could not cancel the Stripe subscription before deleting the account. ' +
          'No data was deleted — please try again or contact support.',
      );
    }
  }
  const c = await q(`SELECT COALESCE(SUM(amount_cents), 0)::int AS c FROM tenant_credits WHERE tenant_id = $1`, [
    tenantId,
  ]);
  return { canceled, creditsCents: Number(c.rows[0]?.c ?? 0) };
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
  async ensureCoupon(): Promise<string> {
    throw this.err();
  }
  /**
   * C1-H-1: billing was never configured, so no subscription can exist —
   * cancel is an honest no-op (blocking account deletion here would strand
   * the user with no way to delete their data).
   */
  async cancelSubscription(): Promise<{ canceled: string[] }> {
    return { canceled: [] };
  }
  /**
   * D5-L-2: billing was never configured, so no subscription can exist —
   * pause/resume are honest no-ops.
   */
  async pauseSubscription(): Promise<{ paused: string[] }> {
    return { paused: [] };
  }
  async resumeSubscription(): Promise<{ resumed: string[] }> {
    return { resumed: [] };
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
