import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import type { FastifyInstance } from 'fastify';
import { pool, query, runMigrations } from '../src/db.js';
import { applyPaymentEvent, getPayments } from '../src/providers/stripe.js';
import { withIdempotency } from '../src/middleware/idempotency.js';
import { sessionTokenFromResponse } from './helpers.js';
import { onBillingEvent, processBillingGrace } from '../src/services/billing.js';

/**
 * C-01 (HIGH): billing completeness.
 *  - Webhook idempotency: processed event ids stored; redelivery is a no-op.
 *  - Period/status/plan come FROM Stripe (never now()+30d).
 *  - invoice.paid / invoice.payment_failed / subscription.created|updated|
 *    deleted / checkout.session.completed / charge.refunded all handled.
 *  - Double checkout blocked when already subscribed (N-A1-5: SELECT FOR
 *    UPDATE on the tenant row around customer creation).
 *  - Trials, coupons, annual plans, proration notes.
 *  - Dunning hooks + grace period before downgrade; downgrade with excess
 *    usage -> read-only mode (data never deleted).
 *  - Invoices list endpoint; mock provider mirrors real event shapes.
 *
 * Runs in mock-billing mode (no Stripe keys); the event shapes mirror the
 * real Stripe objects (id, object, customer, subscription{...}, items...).
 * Needs DATABASE_URL pointing at a test database (bseo_test_ba).
 */
const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

async function signupVerified(app: FastifyInstance, email: string) {
  // Unique password per signup: the S-05 breach check queries the real HIBP
  // corpus, so fixed test passwords get rejected.
  const password = `C01!${Date.now()}${Math.floor(Math.random() * 1e9)}xQ9#`;
  const s = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, password, name: 'C01' },
  });
  expect(s.statusCode).toBe(201);
  const body = s.json() as any;
  const v = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/email/verify',
    payload: { token: body.verifyToken },
  });
  expect(v.statusCode).toBe(200);
  return { token: sessionTokenFromResponse(s), tenantId: body.tenant.id as string, userId: body.user.id as string };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe.runIf(HAS_TEST_DB)('C-01 billing completeness', () => {
  let app: FastifyInstance;
  const tenants: string[] = [];
  const billingEvents: Array<{ type: string; tenantId: string }> = [];
  let offHook: () => void;

  beforeAll(async () => {
    await runMigrations();
    expect(getPayments().isMock).toBe(true);
    app = await buildApp();
    offHook = onBillingEvent(async (e) => {
      billingEvents.push({ type: e.type, tenantId: e.tenantId });
    });
    // A coupon for the coupon tests.
    await query(
      `INSERT INTO billing_coupons (code, percent_off, duration, max_redemptions)
       VALUES ('WELCOME25', 25, 'once', 100)
       ON CONFLICT (code) DO UPDATE SET active = TRUE, redeemed_count = 0`,
    );
  }, 60000);

  afterAll(async () => {
    offHook?.();
    await app?.close();
    if (tenants.length) await query('DELETE FROM tenants WHERE id = ANY($1)', [tenants]);
    await pool.end();
  });

  it('checkout.session.completed stores the period FROM Stripe (not now()+30d)', async () => {
    const u = await signupVerified(app, `c01-period-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    const periodStart = 1_700_000_000; // 2023-11-14
    const periodEnd = periodStart + 30 * 86400;
    const r = await applyPaymentEvent({
      id: `evt_c01_period_${Date.now()}`,
      type: 'checkout.session.completed',
      data: {
        id: 'cs_test_1',
        object: 'checkout.session',
        customer: 'cus_test_1',
        subscription: {
          id: 'sub_test_1',
          object: 'subscription',
          status: 'active',
          current_period_start: periodStart,
          current_period_end: periodEnd,
        },
        metadata: { tenantId: u.tenantId, planId: 'growth' },
      },
    });
    expect(r.deduplicated).toBe(false);
    const sub = await query(`SELECT * FROM subscriptions WHERE tenant_id = $1`, [u.tenantId]);
    expect(sub.rows[0].plan_id).toBe('growth');
    expect(sub.rows[0].status).toBe('active');
    expect(new Date(sub.rows[0].current_period_start).getTime()).toBe(periodStart * 1000);
    expect(new Date(sub.rows[0].current_period_end).getTime()).toBe(periodEnd * 1000);
    const t = await query(`SELECT plan_id FROM tenants WHERE id = $1`, [u.tenantId]);
    expect(t.rows[0].plan_id).toBe('growth');
  });

  it('webhook redelivery with the same event id is a no-op (idempotency)', async () => {
    const u = await signupVerified(app, `c01-idem-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    const evtId = `evt_c01_idem_${Date.now()}`;
    const data = {
      id: 'cs_test_2',
      object: 'checkout.session',
      customer: 'cus_test_2',
      subscription: 'sub_test_2',
      metadata: { tenantId: u.tenantId, planId: 'pro' },
    };
    const first = await applyPaymentEvent({ id: evtId, type: 'checkout.session.completed', data });
    const second = await applyPaymentEvent({ id: evtId, type: 'checkout.session.completed', data });
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    const n = await query(`SELECT COUNT(*)::int c FROM subscriptions WHERE tenant_id = $1`, [u.tenantId]);
    expect(n.rows[0].c).toBe(1);
    const ev = await query(`SELECT COUNT(*)::int c FROM stripe_webhook_events WHERE event_id = $1`, [evtId]);
    expect(ev.rows[0].c).toBe(1);
  });

  it('customer.subscription.updated maps plan from the Stripe price id and stores the period', async () => {
    const u = await signupVerified(app, `c01-subupd-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    await query(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, plan_id, status)
       VALUES (gen_random_uuid(), $1, 'sub_upd_1', 'starter', 'active')`,
      [u.tenantId],
    );
    process.env.STRIPE_PRICE_PRO = process.env.STRIPE_PRICE_PRO || 'price_pro_test';
    const { planIdFromStripePrice } = await import('../src/providers/stripe.js');
    const priceId = process.env.STRIPE_PRICE_PRO as string;
    expect(planIdFromStripePrice(priceId)).toBe('pro');
    await applyPaymentEvent({
      id: `evt_c01_subupd_${Date.now()}`,
      type: 'customer.subscription.updated',
      data: {
        id: 'sub_upd_1',
        object: 'subscription',
        status: 'active',
        current_period_start: 1_700_100_000,
        current_period_end: 1_702_692_000,
        items: { data: [{ price: { id: priceId } }] },
        metadata: {},
      },
    });
    const sub = await query(`SELECT plan_id, current_period_start FROM subscriptions WHERE stripe_sub_id = $1`, [
      'sub_upd_1',
    ]);
    expect(sub.rows[0].plan_id).toBe('pro');
    expect(new Date(sub.rows[0].current_period_start).getTime()).toBe(1_700_100_000 * 1000);
  });

  it('second POST /billing/checkout while subscribed is blocked (409, use portal)', async () => {
    const u = await signupVerified(app, `c01-dbl-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { ...auth(u.token), 'idempotency-key': `c01-dbl-${Date.now()}` },
      payload: { planId: 'growth' },
    });
    expect(first.statusCode).toBe(200);
    // Complete the mock checkout (creates the subscription row), then a
    // second checkout must be refused with a pointer to the portal.
    const checkoutUrl = new URL((first.json() as any).url as string);
    const confirm = await app.inject({
      method: 'GET',
      url: `${checkoutUrl.pathname}${checkoutUrl.search}`,
      headers: auth(u.token),
    });
    expect(confirm.statusCode).toBe(302);
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: auth(u.token),
      payload: { planId: 'pro' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('ALREADY_SUBSCRIBED');
  });

  it('concurrent checkouts create exactly one customer (N-A1-5 SELECT FOR UPDATE)', async () => {
    const u = await signupVerified(app, `c01-race-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/billing/checkout',
          headers: { ...auth(u.token), 'idempotency-key': `c01-race-${Date.now()}-${i}` },
          payload: { planId: 'growth' },
        }),
      ),
    );
    const okCount = results.filter(
      (r) => r.status === 'fulfilled' && (r.value.statusCode === 200 || r.value.statusCode === 409),
    ).length;
    expect(okCount).toBe(5);
    const t = await query(`SELECT stripe_customer_id FROM tenants WHERE id = $1`, [u.tenantId]);
    expect(t.rows[0].stripe_customer_id).toMatch(/^cus_mock_/);
  });

  it('Idempotency-Key on checkout replays the stored response without new work', async () => {
    const u = await signupVerified(app, `c01-ikey-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    const key = `ikey-${Date.now()}`;
    const payload = { planId: 'growth' };
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { ...auth(u.token), 'idempotency-key': key },
      payload,
    });
    expect(r1.statusCode).toBe(200);
    // Simulate the webhook completing the subscription, then replay the key.
    await applyPaymentEvent({
      id: `evt_c01_ikey_${Date.now()}`,
      type: 'checkout.session.completed',
      data: { customer: 'cus_ikey', subscription: 'sub_ikey', metadata: { tenantId: u.tenantId, planId: 'growth' } },
    });
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { ...auth(u.token), 'idempotency-key': key },
      payload,
    });
    // Same key + same body -> the ORIGINAL response is replayed (200), not a
    // 409 for the now-existing subscription.
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
  });

  it('trial checkout creates a trialing subscription with trial_ends_at', async () => {
    const u = await signupVerified(app, `c01-trial-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: auth(u.token),
      payload: { planId: 'growth', trialDays: 14 },
    });
    expect(r.statusCode).toBe(200);
    await applyPaymentEvent({
      id: `evt_c01_trial_${Date.now()}`,
      type: 'checkout.session.completed',
      data: {
        customer: 'cus_trial',
        subscription: 'sub_trial',
        metadata: { tenantId: u.tenantId, planId: 'growth', trialDays: '14' },
      },
    });
    const sub = await query(`SELECT status, trial_ends_at FROM subscriptions WHERE tenant_id = $1`, [u.tenantId]);
    expect(sub.rows[0].status).toBe('trialing');
    expect(new Date(sub.rows[0].trial_ends_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('coupon checkout validates the code and records redemption', async () => {
    const u = await signupVerified(app, `c01-coupon-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: auth(u.token),
      payload: { planId: 'growth', couponCode: 'NOPE' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_COUPON');

    const good = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: auth(u.token),
      payload: { planId: 'growth', couponCode: 'WELCOME25' },
    });
    expect(good.statusCode).toBe(200);
    // Redemption is recorded when the payment completes (webhook), not at
    // checkout creation — simulate the completed session.
    await applyPaymentEvent({
      id: `evt_c01_coupon_${Date.now()}`,
      type: 'checkout.session.completed',
      data: {
        customer: 'cus_coupon',
        subscription: 'sub_coupon',
        metadata: { tenantId: u.tenantId, planId: 'growth', couponCode: 'WELCOME25' },
      },
    });
    const c = await query(`SELECT redeemed_count FROM billing_coupons WHERE code = 'WELCOME25'`);
    expect(Number(c.rows[0].redeemed_count)).toBeGreaterThanOrEqual(1);
  });

  it('annual checkout requires an annual price id', async () => {
    const u = await signupVerified(app, `c01-annual-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: auth(u.token),
      payload: { planId: 'growth', interval: 'annual' },
    });
    // No STRIPE_PRICE_GROWTH_ANNUAL configured in this env -> honest 400.
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('ANNUAL_NOT_CONFIGURED');
  });

  it('invoice.payment_failed -> past_due + grace period + dunning hook (no instant downgrade)', async () => {
    const u = await signupVerified(app, `c01-dun-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    await query(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status,
                                  current_period_start, current_period_end)
       VALUES (gen_random_uuid(), $1, 'sub_dun_1', 'cus_dun_1', 'growth', 'active',
               now() - interval '5 days', now() + interval '25 days')`,
      [u.tenantId],
    );
    await query(`UPDATE tenants SET plan_id = 'growth' WHERE id = $1`, [u.tenantId]);
    billingEvents.length = 0;
    await applyPaymentEvent({
      id: `evt_c01_dun_${Date.now()}`,
      type: 'invoice.payment_failed',
      data: {
        id: 'in_dun_1',
        object: 'invoice',
        customer: 'cus_dun_1',
        subscription: 'sub_dun_1',
        amount_due: 2900,
        currency: 'usd',
        period_start: 1_700_000_000,
        period_end: 1_702_592_000,
        hosted_invoice_url: 'https://inv.test/1',
      },
    });
    const sub = await query(`SELECT status, grace_until FROM subscriptions WHERE stripe_sub_id = 'sub_dun_1'`);
    expect(sub.rows[0].status).toBe('past_due');
    expect(new Date(sub.rows[0].grace_until).getTime()).toBeGreaterThan(Date.now() + 2 * 86400_000);
    // Still on the paid plan during grace.
    const t = await query(`SELECT plan_id FROM tenants WHERE id = $1`, [u.tenantId]);
    expect(t.rows[0].plan_id).toBe('growth');
    // Dunning hook fired.
    expect(billingEvents.some((e) => e.type === 'invoice.payment_failed' && e.tenantId === u.tenantId)).toBe(true);
    // Failed invoice recorded for the invoices list.
    const inv = await query(`SELECT status FROM invoices WHERE stripe_invoice_id = 'in_dun_1'`);
    expect(inv.rows[0].status).toBe('failed');
  });

  it('grace expiry downgrades to starter; excess usage -> read-only (data kept)', async () => {
    const u = await signupVerified(app, `c01-grace-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    await query(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status, grace_until)
       VALUES (gen_random_uuid(), $1, 'sub_grace_1', 'cus_grace_1', 'growth', 'past_due', now() - interval '1 hour')`,
      [u.tenantId],
    );
    await query(`UPDATE tenants SET plan_id = 'growth' WHERE id = $1`, [u.tenantId]);
    // Excess usage for starter (max_sites = 1): create 2 sites.
    for (const d of [`grace1-${Date.now()}.test`, `grace2-${Date.now()}.test`]) {
      await query(`INSERT INTO sites (id, tenant_id, domain, verified) VALUES (gen_random_uuid(), $1, $2, TRUE)`, [
        u.tenantId,
        d,
      ]);
    }
    billingEvents.length = 0;
    await processBillingGrace();
    const t = await query(`SELECT plan_id, read_only FROM tenants WHERE id = $1`, [u.tenantId]);
    expect(t.rows[0].plan_id).toBe('starter');
    expect(t.rows[0].read_only).toBe(true);
    // Data is NOT deleted.
    const n = await query(`SELECT COUNT(*)::int c FROM sites WHERE tenant_id = $1`, [u.tenantId]);
    expect(n.rows[0].c).toBe(2);
    expect(billingEvents.some((e) => e.type === 'subscription.downgraded')).toBe(true);
  });

  it('read-only tenants are blocked from mutating non-billing routes (403)', async () => {
    const u = await signupVerified(app, `c01-ro-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    await query(`UPDATE tenants SET read_only = TRUE WHERE id = $1`, [u.tenantId]);
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: auth(u.token),
      payload: { domain: 'ro-blocked.test' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('READ_ONLY_MODE');
    // Billing stays usable so the tenant can upgrade out of read-only.
    const portal = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/portal',
      headers: auth(u.token),
    });
    expect([200, 400]).toContain(portal.statusCode); // 400 = no customer yet, not 403
  });

  it('invoice.paid records a paid invoice; GET /billing/invoices lists it', async () => {
    const u = await signupVerified(app, `c01-inv-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    await query(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status)
       VALUES (gen_random_uuid(), $1, 'sub_inv_1', 'cus_inv_1', 'growth', 'past_due')`,
      [u.tenantId],
    );
    await applyPaymentEvent({
      id: `evt_c01_inv_${Date.now()}`,
      type: 'invoice.paid',
      data: {
        id: 'in_paid_1',
        object: 'invoice',
        customer: 'cus_inv_1',
        subscription: 'sub_inv_1',
        amount_paid: 2900,
        amount_due: 2900,
        currency: 'usd',
        period_start: 1_700_000_000,
        period_end: 1_702_592_000,
        hosted_invoice_url: 'https://inv.test/paid1',
      },
    });
    const sub = await query(`SELECT status, grace_until FROM subscriptions WHERE stripe_sub_id = 'sub_inv_1'`);
    expect(sub.rows[0].status).toBe('active');
    expect(sub.rows[0].grace_until).toBeNull();

    const list = await app.inject({ method: 'GET', url: '/api/v1/billing/invoices', headers: auth(u.token) });
    expect(list.statusCode).toBe(200);
    const body = list.json() as any;
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0]).toMatchObject({ status: 'paid' });
    expect(body).toMatchObject({ page: 1 });
    expect(typeof body.total).toBe('number');
  });

  it('charge.refunded marks the invoice refunded and records a credit note', async () => {
    const u = await signupVerified(app, `c01-ref-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    await query(
      `INSERT INTO invoices (tenant_id, stripe_invoice_id, status, amount_due_cents)
       VALUES ($1, 'in_ref_1', 'paid', 2900)`,
      [u.tenantId],
    );
    await applyPaymentEvent({
      id: `evt_c01_ref_${Date.now()}`,
      type: 'charge.refunded',
      data: {
        id: 'ch_ref_1',
        object: 'charge',
        amount_refunded: 2900,
        currency: 'usd',
        invoice: 'in_ref_1',
        metadata: { tenantId: u.tenantId },
      },
    });
    const inv = await query(`SELECT status FROM invoices WHERE stripe_invoice_id = 'in_ref_1'`);
    expect(inv.rows[0].status).toBe('refunded');
    const cr = await query(`SELECT amount_cents FROM tenant_credits WHERE tenant_id = $1`, [u.tenantId]);
    expect(Number(cr.rows[0].amount_cents)).toBe(2900);
  });

  it('SECURITY regression (C-01): two concurrent same-key checkouts execute exactly once', async () => {
    const u = await signupVerified(app, `c01-conc-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    const key = `conc-${Date.now()}`;
    const [r1, r2] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { ...auth(u.token), 'idempotency-key': key },
        payload: { planId: 'growth' },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { ...auth(u.token), 'idempotency-key': key },
        payload: { planId: 'growth' },
      }),
    ]);
    // The duplicate waited for the claim and replayed the stored response
    // (identical body incl. the mock session id) instead of executing.
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual(r1.json());
    const rows = await query(`SELECT COUNT(*)::int c FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`, [
      u.tenantId,
      key,
    ]);
    expect(rows.rows[0].c).toBe(1);
  });

  it('SECURITY regression (C-01): withIdempotency runs a concurrent duplicate handler once', async () => {
    // Reuses an existing tenant (FK target only) — this file is close to
    // the pre-existing 20/min signup rate limit (S-03), so new regression
    // tests avoid extra signups where a fresh tenant is not essential.
    const anyTenant = await query(`SELECT id FROM tenants ORDER BY created_at DESC LIMIT 1`);
    const tenantId = anyTenant.rows[0].id as string;
    let executions = 0;
    const wrapped = withIdempotency('billing:checkout', async () => {
      executions += 1;
      await new Promise((r) => setTimeout(r, 200));
      return { url: 'https://checkout.test/x', executions };
    });
    const wrapKey = `wrap-${tenantId}-${Date.now()}`;
    const mkReq = () =>
      ({
        headers: { 'idempotency-key': wrapKey },
        tenant: { tenantId },
        method: 'POST',
        url: '/api/v1/billing/checkout',
        body: { planId: 'growth' },
        id: 'wrap-test',
      }) as any;
    const mkReply = () =>
      ({
        statusCode: 200,
        sent: false,
        status(c: number) {
          this.statusCode = c;
          return this;
        },
        send(b: unknown) {
          this.sent = true;
          return b;
        },
      }) as any;
    const [a, b] = await Promise.all([wrapped(mkReq(), mkReply()), wrapped(mkReq(), mkReply())]);
    expect(executions).toBe(1);
    expect(a).toEqual({ url: 'https://checkout.test/x', executions: 1 });
    expect(b).toEqual(a);
  });

  it('SECURITY regression (C-01): a stale subscription event cannot overwrite newer state', async () => {
    const u = await signupVerified(app, `c01-ord-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    await query(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status)
       VALUES (gen_random_uuid(), $1, 'sub_ord_1', 'cus_ord_1', 'growth', 'active')`,
      [u.tenantId],
    );
    await query(`UPDATE tenants SET plan_id = 'growth', stripe_customer_id = 'cus_ord_1' WHERE id = $1`, [u.tenantId]);

    // NEWER event first: subscription deleted at T=1_800_000_000.
    const del = await applyPaymentEvent({
      id: `evt_ord_del_${Date.now()}`,
      type: 'customer.subscription.deleted',
      created: 1_800_000_000,
      data: { id: 'sub_ord_1', object: 'subscription', status: 'canceled' },
    });
    expect(del.stale).toBeFalsy();
    let sub = await query(`SELECT status, last_event_at FROM subscriptions WHERE tenant_id = $1`, [u.tenantId]);
    expect(sub.rows[0].status).toBe('canceled');
    expect(new Date(sub.rows[0].last_event_at).getTime()).toBe(1_800_000_000_000);

    // OLDER event delivered late: updated(active, pro) at T=1_700_000_000
    // must be skipped — but still recorded in the ledger as processed.
    const staleId = `evt_ord_stale_${Date.now()}`;
    const stale = await applyPaymentEvent({
      id: staleId,
      type: 'customer.subscription.updated',
      created: 1_700_000_000,
      data: {
        id: 'sub_ord_1',
        object: 'subscription',
        status: 'active',
        metadata: { planId: 'pro' },
      },
    });
    expect(stale.stale).toBe(true);
    sub = await query(`SELECT status, plan_id FROM subscriptions WHERE tenant_id = $1`, [u.tenantId]);
    expect(sub.rows[0].status).toBe('canceled');
    const t = await query(`SELECT plan_id FROM tenants WHERE id = $1`, [u.tenantId]);
    expect(t.rows[0].plan_id).toBe('starter'); // downgrade from the delete survived
    const ledger = await query(`SELECT processed_at FROM stripe_webhook_events WHERE event_id = $1`, [staleId]);
    expect(ledger.rows[0].processed_at).not.toBeNull();

    // A genuinely NEWER update still applies (guard blocks only stale).
    await applyPaymentEvent({
      id: `evt_ord_new_${Date.now()}`,
      type: 'customer.subscription.updated',
      created: 1_900_000_000,
      data: {
        id: 'sub_ord_1',
        object: 'subscription',
        status: 'active',
        metadata: { planId: 'pro' },
      },
    });
    sub = await query(`SELECT status, plan_id FROM subscriptions WHERE tenant_id = $1`, [u.tenantId]);
    expect(sub.rows[0].status).toBe('active');
    expect(sub.rows[0].plan_id).toBe('pro');
  });

  it('past_due upsert updates plan_id from the event (C-01 low fix)', async () => {
    const u = await signupVerified(app, `c01-pd-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    await query(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, plan_id, status)
       VALUES (gen_random_uuid(), $1, 'sub_pd_1', 'starter', 'active')`,
      [u.tenantId],
    );
    process.env.STRIPE_PRICE_PRO = process.env.STRIPE_PRICE_PRO || 'price_pro_test';
    await applyPaymentEvent({
      id: `evt_pd_${Date.now()}`,
      type: 'customer.subscription.updated',
      data: {
        id: 'sub_pd_1',
        object: 'subscription',
        status: 'past_due',
        items: { data: [{ price: { id: process.env.STRIPE_PRICE_PRO } }] },
        metadata: {},
      },
    });
    const sub = await query(`SELECT status, plan_id FROM subscriptions WHERE stripe_sub_id = 'sub_pd_1'`);
    expect(sub.rows[0].status).toBe('past_due');
    expect(sub.rows[0].plan_id).toBe('pro');
  });

  it('coupon redemption is atomic: redeemed_count never exceeds max_redemptions', async () => {
    await query(
      `INSERT INTO billing_coupons (code, percent_off, duration, max_redemptions, redeemed_count)
       VALUES ('MAXONE', 10, 'once', 1, 0)
       ON CONFLICT (code) DO UPDATE SET max_redemptions = 1, redeemed_count = 0, active = TRUE`,
    );
    // Two checkout completions redeem the same capped coupon concurrently
    // (one tenant, two sessions — the cap must hold regardless of
    // interleaving; one signup keeps this file under the S-03 signup
    // rate limit).
    const u = await signupVerified(app, `c01-cap-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    await Promise.all([
      applyPaymentEvent({
        id: `evt_cap_a_${Date.now()}`,
        type: 'checkout.session.completed',
        data: {
          customer: 'cus_cap_a',
          subscription: 'sub_cap_a',
          metadata: { tenantId: u.tenantId, planId: 'growth', couponCode: 'MAXONE' },
        },
      }),
      applyPaymentEvent({
        id: `evt_cap_b_${Date.now()}`,
        type: 'checkout.session.completed',
        data: {
          customer: 'cus_cap_b',
          subscription: 'sub_cap_b',
          metadata: { tenantId: u.tenantId, planId: 'growth', couponCode: 'MAXONE' },
        },
      }),
    ]);
    const c = await query(`SELECT redeemed_count FROM billing_coupons WHERE code = 'MAXONE'`);
    expect(Number(c.rows[0].redeemed_count)).toBe(1);
  });

  it('customer.subscription.deleted downgrades but never deletes data', async () => {
    const u = await signupVerified(app, `c01-del-${Date.now()}@beyo.test`);
    tenants.push(u.tenantId);
    await query(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status)
       VALUES (gen_random_uuid(), $1, 'sub_del_1', 'cus_del_1', 'pro', 'active')`,
      [u.tenantId],
    );
    await query(`UPDATE tenants SET plan_id = 'pro' WHERE id = $1`, [u.tenantId]);
    await query(`INSERT INTO sites (id, tenant_id, domain, verified) VALUES (gen_random_uuid(), $1, $2, TRUE)`, [
      u.tenantId,
      `delsite-${Date.now()}.test`,
    ]);
    await applyPaymentEvent({
      id: `evt_c01_del_${Date.now()}`,
      type: 'customer.subscription.deleted',
      data: { id: 'sub_del_1', object: 'subscription', status: 'canceled' },
    });
    const t = await query(`SELECT plan_id FROM tenants WHERE id = $1`, [u.tenantId]);
    expect(t.rows[0].plan_id).toBe('starter');
    const n = await query(`SELECT COUNT(*)::int c FROM sites WHERE tenant_id = $1`, [u.tenantId]);
    expect(n.rows[0].c).toBe(1);
  });
});
