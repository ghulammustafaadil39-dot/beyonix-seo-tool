/**
 * Wave-4 Pass#10 regression tests — fixes for the pass#10 hostile-audit findings.
 *
 * - J3-M-1 (MEDIUM): ?success=1 no longer promises an active plan before the
 *   subscription is fetched (frontend; verified via tsc + build — no
 *   frontend test runner in this repo).
 * - J5-LOW-1: a $0 invoice.paid must NOT revive a consumed-grace past_due
 *   row to paid 'active' (paid limits without paying); the 'incomplete' +
 *   100%-off-coupon $0 path is preserved.
 * - J5-LOW-2: the same-URL idempotent checkout return releases the coupon
 *   reservation it just made (no permanently-burned cap slot).
 * - J1-LOW-1: the checkout-claim steal is status-aware — a live 'open'
 *   claim is never stolen (409/URL-reuse); only stale 'creating' (>10 min)
 *   or ancient 'open' (>25h, session definitively expired) claims are.
 * - J2-LOW-2: checkout.session.completed/expired release the claim scoped
 *   to the completing session id (mock NULL falls back to tenant-wide).
 * - J1-LOW-2 / J2-LOW-4: the no-row invoice.payment_failed "vacuous" dun is
 *   visible to the later customer.subscription.updated minter via
 *   episodeDunningSent — one email per failure, not two.
 * - J2-LOW-3: enqueueDeduped claims with a short TTL and extends after a
 *   successful enqueue (a crash between claim and Queue.add self-heals in
 *   60s, not the full window).
 *
 * Runs in the `integration` vitest project: real Postgres (DATABASE_URL from
 * env) + real Redis.
 */
import { beforeAll, afterAll, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, query, signupOwner } from './helpers.js';
import { resetDb } from '../integration/helpers/db.js';
import { applyPaymentEvent } from '../../src/providers/stripe.js';
import { downgradeTenant, registerDefaultBillingHooks } from '../../src/services/billing.js';
import { getNotify } from '../../src/providers/notify.js';
import { enqueueDeduped } from '../../src/queues.js';
import { getRedis, redisKeyPrefix } from '../../src/redis.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');
const uid = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const PRICE_GROWTH = `price_p10_growth_${uid()}`;

async function subRow(tenantId: string) {
  const r = await query(
    `SELECT status, plan_id, stripe_sub_id, grace_until FROM subscriptions WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0];
}

function paidInvoiceEvent(subId: string, customerId: string, tenantId: string, amountPaid: number) {
  return {
    id: `evt_p10_paid_${uid()}`,
    type: 'invoice.paid',
    created: nowSec(),
    data: {
      id: `in_p10_${uid()}`,
      customer: customerId,
      subscription: subId,
      amount_paid: amountPaid,
      amount_due: 0,
      total: amountPaid,
      currency: 'usd',
      lines: { data: [{ price: { id: PRICE_GROWTH } }] },
      metadata: { tenantId },
    },
  };
}

describe.runIf(HAS_TEST_DB)('Pass#10 fixes', () => {
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

  test('J5-LOW-1: $0 invoice.paid does NOT revive consumed-grace past_due; positive does; $0 still revives incomplete', async () => {
    const mkPastDueConsumed = async () => {
      const owner = await signupOwner(app);
      const subId = `sub_p10_${uid()}`;
      const customerId = `cus_p10_${uid()}`;
      // Active subscription, then a failure mints grace, then downgrade consumes it.
      await applyPaymentEvent(
        {
          id: `evt_p10_cr_${uid()}`,
          type: 'customer.subscription.created',
          created: nowSec(),
          data: {
            id: subId,
            status: 'active',
            customer: customerId,
            items: { data: [{ price: { id: PRICE_GROWTH } }] },
            metadata: { tenantId: owner.tenantId },
          },
        },
        query,
        `evt_p10_cr_${uid()}`,
      );
      await applyPaymentEvent(
        {
          id: `evt_p10_pf_${uid()}`,
          type: 'invoice.payment_failed',
          created: nowSec(),
          data: { id: `in_p10f_${uid()}`, customer: customerId, subscription: subId, amount_due: 2900 },
        },
        query,
        `evt_p10_pf_${uid()}`,
      );
      await downgradeTenant(owner.tenantId, 'grace_expired', query, { subscriptionStatus: 'past_due' });
      const r = await subRow(owner.tenantId);
      expect(r.status).toBe('past_due');
      expect(r.grace_until).toBeNull();
      return { owner, subId, customerId };
    };

    // $0 proration invoice on consumed-grace past_due → NO revival.
    {
      const { owner, subId, customerId } = await mkPastDueConsumed();
      await applyPaymentEvent(paidInvoiceEvent(subId, customerId, owner.tenantId, 0), query, `evt_p10_z_${uid()}`);
      const r = await subRow(owner.tenantId);
      expect(r.status).toBe('past_due');
    }
    // Positive payment on past_due → revival (existing behavior preserved).
    {
      const { owner, subId, customerId } = await mkPastDueConsumed();
      await applyPaymentEvent(paidInvoiceEvent(subId, customerId, owner.tenantId, 2900), query, `evt_p10_p_${uid()}`);
      const r = await subRow(owner.tenantId);
      expect(r.status).toBe('active');
    }
    // $0 first invoice on 'incomplete' (100%-off coupon) → still revives.
    {
      const owner = await signupOwner(app);
      const subId = `sub_p10i_${uid()}`;
      const customerId = `cus_p10i_${uid()}`;
      await query(
        `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, plan_id, status)
         VALUES (gen_random_uuid(), $1, $2, 'growth', 'incomplete')`,
        [owner.tenantId, subId],
      );
      await applyPaymentEvent(paidInvoiceEvent(subId, customerId, owner.tenantId, 0), query, `evt_p10_i_${uid()}`);
      const r = await subRow(owner.tenantId);
      expect(r.status).toBe('active');
    }
  });

  test('J5-LOW-2: same-URL idempotent checkout return releases the coupon reservation', async () => {
    const owner = await signupOwner(app);
    const headers = { authorization: `Bearer ${owner.token}` };
    const code = `P10${uid().toUpperCase().slice(0, 8)}`;
    await query(
      `INSERT INTO billing_coupons (code, percent_off, duration, active, max_redemptions)
       VALUES ($1, 20, 'once', TRUE, 5)`,
      [code],
    );
    const payload = { planId: 'growth', interval: 'monthly', couponCode: code };
    const r1 = await app.inject({ method: 'POST', url: '/api/v1/billing/checkout', headers, payload });
    expect(r1.statusCode).toBe(200);
    const url1 = (r1.json() as any).url as string;
    expect(url1).toBeTruthy();
    let c = await query(`SELECT reserved_count FROM billing_coupons WHERE code = $1`, [code]);
    expect(Number(c.rows[0].reserved_count)).toBe(1);
    // Double-click: second POST reuses the open session's URL.
    const r2 = await app.inject({ method: 'POST', url: '/api/v1/billing/checkout', headers, payload });
    expect(r2.statusCode).toBe(200);
    expect((r2.json() as any).url).toBe(url1);
    // The second reservation was released — still exactly 1, not 2.
    c = await query(`SELECT reserved_count FROM billing_coupons WHERE code = $1`, [code]);
    expect(Number(c.rows[0].reserved_count)).toBe(1);
  });

  test('J1-LOW-1: live open claim is never stolen; stale creating and ancient open claims are', async () => {
    const post = (owner: { token: string }) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/billing/checkout',
        headers: { authorization: `Bearer ${owner.token}` },
        payload: { planId: 'growth', interval: 'monthly' },
      });

    // Case A: 'open' claim abandoned 11 min ago (Stripe session still live
    // for ~24h) → NOT stolen: 409 or same-URL reuse, no new session.
    {
      const owner = await signupOwner(app);
      const r1 = await post(owner);
      expect(r1.statusCode).toBe(200);
      const url1 = (r1.json() as any).url as string;
      await query(
        `UPDATE checkout_sessions SET created_at = now() - interval '11 minutes' WHERE tenant_id = $1`,
        [owner.tenantId],
      );
      const r2 = await post(owner);
      // Either the same URL (plan/interval match) or 409 — never a second session.
      if (r2.statusCode === 200) {
        expect((r2.json() as any).url).toBe(url1);
      } else {
        expect(r2.statusCode).toBe(409);
        expect(JSON.stringify(r2.json())).toMatch(/CHECKOUT_IN_PROGRESS/);
      }
      const n = await query(`SELECT COUNT(*)::int c FROM checkout_sessions WHERE tenant_id = $1`, [owner.tenantId]);
      expect(Number(n.rows[0].c)).toBe(1);
    }
    // Case B: stale 'creating' claim (>10 min, creator crashed) → stolen.
    {
      const owner = await signupOwner(app);
      await query(
        `INSERT INTO checkout_sessions (tenant_id, plan_id, billing_interval, status, created_at)
         VALUES ($1, 'growth', 'monthly', 'creating', now() - interval '11 minutes')`,
        [owner.tenantId],
      );
      const r = await post(owner);
      expect(r.statusCode).toBe(200);
      expect((r.json() as any).url).toBeTruthy();
    }
    // Case C: 'open' claim older than 25h (session definitively expired,
    // expired webhook lost) → stolen, checkout unblocked.
    {
      const owner = await signupOwner(app);
      await query(
        `INSERT INTO checkout_sessions (tenant_id, plan_id, billing_interval, status, stripe_session_id, checkout_url, created_at)
         VALUES ($1, 'growth', 'monthly', 'open', 'cs_ancient', 'https://checkout.test/ancient', now() - interval '26 hours')`,
        [owner.tenantId],
      );
      const r = await post(owner);
      expect(r.statusCode).toBe(200);
      expect((r.json() as any).url).not.toBe('https://checkout.test/ancient');
    }
  });

  test('J2-LOW-2: checkout.session.completed releases only the completing session claim', async () => {
    const owner = await signupOwner(app);
    // A newer claim for session B exists (e.g. after a steal).
    await query(
      `INSERT INTO checkout_sessions (tenant_id, plan_id, billing_interval, status, stripe_session_id, checkout_url)
       VALUES ($1, 'growth', 'monthly', 'open', 'cs_B_new', 'https://checkout.test/B')`,
      [owner.tenantId],
    );
    // Session A (older, different id) completes → must NOT wipe B's claim.
    await applyPaymentEvent(
      {
        id: `evt_p10_csc_${uid()}`,
        type: 'checkout.session.completed',
        created: nowSec(),
        data: {
          id: 'cs_A_old',
          metadata: { tenantId: owner.tenantId, planId: 'growth', interval: 'monthly' },
          customer: `cus_p10c_${uid()}`,
          subscription: `sub_mock_p10c_${uid()}`,
        },
      },
      query,
      `evt_p10_csc_${uid()}`,
    );
    const r = await query(`SELECT stripe_session_id FROM checkout_sessions WHERE tenant_id = $1`, [owner.tenantId]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].stripe_session_id).toBe('cs_B_new');
    // And the completing session's own claim IS released.
    await query(`DELETE FROM checkout_sessions WHERE tenant_id = $1`, [owner.tenantId]);
    await query(
      `INSERT INTO checkout_sessions (tenant_id, plan_id, billing_interval, status, stripe_session_id, checkout_url)
       VALUES ($1, 'growth', 'monthly', 'open', 'cs_C_own', 'https://checkout.test/C')`,
      [owner.tenantId],
    );
    await applyPaymentEvent(
      {
        id: `evt_p10_csc2_${uid()}`,
        type: 'checkout.session.completed',
        created: nowSec(),
        data: {
          id: 'cs_C_own',
          metadata: { tenantId: owner.tenantId, planId: 'growth', interval: 'monthly' },
          customer: `cus_p10c2_${uid()}`,
          subscription: `sub_mock_p10c2_${uid()}`,
        },
      },
      query,
      `evt_p10_csc2_${uid()}`,
    );
    const r2 = await query(`SELECT COUNT(*)::int c FROM checkout_sessions WHERE tenant_id = $1`, [owner.tenantId]);
    expect(Number(r2.rows[0].c)).toBe(0);
  });

  test('J1-LOW-2/J2-LOW-4: no-row payment_failed vacuous dun + later updated mint = exactly one email', async () => {
    const owner = await signupOwner(app);
    await query(`UPDATE tenants SET notify_email = $2 WHERE id = $1`, [owner.tenantId, owner.email]);
    const subId = `sub_p10v_${uid()}`;
    const customerId = `cus_p10v_${uid()}`;
    const t = nowSec();
    const spy = vi.spyOn(getNotify(), 'sendEmail').mockResolvedValue(undefined);
    try {
      // payment_failed arrives FIRST with no subscription row (out-of-order
      // delivery) → vacuous dun, exactly one email, nothing minted.
      await applyPaymentEvent(
        {
          id: `evt_p10v_pf_${uid()}`,
          type: 'invoice.payment_failed',
          created: t,
          data: {
            id: `in_p10v_${uid()}`,
            customer: customerId,
            subscription: subId,
            amount_due: 2900,
            metadata: { tenantId: owner.tenantId },
          },
        },
        query,
        `evt_p10v_pf_${uid()}`,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await subRow(owner.tenantId)).toBeUndefined();
      // The subscription event arrives later and really mints the grace —
      // pre-fix it dunned a second time (identical email).
      await applyPaymentEvent(
        {
          id: `evt_p10v_upd_${uid()}`,
          type: 'customer.subscription.updated',
          created: t + 5,
          data: {
            id: subId,
            status: 'past_due',
            customer: customerId,
            items: { data: [{ price: { id: PRICE_GROWTH } }] },
            metadata: { tenantId: owner.tenantId },
          },
        },
        query,
        `evt_p10v_upd_${uid()}`,
      );
      const r = await subRow(owner.tenantId);
      expect(r.grace_until).not.toBeNull(); // the mint happened
      expect(spy).toHaveBeenCalledTimes(1); // but no second dun
    } finally {
      spy.mockRestore();
    }
  });

  test('J2-LOW-3: enqueueDeduped extends the short claim TTL after a successful enqueue', async () => {
    const redis = getRedis();
    const key = `p10-dedup-${uid()}`;
    const mapKey = `${redisKeyPrefix()}dedup:${key}`;
    // Use a 70s window so the "short claim" (60s) vs "extended" (>60s)
    // distinction is observable.
    const r1 = await enqueueDeduped('reports', 'generate', { siteId: 'x' }, key, 70);
    expect(r1.deduplicated).toBe(false);
    const ttl = await redis.ttl(mapKey);
    // Extended to the full window (70s), not left at the 60s short-claim.
    expect(ttl).toBeGreaterThan(60);
    expect(ttl).toBeLessThanOrEqual(70);
    const r2 = await enqueueDeduped('reports', 'generate', { siteId: 'x' }, key, 70);
    expect(r2.deduplicated).toBe(true);
    await redis.del(mapKey).catch(() => {});
  });
});
