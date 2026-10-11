/**
 * Wave-4 Pass #4 regression tests — BE-A (billing/subscription/auth).
 *
 * Covers:
 *  D5-H-1  server-side 14-day trial (migration 044, trial_ends_at on
 *          signup, requireActiveSubscriptionOrTrial gate → 402 +
 *          read-only after expiry)
 *  D1-H-1  grace-expiry downgrade keeps local status 'past_due' (no fake
 *          'canceled'): (a) checkout still 409s (no second subscription /
 *          double billing); (b) invoice.paid reconciles a locally-canceled
 *          row when the invoice's subscription matches
 *  D5-M-1  PRICE_NOT_CONFIGURED 502 no longer poisons the idempotency
 *          ledger — the row is deleted before the throw so Stripe retries
 *          reprocess after the price is configured
 *  D5-M-2  invoice.paid recovery extends past locally-canceled rows
 *  D5-M-3  coupon slot released exactly once (flag-guarded)
 *  D5-L-1  coupon slot released when redeem can't apply (deactivated
 *          mid-flight)
 *  D5-L-4  processBillingGrace isolates per-tenant failures
 *  D5-L-5  resolveStripeCoupon no longer holds the row lock across the
 *          Stripe network call (functional: end-to-end reserve still works)
 *  D1-M-1  POST /auth/logout revokes only the current session
 *  D3-M-1  POST /account/invitations/accept no longer returns the session
 *          JWT in the JSON body (cookie-only)
 */
import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, query, signupOwner, authz, tokenFrom, uniqueEmail } from './helpers.js';
import { applyPaymentEvent } from '../../src/providers/stripe.js';
import { processBillingGrace } from '../../src/services/billing.js';
import {
  requireActiveSubscriptionOrTrial,
} from '../../src/middleware/requireSubscription.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');
const uid = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
// This file creates ~10 users; the auth endpoints are rate-limited to
// 20/min per IP by default — raise it for the file (live env fallback in
// routes/auth.ts; the integration setup scrubs it between files).
process.env.AUTH_RATE_LIMIT_PER_MIN = '1000';

const asGateReq = (tenantId: string) => ({ tenant: { tenantId } }) as any;

async function insertCoupon(code: string, opts: { max?: number | null; active?: boolean; reserved?: number } = {}) {
  await query(
    `INSERT INTO billing_coupons (code, percent_off, duration, max_redemptions, active, reserved_count)
     VALUES ($1, 50, 'once', $2, $3, $4)
     ON CONFLICT (code) DO UPDATE SET percent_off = 50, duration = 'once',
       max_redemptions = $2, active = $3, reserved_count = $4, redeemed_count = 0, stripe_coupon_id = NULL`,
    [code, opts.max ?? null, opts.active ?? true, opts.reserved ?? 0],
  );
}

async function couponRow(code: string) {
  const r = await query(
    `SELECT redeemed_count, reserved_count, active, stripe_coupon_id FROM billing_coupons WHERE code = $1`,
    [code],
  );
  return r.rows[0];
}

async function tenantRow(tenantId: string) {
  const r = await query(`SELECT plan_id, read_only, trial_ends_at FROM tenants WHERE id = $1`, [tenantId]);
  return r.rows[0];
}

async function subscriptionRow(tenantId: string) {
  const r = await query(
    `SELECT stripe_sub_id, plan_id, status, grace_until FROM subscriptions WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0];
}

/** Log in as an existing user (second session for the same account). */
async function loginAs(app: FastifyInstance, email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return tokenFrom(res);
}

describe.runIf(HAS_TEST_DB)('Wave-4 Pass#4 BE-A fixes', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  // ---------------------------------------------------------------- D5-H-1
  describe('D5-H-1: server-side 14-day trial', () => {
    test('fresh signup gets trial_ends_at ~14 days out and the gate allows usage', async () => {
      const user = await signupOwner(app);
      const t = await tenantRow(user.tenantId);
      expect(t.trial_ends_at).toBeTruthy();
      const ends = new Date(t.trial_ends_at as string).getTime();
      const deltaDays = (ends - Date.now()) / 86400_000;
      expect(deltaDays).toBeGreaterThan(13);
      expect(deltaDays).toBeLessThan(15);
      // Gate passes while the trial is live (no subscription row needed).
      await requireActiveSubscriptionOrTrial(asGateReq(user.tenantId));
    });

    test('expired trial with no subscription → 402 SUBSCRIPTION_REQUIRED + read-only', async () => {
      const user = await signupOwner(app);
      await query(`UPDATE tenants SET trial_ends_at = now() - interval '1 day', read_only = FALSE WHERE id = $1`, [
        user.tenantId,
      ]);
      await expect(requireActiveSubscriptionOrTrial(asGateReq(user.tenantId))).rejects.toMatchObject({
        status: 402,
        code: 'SUBSCRIPTION_REQUIRED',
      });
      const t = await tenantRow(user.tenantId);
      expect(t.read_only).toBe(true);
    });

    test('expired trial but an active subscription → gate allows', async () => {
      const user = await signupOwner(app);
      await query(`UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = $1`, [user.tenantId]);
      await query(
        `INSERT INTO subscriptions (tenant_id, stripe_sub_id, plan_id, status)
         VALUES ($1, $2, 'growth', 'active')`,
        [user.tenantId, `sub_4a_${uid()}`],
      );
      await requireActiveSubscriptionOrTrial(asGateReq(user.tenantId));
    });

    test('past_due (grace) subscription → gate allows', async () => {
      const user = await signupOwner(app);
      await query(`UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = $1`, [user.tenantId]);
      await query(
        `INSERT INTO subscriptions (tenant_id, stripe_sub_id, plan_id, status, grace_until)
         VALUES ($1, $2, 'growth', 'past_due', now() + interval '2 days')`,
        [user.tenantId, `sub_4a_${uid()}`],
      );
      await requireActiveSubscriptionOrTrial(asGateReq(user.tenantId));
    });
  });

  // ------------------------------------------------- D1-H-1(a): no double sub
  describe('D1-H-1(a): grace-expiry downgrade keeps past_due; checkout still blocked', () => {
    test('processBillingGrace downgrades the product but keeps the subscription past_due', async () => {
      const user = await signupOwner(app);
      const subId = `sub_4a_${uid()}`;
      await query(`UPDATE tenants SET plan_id = 'growth', trial_ends_at = now() + interval '10 days' WHERE id = $1`, [
        user.tenantId,
      ]);
      await query(
        `INSERT INTO subscriptions (tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status,
                                   current_period_start, current_period_end, grace_until)
         VALUES ($1, $2, $3, 'growth', 'past_due', now(), now() + interval '30 days', now() - interval '1 hour')`,
        [user.tenantId, subId, `cus_4a_${uid()}`],
      );
      const n = await processBillingGrace();
      expect(n).toBeGreaterThanOrEqual(1);
      const t = await tenantRow(user.tenantId);
      expect(t.plan_id).toBe('starter');
      const s = await subscriptionRow(user.tenantId);
      // The product is downgraded but the local subscription row is NOT
      // marked canceled while Stripe is still retrying.
      expect(s.status).toBe('past_due');
      expect(s.grace_until).toBeNull();
    });

    test('a second checkout while past_due is rejected (no double billing)', async () => {
      const user = await signupOwner(app);
      await query(`UPDATE tenants SET trial_ends_at = now() + interval '10 days' WHERE id = $1`, [user.tenantId]);
      await query(
        `INSERT INTO subscriptions (tenant_id, stripe_sub_id, plan_id, status, grace_until)
         VALUES ($1, $2, 'growth', 'past_due', NULL)`,
        [user.tenantId, `sub_4a_${uid()}`],
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { ...authz(user), 'idempotency-key': `4a-d1h1-${uid()}` },
        payload: { planId: 'growth' },
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as any).error.code).toBe('ALREADY_SUBSCRIBED');
    });
  });

  // --------------------------------- D1-H-1(b) + D5-M-2: invoice.paid recovery
  describe('D1-H-1(b)/D5-M-2: invoice.paid reconciles local status with Stripe', () => {
    const PRICE = 'price_4a_growth_reconcile';
    let saved: string | undefined;

    const paidInvoice = (tenantId: string, subId: string, priceId: string) => ({
      type: 'invoice.paid',
      data: {
        id: `in_4a_${uid()}`,
        subscription: subId,
        customer: `cus_4a_${uid()}`,
        amount_paid: 2900,
        total: 2900,
        amount_due: 0,
        currency: 'usd',
        lines: { data: [{ price: { id: priceId } }] },
        metadata: { tenantId },
      },
    });

    test('past_due recovery still works (existing behavior)', async () => {
      const user = await signupOwner(app);
      const subId = `sub_4a_${uid()}`;
      await query(
        `INSERT INTO subscriptions (tenant_id, stripe_sub_id, plan_id, status, grace_until)
         VALUES ($1, $2, 'growth', 'past_due', now() + interval '1 day')`,
        [user.tenantId, subId],
      );
      saved = process.env.STRIPE_PRICE_GROWTH;
      process.env.STRIPE_PRICE_GROWTH = PRICE;
      try {
        const r = await applyPaymentEvent(paidInvoice(user.tenantId, subId, PRICE) as any, query, `evt_4a_${uid()}`);
        expect(r.deduplicated).toBe(false);
        const s = await subscriptionRow(user.tenantId);
        expect(s.status).toBe('active');
        expect(s.grace_until).toBeNull();
      } finally {
        if (saved === undefined) delete process.env.STRIPE_PRICE_GROWTH;
        else process.env.STRIPE_PRICE_GROWTH = saved;
      }
    });

    test('locally-canceled row is revived when the invoice proves Stripe is still billing', async () => {
      const user = await signupOwner(app);
      const subId = `sub_4a_${uid()}`;
      // Simulates the pre-fix world: grace expiry wrote 'canceled' while
      // Stripe kept the subscription alive.
      await query(`UPDATE tenants SET plan_id = 'starter', trial_ends_at = now() + interval '10 days' WHERE id = $1`, [
        user.tenantId,
      ]);
      await query(
        `INSERT INTO subscriptions (tenant_id, stripe_sub_id, plan_id, status, grace_until)
         VALUES ($1, $2, 'growth', 'canceled', NULL)`,
        [user.tenantId, subId],
      );
      saved = process.env.STRIPE_PRICE_GROWTH;
      process.env.STRIPE_PRICE_GROWTH = PRICE;
      try {
        await applyPaymentEvent(paidInvoice(user.tenantId, subId, PRICE) as any, query, `evt_4a_${uid()}`);
        const s = await subscriptionRow(user.tenantId);
        expect(s.status).toBe('active');
        expect(s.plan_id).toBe('growth');
        const t = await tenantRow(user.tenantId);
        // The payer is no longer stranded on Starter.
        expect(t.plan_id).toBe('growth');
      } finally {
        if (saved === undefined) delete process.env.STRIPE_PRICE_GROWTH;
        else process.env.STRIPE_PRICE_GROWTH = saved;
      }
    });

    test('locally-canceled row is NOT revived by an unrelated invoice', async () => {
      const user = await signupOwner(app);
      await query(
        `INSERT INTO subscriptions (tenant_id, stripe_sub_id, plan_id, status, grace_until)
         VALUES ($1, $2, 'growth', 'canceled', NULL)`,
        [user.tenantId, `sub_4a_${uid()}`],
      );
      saved = process.env.STRIPE_PRICE_GROWTH;
      process.env.STRIPE_PRICE_GROWTH = PRICE;
      try {
        // Invoice for a DIFFERENT subscription id: must not revive.
        await applyPaymentEvent(
          paidInvoice(user.tenantId, `sub_4a_other_${uid()}`, PRICE) as any,
          query,
          `evt_4a_${uid()}`,
        );
        const s = await subscriptionRow(user.tenantId);
        expect(s.status).toBe('canceled');
      } finally {
        if (saved === undefined) delete process.env.STRIPE_PRICE_GROWTH;
        else process.env.STRIPE_PRICE_GROWTH = saved;
      }
    });

    test('failed retry after a consumed grace does not mint a fresh grace', async () => {
      const user = await signupOwner(app);
      const subId = `sub_4a_${uid()}`;
      await query(`UPDATE tenants SET plan_id = 'starter', trial_ends_at = now() + interval '10 days' WHERE id = $1`, [
        user.tenantId,
      ]);
      await query(
        `INSERT INTO subscriptions (tenant_id, stripe_sub_id, plan_id, status, grace_until)
         VALUES ($1, $2, 'growth', 'past_due', NULL)`,
        [user.tenantId, subId],
      );
      await applyPaymentEvent(
        {
          type: 'invoice.payment_failed',
          data: {
            id: `in_4a_${uid()}`,
            subscription: subId,
            customer: `cus_4a_${uid()}`,
            amount_due: 2900,
            currency: 'usd',
            metadata: { tenantId: user.tenantId },
          },
        } as any,
        query,
        `evt_4a_${uid()}`,
      );
      const s = await subscriptionRow(user.tenantId);
      expect(s.status).toBe('past_due');
      expect(s.grace_until).toBeNull();
    });
  });

  // ------------------------------------------------------------------ D5-M-1
  describe('D5-M-1: PRICE_NOT_CONFIGURED 502 does not poison the ledger', () => {
    const UNKNOWN_PRICE = 'price_4a_unknown_xyz';

    test('retry after configuring the price reprocesses (not deduplicated)', async () => {
      const user = await signupOwner(app);
      const subId = `sub_4a_${uid()}`;
      await query(
        `INSERT INTO subscriptions (tenant_id, stripe_sub_id, plan_id, status)
         VALUES ($1, $2, 'starter', 'active')`,
        [user.tenantId, subId],
      );
      const evt = {
        type: 'customer.subscription.updated',
        data: {
          id: subId,
          status: 'active',
          items: { data: [{ price: { id: UNKNOWN_PRICE } }] },
          current_period_start: Math.floor(Date.now() / 1000) - 60,
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        },
      };
      const eventId = `evt_4a_${uid()}`;
      await expect(applyPaymentEvent(evt as any, query, eventId)).rejects.toMatchObject({
        status: 502,
        code: 'PRICE_NOT_CONFIGURED',
      });
      // The ledger row must be gone — otherwise the retry dedupes forever.
      const led = await query(`SELECT event_id FROM stripe_webhook_events WHERE event_id = $1`, [eventId]);
      expect(led.rows.length).toBe(0);
      // Ops configures the price; Stripe retries the SAME event id.
      const saved = process.env.STRIPE_PRICE_GROWTH;
      process.env.STRIPE_PRICE_GROWTH = UNKNOWN_PRICE;
      try {
        const r = await applyPaymentEvent(evt as any, query, eventId);
        expect(r.deduplicated).toBe(false);
        const s = await subscriptionRow(user.tenantId);
        expect(s.plan_id).toBe('growth');
        const t = await tenantRow(user.tenantId);
        expect(t.plan_id).toBe('growth');
      } finally {
        if (saved === undefined) delete process.env.STRIPE_PRICE_GROWTH;
        else process.env.STRIPE_PRICE_GROWTH = saved;
      }
    });
  });

  // ------------------------------------------------- D5-M-3 / D5-L-1 / D5-L-5
  describe('coupon slot accounting (D5-M-3, D5-L-1, D5-L-5)', () => {
    test('D5-M-3: reservation released exactly once when checkout fails after reserving', async () => {
      const user = await signupOwner(app);
      const code = `F4A3A${uid()}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
      await insertCoupon(code, { max: 5 });
      // Already subscribed → checkout 409s AFTER the coupon was reserved.
      await query(
        `INSERT INTO subscriptions (tenant_id, stripe_sub_id, plan_id, status)
         VALUES ($1, $2, 'growth', 'active')`,
        [user.tenantId, `sub_4a_${uid()}`],
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { ...authz(user), 'idempotency-key': `4a-m3-${uid()}` },
        payload: { planId: 'pro', couponCode: code },
      });
      expect(res.statusCode).toBe(409);
      const row = await couponRow(code);
      // Released exactly once: back to 0, never negative.
      expect(Number(row.reserved_count)).toBe(0);
    });

    test('D5-M-3: failed resolve (rolled-back reservation) releases nothing', async () => {
      const user = await signupOwner(app);
      const code = `F4A3B${uid()}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
      // Cap fully reserved by someone else → resolve fails and rolls back.
      await insertCoupon(code, { max: 1, reserved: 1 });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { ...authz(user), 'idempotency-key': `4a-m3b-${uid()}` },
        payload: { planId: 'growth', couponCode: code },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as any).error.code).toBe('COUPON_EXHAUSTED');
      const row = await couponRow(code);
      // The other checkout's slot is untouched (no double-release).
      expect(Number(row.reserved_count)).toBe(1);
    });

    test('D5-L-1: deactivated-mid-flight coupon releases its reserved slot on completion', async () => {
      const user = await signupOwner(app);
      const code = `F4AL1${uid()}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
      await insertCoupon(code, { max: 10, reserved: 1 });
      // Admin deactivates the coupon while a checkout is in flight.
      await query(`UPDATE billing_coupons SET active = FALSE WHERE code = $1`, [code]);
      await applyPaymentEvent(
        {
          type: 'checkout.session.completed',
          data: {
            metadata: { tenantId: user.tenantId, planId: 'growth', couponCode: code },
            customer: `cus_4a_${uid()}`,
            subscription: `sub_4a_${uid()}`,
          },
        } as any,
        query,
        `evt_4a_${uid()}`,
      );
      const row = await couponRow(code);
      expect(Number(row.reserved_count)).toBe(0);
      expect(Number(row.redeemed_count)).toBe(0);
    });

    test('D5-L-5: coupon resolve works end-to-end without holding the row lock across Stripe', async () => {
      const user = await signupOwner(app);
      const code = `F4AL5${uid()}`.toUpperCase().replace(/[^A-Z0-9]/g, '');
      await insertCoupon(code, { max: 10 });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { ...authz(user), 'idempotency-key': `4a-l5-${uid()}` },
        payload: { planId: 'growth', couponCode: code },
      });
      expect(res.statusCode).toBe(200);
      const row = await couponRow(code);
      expect(Number(row.reserved_count)).toBe(1);
      // Mock provider resolves the coupon id without a Stripe round-trip.
      expect(row.stripe_coupon_id).toBe(`mock_${code}`);
    });
  });

  // ------------------------------------------------------------------ D1-M-1
  describe('D1-M-1: POST /auth/logout revokes only the current session', () => {
    test('other sessions survive a plain logout', async () => {
      const password = 'W4$x9Qv!2LpR7#tZ';
      const user = await signupOwner(app, password);
      const tokenA = user.token; // first session
      const tokenB = await loginAs(app, user.email, password); // second session
      // Both work before.
      expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${tokenB}` } })).statusCode).toBe(200);
      // Plain logout with session A.
      const out = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(out.statusCode).toBe(200);
      // Session A is dead…
      const meA = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${tokenA}` } });
      expect(meA.statusCode).toBe(401);
      // …but session B survives (old code killed it via revokeAllSessions).
      const meB = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${tokenB}` } });
      expect(meB.statusCode).toBe(200);
      // token_version untouched — logout-everywhere semantics NOT applied.
      const tv = await query(`SELECT token_version FROM users WHERE id = $1`, [user.userId]);
      expect(Number(tv.rows[0].token_version)).toBe(0);
    });
  });

  // ------------------------------------------------------------------ D3-M-1
  describe('D3-M-1: invite-accept no longer returns the session JWT in the body', () => {
    test('response has no token field; the session arrives via the httpOnly cookie', async () => {
      const owner = await signupOwner(app);
      const inviteEmail = uniqueEmail('w4invite');
      const inv = await app.inject({
        method: 'POST',
        url: '/api/v1/account/invitations',
        headers: authz(owner),
        payload: { email: inviteEmail, role: 'editor' },
      });
      expect(inv.statusCode).toBe(202);
      const rawToken = (inv.json() as any).token as string;
      expect(typeof rawToken).toBe('string');

      // The invitee signs up fresh (own empty tenant → no orphan guards).
      const password = 'W4$x9Qv!2LpR7#tZ';
      const su = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/signup',
        payload: { email: inviteEmail, password, name: 'W4 Invitee' },
      });
      expect(su.statusCode).toBe(201);
      const inviteeId = (su.json() as any).user.id as string;
      await query('UPDATE users SET email_verified_at = now() WHERE id = $1', [inviteeId]);
      const inviteeToken = await loginAs(app, inviteEmail, password);

      const acc = await app.inject({
        method: 'POST',
        url: '/api/v1/account/invitations/accept',
        headers: { authorization: `Bearer ${inviteeToken}` },
        payload: { token: rawToken },
      });
      expect(acc.statusCode).toBe(200);
      const body = acc.json() as any;
      expect(body.ok).toBe(true);
      expect(body.tenantId).toBe(owner.tenantId);
      expect(body.role).toBe('editor');
      // The JWT must not be in the JSON body…
      expect('token' in body).toBe(false);
      // …but the session cookie must be set.
      const cookies = acc.headers['set-cookie'] as unknown as string[];
      expect(cookies.some((c) => c.startsWith('bseo_token='))).toBe(true);
    });
  });

  // ------------------------------------------------------------------ D5-L-4
  describe('D5-L-4: processBillingGrace downgrades every expired tenant', () => {
    test('two expired-grace tenants are both downgraded in one run', async () => {
      const mk = async () => {
        const u = await signupOwner(app);
        await query(`UPDATE tenants SET plan_id = 'growth', trial_ends_at = now() + interval '10 days' WHERE id = $1`, [
          u.tenantId,
        ]);
        await query(
          `INSERT INTO subscriptions (tenant_id, stripe_sub_id, plan_id, status, grace_until)
           VALUES ($1, $2, 'growth', 'past_due', now() - interval '1 hour')`,
          [u.tenantId, `sub_4a_${uid()}`],
        );
        return u;
      };
      const a = await mk();
      const b = await mk();
      const n = await processBillingGrace();
      expect(n).toBeGreaterThanOrEqual(2);
      for (const u of [a, b]) {
        const t = await tenantRow(u.tenantId);
        expect(t.plan_id).toBe('starter');
        const s = await subscriptionRow(u.tenantId);
        expect(s.status).toBe('past_due');
      }
    });
  });
});
