/**
 * Wave-4 Pass #6 regression tests — Fix Worker C (webhooks/routes LOWs).
 *
 * Runs in the `integration` vitest project: real Postgres (DATABASE_URL from
 * env — use your own test DB, never the shared one) + real Redis DB 1.
 *
 * Covers:
 * - F1-L-2: crash-retry reprocessing of checkout.session.completed must not
 *   double-increment the coupon redeemed_count (idempotent redeem on the
 *   webhook event id via coupon_redemptions).
 * - F1-L-3: admin plan override is refused (409 LIVE_STRIPE_SUBSCRIPTION)
 *   while the tenant has a live Stripe subscription, unless force:true.
 * - F2-L-4: a customer.subscription.created/updated event for a NEW sub id
 *   while the tracked row is TERMINAL adopts the new sub id (self-heal);
 *   the E4-H-2 supersede guard still ignores mismatched events when the
 *   tracked row is LIVE.
 */
import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, query, signupOwner, authz } from './helpers.js';
import { applyPaymentEvent } from '../../src/providers/stripe.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');
const uid = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
const nowSec = () => Math.floor(Date.now() / 1000);

async function insertCoupon(code: string, reserved = 1) {
  await query(
    `INSERT INTO billing_coupons (code, percent_off, duration, max_redemptions, active, reserved_count)
     VALUES ($1, 50, 'once', 100, TRUE, $2)
     ON CONFLICT (code) DO UPDATE SET percent_off = 50, duration = 'once',
       max_redemptions = 100, active = TRUE, reserved_count = $2, redeemed_count = 0`,
    [code, reserved],
  );
}

async function couponRow(code: string) {
  const r = await query(`SELECT redeemed_count, reserved_count FROM billing_coupons WHERE code = $1`, [code]);
  return r.rows[0];
}

async function makePlatformAdmin(app: FastifyInstance) {
  const admin = await signupOwner(app);
  await query(`UPDATE users SET is_platform_admin = TRUE WHERE id = $1`, [admin.userId]);
  return admin;
}

describe.runIf(HAS_TEST_DB)('Wave-4 Pass#6 fix worker C (webhooks/routes LOWs)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  test('F1-L-2: reprocessing a crashed checkout.session.completed does not double-redeem the coupon', async () => {
    const owner = await signupOwner(app);
    const code = `F6L2${uid()}`.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    await insertCoupon(code, 1);
    const eventId = `evt_f1l2_${uid()}`;
    const evt: any = {
      id: eventId,
      type: 'checkout.session.completed',
      created: nowSec(),
      data: {
        metadata: { tenantId: owner.tenantId, planId: 'growth', couponCode: code },
        customer: `cus_f1l2_${uid()}`,
        subscription: {
          id: `sub_f1l2_${uid()}`,
          status: 'active',
          current_period_start: nowSec(),
          current_period_end: nowSec() + 86400 * 30,
        },
      },
    };
    // First attempt: processes and redeems.
    await applyPaymentEvent(evt);
    const afterFirst = await couponRow(code);
    expect(Number(afterFirst.redeemed_count)).toBe(1);
    expect(Number(afterFirst.reserved_count)).toBe(0);
    // Simulate the crash: side effects applied, markProcessed never ran.
    await query(`UPDATE stripe_webhook_events SET processed_at = NULL WHERE event_id = $1`, [eventId]);
    // Stripe redelivers (E4-M-2 reprocess path) — the redeem must be skipped.
    const res = await applyPaymentEvent(evt);
    expect(res.deduplicated).toBe(false);
    const afterRetry = await couponRow(code);
    expect(Number(afterRetry.redeemed_count)).toBe(1);
    expect(Number(afterRetry.reserved_count)).toBe(0);
    // The guard row records exactly one redemption for this event.
    const g = await query(`SELECT COUNT(*)::int c FROM coupon_redemptions WHERE event_id = $1`, [eventId]);
    expect(Number(g.rows[0].c)).toBe(1);
  });

  test('F1-L-3: plan override is refused while a live Stripe subscription exists', async () => {
    const admin = await makePlatformAdmin(app);
    const owner = await signupOwner(app);
    const subId = `sub_f1l3_${uid()}`;
    await query(
      `INSERT INTO subscriptions (tenant_id, stripe_customer_id, stripe_sub_id, plan_id, status)
       VALUES ($1, $2, $3, 'growth', 'active')`,
      [owner.tenantId, `cus_f1l3_${uid()}`, subId],
    );
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${owner.tenantId}/plan`,
      headers: authz(admin),
      payload: { planId: 'pro', reason: 'support comp attempt' },
    });
    expect(blocked.statusCode).toBe(409);
    expect((blocked.json() as any).error.code).toBe('LIVE_STRIPE_SUBSCRIPTION');
    // The live subscription row is untouched — nothing was orphaned.
    const row = await query(`SELECT stripe_sub_id, status FROM subscriptions WHERE tenant_id = $1`, [
      owner.tenantId,
    ]);
    expect(row.rows[0].stripe_sub_id).toBe(subId);
    expect(row.rows[0].status).toBe('active');
  });

  test('F1-L-3: force:true overrides despite the live subscription, and canceled subs are not blocked', async () => {
    const admin = await makePlatformAdmin(app);
    // Live sub + explicit force → allowed, and the force is acknowledged.
    const owner = await signupOwner(app);
    await query(
      `INSERT INTO subscriptions (tenant_id, stripe_customer_id, stripe_sub_id, plan_id, status)
       VALUES ($1, $2, $3, 'growth', 'active')`,
      [owner.tenantId, `cus_f1l3f_${uid()}`, `sub_f1l3f_${uid()}`],
    );
    const forced = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${owner.tenantId}/plan`,
      headers: authz(admin),
      payload: { planId: 'pro', reason: 'migration, stripe canceled out-of-band', force: true },
    });
    expect(forced.statusCode).toBe(200);
    const after = await query(`SELECT stripe_sub_id, status, plan_id FROM subscriptions WHERE tenant_id = $1`, [
      owner.tenantId,
    ]);
    expect(after.rows[0].stripe_sub_id).toBeNull();
    expect(after.rows[0].plan_id).toBe('pro');
    // Canceled sub → override without force is fine (nothing live to orphan).
    const owner2 = await signupOwner(app);
    await query(
      `INSERT INTO subscriptions (tenant_id, stripe_customer_id, stripe_sub_id, plan_id, status)
       VALUES ($1, $2, $3, 'growth', 'canceled')`,
      [owner2.tenantId, `cus_f1l3c_${uid()}`, `sub_f1l3c_${uid()}`],
    );
    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${owner2.tenantId}/plan`,
      headers: authz(admin),
      payload: { planId: 'growth', reason: 'comp for churned tenant' },
    });
    expect(ok.statusCode).toBe(200);
  });

  test('F2-L-4: out-of-band replacement subscription is adopted when the tracked row is terminal', async () => {
    const owner = await signupOwner(app);
    const customerId = `cus_f2l4_${uid()}`;
    const oldSub = `sub_old_${uid()}`;
    const newSub = `sub_new_${uid()}`;
    await query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [customerId, owner.tenantId]);
    await query(
      `INSERT INTO subscriptions (tenant_id, stripe_customer_id, stripe_sub_id, plan_id, status)
       VALUES ($1, $2, $3, 'growth', 'canceled')`,
      [owner.tenantId, customerId, oldSub],
    );
    // Support created a replacement subscription in the Stripe dashboard —
    // no checkout.session.completed will ever arrive for it.
    await applyPaymentEvent({
      id: `evt_f2l4_${uid()}`,
      type: 'customer.subscription.created',
      created: nowSec(),
      data: {
        id: newSub,
        status: 'active',
        customer: customerId,
        metadata: { planId: 'growth' },
        current_period_start: nowSec(),
        current_period_end: nowSec() + 86400 * 30,
      },
    } as any);
    const row = await query(`SELECT stripe_sub_id, status, plan_id FROM subscriptions WHERE tenant_id = $1`, [
      owner.tenantId,
    ]);
    expect(row.rows[0].stripe_sub_id).toBe(newSub);
    expect(row.rows[0].status).toBe('active');
    expect(row.rows[0].plan_id).toBe('growth');
    const tenant = await query(`SELECT plan_id, read_only FROM tenants WHERE id = $1`, [owner.tenantId]);
    expect(tenant.rows[0].plan_id).toBe('growth');
  });

  test('F2-L-4: the E4-H-2 supersede guard still ignores stale events for a live tracked sub', async () => {
    const owner = await signupOwner(app);
    const customerId = `cus_f2l4s_${uid()}`;
    const liveSub = `sub_live_${uid()}`;
    const staleSub = `sub_stale_${uid()}`;
    await query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [customerId, owner.tenantId]);
    await query(
      `INSERT INTO subscriptions (tenant_id, stripe_customer_id, stripe_sub_id, plan_id, status)
       VALUES ($1, $2, $3, 'pro', 'active')`,
      [owner.tenantId, customerId, liveSub],
    );
    // A late event for the superseded (dead) subscription must not clobber
    // the live row — e.g. its incomplete_expired.
    await applyPaymentEvent({
      id: `evt_f2l4s_${uid()}`,
      type: 'customer.subscription.updated',
      created: nowSec(),
      data: { id: staleSub, status: 'incomplete_expired', customer: customerId },
    } as any);
    const row = await query(`SELECT stripe_sub_id, status, plan_id FROM subscriptions WHERE tenant_id = $1`, [
      owner.tenantId,
    ]);
    expect(row.rows[0].stripe_sub_id).toBe(liveSub);
    expect(row.rows[0].status).toBe('active');
    expect(row.rows[0].plan_id).toBe('pro');
    // A dead incoming event for a different sub is not adopted either.
    const owner2 = await signupOwner(app);
    const customerId2 = `cus_f2l4d_${uid()}`;
    const oldSub2 = `sub_old2_${uid()}`;
    await query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [customerId2, owner2.tenantId]);
    await query(
      `INSERT INTO subscriptions (tenant_id, stripe_customer_id, stripe_sub_id, plan_id, status)
       VALUES ($1, $2, $3, 'growth', 'canceled')`,
      [owner2.tenantId, customerId2, oldSub2],
    );
    await applyPaymentEvent({
      id: `evt_f2l4d_${uid()}`,
      type: 'customer.subscription.updated',
      created: nowSec(),
      data: { id: `sub_dead_${uid()}`, status: 'canceled', customer: customerId2 },
    } as any);
    const row2 = await query(`SELECT stripe_sub_id, status FROM subscriptions WHERE tenant_id = $1`, [
      owner2.tenantId,
    ]);
    expect(row2.rows[0].stripe_sub_id).toBe(oldSub2);
    expect(row2.rows[0].status).toBe('canceled');
  });
});
