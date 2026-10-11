/**
 * Wave-4 Pass#8 regression tests — fixes for the pass#8 hostile-audit findings.
 *
 * - H5-H#1 (HIGH): checkout.session.completed with an UNEXPANDED string
 *   subscription id (the real Stripe path) is a STATUS-LESS write. It must
 *   never clobber a live status ('active'/'trialing'/'past_due') established
 *   by the earlier subscription/invoice events, and it must not advance the
 *   ordering watermark (its newer `created` would otherwise make those
 *   earlier-created events look stale and get them dropped — stranding a
 *   real payer at 'incomplete' until the next renewal, i.e. a day-15
 *   trial-expiry lockout while Stripe keeps billing).
 * - H5-L#1 (LOW): the G5-L#1 refund delta is now computed + inserted in ONE
 *   serialized statement (FOR UPDATE on the tenant row) — concurrent
 *   charge.refunded events for the same charge cannot double-credit.
 * - H1-L-2 (LOW): dunning emails fire exactly once per failure episode —
 *   only the event that MINTS the grace sends the "Payment failed" email.
 *   (H1-L-1 was a duplicate of H2-L-1, already fixed + tested in
 *   w4-pass7-billing-fixes.test.ts.)
 *
 * Runs in the `integration` vitest project: real Postgres (DATABASE_URL from
 * env — use your own test DB, never the shared one) + real Redis DB 1.
 */
import { beforeAll, afterAll, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, query, signupOwner } from './helpers.js';
import { resetDb } from '../integration/helpers/db.js';
import { applyPaymentEvent } from '../../src/providers/stripe.js';
import { registerDefaultBillingHooks } from '../../src/services/billing.js';
import { getNotify } from '../../src/providers/notify.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');
const uid = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
const nowSec = () => Math.floor(Date.now() / 1000);

// Live-env price ids for plan resolution (planIdFromStripePrice reads
// process.env.STRIPE_PRICE_* live). Unique per file to avoid clashing with
// other files' mappings in the shared worker process.
const PRICE_GROWTH = `price_p8_growth_${uid()}`;

async function subRow(tenantId: string) {
  const r = await query(
    `SELECT status, plan_id, stripe_sub_id, grace_until, last_event_at FROM subscriptions WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0];
}

async function tenantRow(tenantId: string) {
  const r = await query(`SELECT plan_id, read_only FROM tenants WHERE id = $1`, [tenantId]);
  return r.rows[0];
}

function createdEvent(subId: string, customerId: string, tenantId: string, t: number, status = 'active') {
  return {
    id: `evt_p8_cr_${uid()}`,
    type: 'customer.subscription.created',
    created: t,
    data: {
      id: subId,
      status,
      customer: customerId,
      items: { data: [{ price: { id: PRICE_GROWTH } }] },
      metadata: { tenantId },
      current_period_start: t,
      current_period_end: t + 30 * 86400,
    },
  };
}

describe.runIf(HAS_TEST_DB)('Pass#8 billing fixes (H5-H#1, H5-L#1, H1-L-2)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    process.env.STRIPE_PRICE_GROWTH = PRICE_GROWTH;
    registerDefaultBillingHooks();
  }, 60000);
  afterAll(async () => {
    delete process.env.STRIPE_PRICE_GROWTH;
    await app.close();
  });

  test('H5-H#1(a): status-less checkout arriving AFTER subscription.created(active) keeps the live status', async () => {
    const owner = await signupOwner(app);
    const subId = `sub_p8a_${uid()}`;
    const customerId = `cus_p8a_${uid()}`;
    const t1 = nowSec();
    // Real Stripe delivery order: subscription.created (active, full object) first...
    await applyPaymentEvent(createdEvent(subId, customerId, owner.tenantId, t1), query, `evt_p8a_cr_${uid()}`);
    expect((await subRow(owner.tenantId)).status).toBe('active');
    // ...then checkout.session.completed with the UNEXPANDED string id.
    await applyPaymentEvent(
      {
        id: `evt_p8a_co_${uid()}`,
        type: 'checkout.session.completed',
        created: t1 + 10,
        data: {
          metadata: { tenantId: owner.tenantId, planId: 'growth' },
          customer: customerId,
          subscription: subId, // STRING id — the real Stripe path, status unknown
        },
      },
      query,
      `evt_p8a_co_${uid()}`,
    );
    // Pre-fix: the fail-closed write clobbered the row to 'incomplete',
    // stranding the payer (day-15 lockout). Post-fix: the live status stands.
    const sub = await subRow(owner.tenantId);
    expect(sub.status).toBe('active');
    expect(sub.plan_id).toBe('growth');
    const t = await tenantRow(owner.tenantId);
    expect(t.plan_id).toBe('growth');
  });

  test('H5-H#1(b): status-less checkout processed FIRST does not strand the row (watermark exemption)', async () => {
    const owner = await signupOwner(app);
    const subId = `sub_p8b_${uid()}`;
    const customerId = `cus_p8b_${uid()}`;
    const t2 = nowSec();
    // Out-of-order delivery: checkout (newer `created`) is PROCESSED first.
    await applyPaymentEvent(
      {
        id: `evt_p8b_co_${uid()}`,
        type: 'checkout.session.completed',
        created: t2,
        data: {
          metadata: { tenantId: owner.tenantId, planId: 'growth' },
          customer: customerId,
          subscription: subId,
        },
      },
      query,
      `evt_p8b_co_${uid()}`,
    );
    expect((await subRow(owner.tenantId)).status).toBe('incomplete'); // fail-closed, no row to protect
    // The earlier-created subscription.created arrives later. Pre-fix: the
    // checkout had advanced last_event_at to t2, so this older event was
    // dropped as stale and the row stayed 'incomplete' with no self-healing.
    // Post-fix: the status-less checkout never advanced the watermark.
    const t1 = t2 - 30;
    await applyPaymentEvent(createdEvent(subId, customerId, owner.tenantId, t1), query, `evt_p8b_cr_${uid()}`);
    const sub = await subRow(owner.tenantId);
    expect(sub.status).toBe('active');
    expect(sub.plan_id).toBe('growth');
  });

  test('H5-H#1(c): a status-KNOWN checkout (expanded object) still writes normally', async () => {
    const owner = await signupOwner(app);
    const subId = `sub_p8c_${uid()}`;
    const customerId = `cus_p8c_${uid()}`;
    const t1 = nowSec();
    await applyPaymentEvent(createdEvent(subId, customerId, owner.tenantId, t1), query, `evt_p8c_cr_${uid()}`);
    expect((await subRow(owner.tenantId)).status).toBe('active');
    // Expanded subscription object — the true status is known, so the CASE
    // guard must not interfere (statusUnknownCheckout = false).
    await applyPaymentEvent(
      {
        id: `evt_p8c_co_${uid()}`,
        type: 'checkout.session.completed',
        created: t1 + 10,
        data: {
          metadata: { tenantId: owner.tenantId, planId: 'growth' },
          customer: customerId,
          subscription: {
            id: subId,
            status: 'active',
            current_period_start: t1,
            current_period_end: t1 + 30 * 86400,
          },
        },
      },
      query,
      `evt_p8c_co_${uid()}`,
    );
    expect((await subRow(owner.tenantId)).status).toBe('active');
  });

  test('H5-H#1(d): the G5-M#1 never-payer case still fails closed (no live status to protect)', async () => {
    const owner = await signupOwner(app);
    const subId = `sub_p8d_${uid()}`;
    const t1 = nowSec();
    // No prior subscription row at all: the status-less write must still
    // land 'incomplete' — the free-Pro-spend hole stays closed.
    await applyPaymentEvent(
      {
        id: `evt_p8d_co_${uid()}`,
        type: 'checkout.session.completed',
        created: t1,
        data: {
          metadata: { tenantId: owner.tenantId, planId: 'growth' },
          customer: `cus_p8d_${uid()}`,
          subscription: subId,
        },
      },
      query,
      `evt_p8d_co_${uid()}`,
    );
    const sub = await subRow(owner.tenantId);
    expect(sub.status).toBe('incomplete');
    const t = await tenantRow(owner.tenantId);
    expect(t.plan_id).toBe('starter'); // paid plan NOT activated
  });

  test('H5-L#1: concurrent same-charge partial refunds credit the cumulative total exactly once', async () => {
    const owner = await signupOwner(app);
    const chargeId = `ch_p8l1_${uid()}`;
    const t = nowSec();
    // Two partial refunds for the SAME charge, delivered concurrently
    // (distinct event ids — Stripe does this). Pre-fix: both SELECTs could
    // read prev=0 and both insert the full delta → 500 + 1000 = 1500
    // credited against a 1000 actual refund. Post-fix: the serialized
    // statement makes the second see the first's committed credit.
    await Promise.all([
      applyPaymentEvent(
        {
          id: `evt_p8l1_a_${uid()}`,
          type: 'charge.refunded',
          created: t,
          data: { id: chargeId, amount_refunded: 500, metadata: { tenantId: owner.tenantId } },
        },
        query,
        `evt_p8l1_a_${uid()}`,
      ),
      applyPaymentEvent(
        {
          id: `evt_p8l1_b_${uid()}`,
          type: 'charge.refunded',
          created: t,
          data: { id: chargeId, amount_refunded: 1000, metadata: { tenantId: owner.tenantId } },
        },
        query,
        `evt_p8l1_b_${uid()}`,
      ),
    ]);
    const r = await query(
      `SELECT COUNT(*)::int c, COALESCE(SUM(amount_cents), 0)::int s FROM tenant_credits WHERE tenant_id = $1`,
      [owner.tenantId],
    );
    expect(Number(r.rows[0].c)).toBe(2);
    expect(Number(r.rows[0].s)).toBe(1000); // 500 + 500 delta — never 1500
  });

  test('H1-L-2(a): one failed payment produces exactly one dunning email across both event types', async () => {
    const owner = await signupOwner(app);
    await query(`UPDATE tenants SET notify_email = $2 WHERE id = $1`, [
      owner.tenantId,
      `p8l2a-${uid()}@beyo.test`,
    ]);
    const subId = `sub_p8l2a_${uid()}`;
    const customerId = `cus_p8l2a_${uid()}`;
    const t1 = nowSec();
    await applyPaymentEvent(createdEvent(subId, customerId, owner.tenantId, t1), query, `evt_p8l2a_cr_${uid()}`);
    const spy = vi.spyOn(getNotify(), 'sendEmail').mockResolvedValue(undefined);
    try {
      // The failed payment: invoice.payment_failed mints the grace and duns.
      await applyPaymentEvent(
        {
          id: `evt_p8l2a_pf_${uid()}`,
          type: 'invoice.payment_failed',
          created: t1 + 10,
          data: {
            id: `in_p8l2a_${uid()}`,
            customer: customerId,
            subscription: subId,
            amount_due: 2900,
          },
        },
        query,
        `evt_p8l2a_pf_${uid()}`,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      // Stripe also delivers customer.subscription.updated(past_due) for the
      // SAME failure (distinct event id). Pre-fix: identical second email.
      await applyPaymentEvent(
        {
          id: `evt_p8l2a_upd_${uid()}`,
          type: 'customer.subscription.updated',
          created: t1 + 20,
          data: {
            id: subId,
            status: 'past_due',
            customer: customerId,
            items: { data: [{ price: { id: PRICE_GROWTH } }] },
            metadata: { tenantId: owner.tenantId },
          },
        },
        query,
        `evt_p8l2a_upd_${uid()}`,
      );
      // Still exactly one "Payment failed" email for the one failed payment.
      expect(spy).toHaveBeenCalledTimes(1);
      const sub = await subRow(owner.tenantId);
      expect(sub.status).toBe('past_due');
      expect(sub.grace_until).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('H1-L-2(b): a Smart Retry during an active grace sends no further dunning email', async () => {
    const owner = await signupOwner(app);
    await query(`UPDATE tenants SET notify_email = $2 WHERE id = $1`, [
      owner.tenantId,
      `p8l2b-${uid()}@beyo.test`,
    ]);
    const subId = `sub_p8l2b_${uid()}`;
    const customerId = `cus_p8l2b_${uid()}`;
    const t1 = nowSec();
    await applyPaymentEvent(createdEvent(subId, customerId, owner.tenantId, t1), query, `evt_p8l2b_cr_${uid()}`);
    const spy = vi.spyOn(getNotify(), 'sendEmail').mockResolvedValue(undefined);
    try {
      await applyPaymentEvent(
        {
          id: `evt_p8l2b_pf1_${uid()}`,
          type: 'invoice.payment_failed',
          created: t1 + 10,
          data: { id: `in_p8l2b_${uid()}`, customer: customerId, subscription: subId, amount_due: 2900 },
        },
        query,
        `evt_p8l2b_pf1_${uid()}`,
      );
      expect(spy).toHaveBeenCalledTimes(1); // grace minted → one email
      // Stripe Smart Retry, a day later, same episode (distinct event id —
      // the (event_id, type) dedupe never fires). Pre-fix: second email.
      await applyPaymentEvent(
        {
          id: `evt_p8l2b_pf2_${uid()}`,
          type: 'invoice.payment_failed',
          created: t1 + 86400,
          data: { id: `in_p8l2b_${uid()}`, customer: customerId, subscription: subId, amount_due: 2900 },
        },
        query,
        `evt_p8l2b_pf2_${uid()}`,
      );
      expect(spy).toHaveBeenCalledTimes(1); // no second email during grace
    } finally {
      spy.mockRestore();
    }
  });

  test('I1-L-1: concurrent invoice.payment_failed + subscription.updated(past_due) dun exactly once', async () => {
    const owner = await signupOwner(app);
    await query(`UPDATE tenants SET notify_email = $2 WHERE id = $1`, [
      owner.tenantId,
      `p8i1l1-${uid()}@beyo.test`,
    ]);
    const subId = `sub_p8i1l1_${uid()}`;
    const customerId = `cus_p8i1l1_${uid()}`;
    const t1 = nowSec();
    await applyPaymentEvent(createdEvent(subId, customerId, owner.tenantId, t1), query, `evt_p8i1l1_cr_${uid()}`);
    const spy = vi.spyOn(getNotify(), 'sendEmail').mockResolvedValue(undefined);
    try {
      // Both events for the SAME failure, processed concurrently — both
      // read existingGrace=NULL. Pre-fix: both minted and both dunned.
      // Post-fix: exactly one minter (atomic mint), only the minter duns.
      const t2 = t1 + 10;
      await Promise.all([
        applyPaymentEvent(
          {
            id: `evt_p8i1l1_pf_${uid()}`,
            type: 'invoice.payment_failed',
            created: t2,
            data: { id: `in_p8i1l1_${uid()}`, customer: customerId, subscription: subId, amount_due: 2900 },
          },
          query,
          `evt_p8i1l1_pf_${uid()}`,
        ),
        applyPaymentEvent(
          {
            id: `evt_p8i1l1_upd_${uid()}`,
            type: 'customer.subscription.updated',
            created: t2,
            data: {
              id: subId,
              status: 'past_due',
              customer: customerId,
              items: { data: [{ price: { id: PRICE_GROWTH } }] },
              metadata: { tenantId: owner.tenantId },
            },
          },
          query,
          `evt_p8i1l1_upd_${uid()}`,
        ),
      ]);
      expect(spy).toHaveBeenCalledTimes(1);
      const sub = await subRow(owner.tenantId);
      expect(sub.status).toBe('past_due');
      expect(sub.grace_until).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('I1-L-2: a failed minting send is re-dunned once by the next retry, then suppressed', async () => {
    const owner = await signupOwner(app);
    await query(`UPDATE tenants SET notify_email = $2 WHERE id = $1`, [
      owner.tenantId,
      `p8i1l2-${uid()}@beyo.test`,
    ]);
    const subId = `sub_p8i1l2_${uid()}`;
    const customerId = `cus_p8i1l2_${uid()}`;
    const t1 = nowSec();
    await applyPaymentEvent(createdEvent(subId, customerId, owner.tenantId, t1), query, `evt_p8i1l2_cr_${uid()}`);
    const spy = vi
      .spyOn(getNotify(), 'sendEmail')
      .mockRejectedValueOnce(new Error('SMTP transient failure'))
      .mockResolvedValue(undefined);
    try {
      // Mint: the single dunning send fails transiently.
      await applyPaymentEvent(
        {
          id: `evt_p8i1l2_pf1_${uid()}`,
          type: 'invoice.payment_failed',
          created: t1 + 10,
          data: { id: `in_p8i1l2_${uid()}`, customer: customerId, subscription: subId, amount_due: 2900 },
        },
        query,
        `evt_p8i1l2_pf1_${uid()}`,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      // Retry during the grace: the episode has no 'sent' dunning email, so
      // this retry becomes the dunning attempt (at-least-once per episode).
      await applyPaymentEvent(
        {
          id: `evt_p8i1l2_pf2_${uid()}`,
          type: 'invoice.payment_failed',
          created: t1 + 86400,
          data: { id: `in_p8i1l2_${uid()}`, customer: customerId, subscription: subId, amount_due: 2900 },
        },
        query,
        `evt_p8i1l2_pf2_${uid()}`,
      );
      expect(spy).toHaveBeenCalledTimes(2);
      // A further retry: the episode now has its 'sent' email — suppressed.
      await applyPaymentEvent(
        {
          id: `evt_p8i1l2_pf3_${uid()}`,
          type: 'invoice.payment_failed',
          created: t1 + 2 * 86400,
          data: { id: `in_p8i1l2_${uid()}`, customer: customerId, subscription: subId, amount_due: 2900 },
        },
        query,
        `evt_p8i1l2_pf3_${uid()}`,
      );
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  test('I1-L-3: concurrent checkouts create only one in-flight session; expiry releases the claim', async () => {
    const owner = await signupOwner(app);
    const headers = { authorization: `Bearer ${owner.token}` };
    const payload = { planId: 'growth', interval: 'monthly' };
    // Double-click: two overlapping POSTs, no idempotency key.
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/billing/checkout', headers, payload }),
      app.inject({ method: 'POST', url: '/api/v1/billing/checkout', headers, payload }),
    ]);
    const ok = [r1, r2].filter((r) => r.statusCode === 200);
    const conflicts = [r1, r2].filter((r) => r.statusCode === 409);
    // Exactly one winner: either both 200 with the SAME session URL, or one
    // 200 and one 409 CHECKOUT_IN_PROGRESS. Never two distinct sessions.
    expect(ok.length + conflicts.length).toBe(2);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const urls = ok.map((r) => (r.json() as any).url as string);
    if (urls.length === 2) expect(urls[0]).toBe(urls[1]);
    if (conflicts.length === 1) {
      expect(JSON.stringify(conflicts[0].json())).toMatch(/CHECKOUT_IN_PROGRESS/);
    }
    const claims = await query(`SELECT COUNT(*)::int c FROM checkout_sessions WHERE tenant_id = $1`, [
      owner.tenantId,
    ]);
    expect(Number(claims.rows[0].c)).toBe(1);
    // The session expires uncompleted → the claim is released → a fresh
    // checkout is allowed again (no stale block).
    await applyPaymentEvent(
      {
        id: `evt_p8i1l3_exp_${uid()}`,
        type: 'checkout.session.expired',
        created: nowSec(),
        data: { metadata: { tenantId: owner.tenantId } },
      },
      query,
      `evt_p8i1l3_exp_${uid()}`,
    );
    const after = await query(`SELECT COUNT(*)::int c FROM checkout_sessions WHERE tenant_id = $1`, [
      owner.tenantId,
    ]);
    expect(Number(after.rows[0].c)).toBe(0);
    const r3 = await app.inject({ method: 'POST', url: '/api/v1/billing/checkout', headers, payload });
    expect(r3.statusCode).toBe(200);
    expect((r3.json() as any).url).toBeTruthy();
  });

});
