/**
 * Wave-4 Pass#9 regression tests — fixes for the pass#9 hostile-audit findings.
 *
 * - I5-M#1 (MEDIUM): customer.subscription.updated must NOT re-mint a grace
 *   after downgradeTenant consumed it (mirror D1-H-1) — otherwise every
 *   routine post-downgrade updated event restarts the dunning cycle
 *   indefinitely (fresh grace + dunning email → re-downgrade → repeat).
 * - I5-L#1 (LOW): invoice.paid recovery for past_due/incomplete now verifies
 *   the invoice belongs to the tracked subscription (like the canceled
 *   branch) — a one-off/second-subscription invoice can't flip the row.
 * - I2-L#1 (LOW): reportProcessor notifies only when THIS attempt inserted
 *   the report row — the ON CONFLICT loser no longer sends a duplicate
 *   weekly email + Telegram.
 * - I2-L#2 (LOW): PageSpeed quota is now an atomic claim — concurrent
 *   claimants can't overshoot, and failed fetches never burn quota.
 *
 * Runs in the `integration` vitest project: real Postgres (DATABASE_URL from
 * env) + real Redis DB 1.
 */
import { beforeAll, afterAll, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, createSite, query, signupOwner } from './helpers.js';
import { resetDb } from '../integration/helpers/db.js';
import { applyPaymentEvent } from '../../src/providers/stripe.js';
import { downgradeTenant, registerDefaultBillingHooks } from '../../src/services/billing.js';
import { getNotify } from '../../src/providers/notify.js';
import { reportProcessor } from '../../src/services/reportJobs.js';
import { claimQuotaSlot } from '../../src/services/pagespeed.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');
const uid = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const PRICE_GROWTH = `price_p9_growth_${uid()}`;

async function subRow(tenantId: string) {
  const r = await query(
    `SELECT status, plan_id, stripe_sub_id, grace_until FROM subscriptions WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0];
}

function createdEvent(subId: string, customerId: string, tenantId: string, t: number, status = 'active') {
  return {
    id: `evt_p9_cr_${uid()}`,
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

describe.runIf(HAS_TEST_DB)('Pass#9 fixes (I5-M#1, I5-L#1, I2-L#1, I2-L#2)', () => {
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

  test('I5-M#1: subscription.updated after a consumed grace does not re-mint or re-dun', async () => {
    const owner = await signupOwner(app);
    await query(`UPDATE tenants SET notify_email = $2 WHERE id = $1`, [
      owner.tenantId,
      `p9m1-${uid()}@beyo.test`,
    ]);
    const subId = `sub_p9m1_${uid()}`;
    const customerId = `cus_p9m1_${uid()}`;
    const t1 = nowSec();
    await applyPaymentEvent(createdEvent(subId, customerId, owner.tenantId, t1), query, `evt_p9m1_cr_${uid()}`);
    const spy = vi.spyOn(getNotify(), 'sendEmail').mockResolvedValue(undefined);
    try {
      // Episode 1: payment fails → grace minted + dunning email #1.
      await applyPaymentEvent(
        {
          id: `evt_p9m1_pf_${uid()}`,
          type: 'invoice.payment_failed',
          created: t1 + 10,
          data: { id: `in_p9m1_${uid()}`, customer: customerId, subscription: subId, amount_due: 2900 },
        },
        query,
        `evt_p9m1_pf_${uid()}`,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await subRow(owner.tenantId)).grace_until).not.toBeNull();
      // Grace expires → downgrade consumes it (plan → starter, grace NULL,
      // "downgraded" email #2).
      await downgradeTenant(owner.tenantId, 'grace_expired', query, { subscriptionStatus: 'past_due' });
      expect(spy).toHaveBeenCalledTimes(2);
      const afterDowngrade = await subRow(owner.tenantId);
      expect(afterDowngrade.status).toBe('past_due');
      expect(afterDowngrade.grace_until).toBeNull();
      // A routine subscription.updated(past_due) after the downgrade (portal
      // payment-method update, invoice finalization, ...). Pre-fix: minted
      // a fresh 3-day grace + dunning email #3, restarting the cycle.
      await applyPaymentEvent(
        {
          id: `evt_p9m1_upd_${uid()}`,
          type: 'customer.subscription.updated',
          created: t1 + 4 * 86400,
          data: {
            id: subId,
            status: 'past_due',
            customer: customerId,
            items: { data: [{ price: { id: PRICE_GROWTH } }] },
            metadata: { tenantId: owner.tenantId },
          },
        },
        query,
        `evt_p9m1_upd_${uid()}`,
      );
      expect(spy).toHaveBeenCalledTimes(2); // no dunning resurrection
      const after = await subRow(owner.tenantId);
      expect(after.grace_until).toBeNull(); // no fresh grace
      expect(after.status).toBe('past_due');
    } finally {
      spy.mockRestore();
    }
  });

  test('I5-M#1: a genuine first failure still mints (stored status active)', async () => {
    const owner = await signupOwner(app);
    await query(`UPDATE tenants SET notify_email = $2 WHERE id = $1`, [
      owner.tenantId,
      `p9m1b-${uid()}@beyo.test`,
    ]);
    const subId = `sub_p9m1b_${uid()}`;
    const customerId = `cus_p9m1b_${uid()}`;
    const t1 = nowSec();
    await applyPaymentEvent(createdEvent(subId, customerId, owner.tenantId, t1), query, `evt_p9m1b_cr_${uid()}`);
    const spy = vi.spyOn(getNotify(), 'sendEmail').mockResolvedValue(undefined);
    try {
      // First failure on an ACTIVE subscription: grace must still mint.
      await applyPaymentEvent(
        {
          id: `evt_p9m1b_upd_${uid()}`,
          type: 'customer.subscription.updated',
          created: t1 + 10,
          data: {
            id: subId,
            status: 'past_due',
            customer: customerId,
            items: { data: [{ price: { id: PRICE_GROWTH } }] },
            metadata: { tenantId: owner.tenantId },
          },
        },
        query,
        `evt_p9m1b_upd_${uid()}`,
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await subRow(owner.tenantId)).grace_until).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  test('I5-L#1: invoice.paid for a DIFFERENT subscription does not revive the tracked row', async () => {
    const owner = await signupOwner(app);
    const subId = `sub_p9l1_${uid()}`;
    const customerId = `cus_p9l1_${uid()}`;
    const t1 = nowSec();
    await applyPaymentEvent(createdEvent(subId, customerId, owner.tenantId, t1), query, `evt_p9l1_cr_${uid()}`);
    // Put the tracked subscription into past_due.
    await applyPaymentEvent(
      {
        id: `evt_p9l1_pf_${uid()}`,
        type: 'invoice.payment_failed',
        created: t1 + 10,
        data: { id: `in_p9l1_${uid()}`, customer: customerId, subscription: subId, amount_due: 2900 },
      },
      query,
      `evt_p9l1_pf_${uid()}`,
    );
    expect((await subRow(owner.tenantId)).status).toBe('past_due');
    // A paid invoice for a DIFFERENT subscription (one-off / out-of-band).
    // Pre-fix: flipped the row to 'active' with the wrong plan while
    // stripe_sub_id still tracked the old subscription.
    await applyPaymentEvent(
      {
        id: `evt_p9l1_paid_${uid()}`,
        type: 'invoice.paid',
        created: t1 + 20,
        data: {
          id: `in_p9l1_paid_${uid()}`,
          customer: customerId,
          subscription: `sub_p9l1_other_${uid()}`,
          amount_paid: 2900,
          metadata: { tenantId: owner.tenantId },
          lines: { data: [{ price: { id: PRICE_GROWTH } }] },
        },
      },
      query,
      `evt_p9l1_paid_${uid()}`,
    );
    const sub = await subRow(owner.tenantId);
    expect(sub.status).toBe('past_due'); // NOT revived
    expect(sub.stripe_sub_id).toBe(subId); // still tracking the real sub
  });

  test('I2-L-1: concurrent report jobs notify exactly once (loser stays silent)', async () => {
    const owner = await signupOwner(app);
    const siteId = await createSite(app, owner);
    await query(`UPDATE tenants SET notify_email = $2, telegram_chat_id = $3 WHERE id = $1`, [
      owner.tenantId,
      `p9l1-${uid()}@beyo.test`,
      `tg_p9l1_${uid()}`,
    ]);
    const emailSpy = vi.spyOn(getNotify(), 'sendEmail').mockResolvedValue(undefined);
    const tgSpy = vi.spyOn(getNotify(), 'sendTelegram').mockResolvedValue(undefined);
    try {
      // Scheduler tick racing a manual "Generate" — both pass the early
      // SELECT, both INSERT (one wins). Pre-fix: both notified.
      const [r1, r2] = await Promise.all([
        reportProcessor({ data: { siteId, tenantId: owner.tenantId } } as any),
        reportProcessor({ data: { siteId, tenantId: owner.tenantId } } as any),
      ]);
      expect((r1 as any).reportId).toBe((r2 as any).reportId);
      expect(emailSpy).toHaveBeenCalledTimes(1);
      expect(tgSpy).toHaveBeenCalledTimes(1);
    } finally {
      emailSpy.mockRestore();
      tgSpy.mockRestore();
    }
  });

  test('I2-L-2: PageSpeed quota claims are atomic — no overshoot under concurrency', async () => {
    const key = `test_ps_${uid()}`;
    // Sequential: exactly `quota` claims succeed, then denial.
    expect(await claimQuotaSlot(query, key, 2)).toBe(true);
    expect(await claimQuotaSlot(query, key, 2)).toBe(true);
    expect(await claimQuotaSlot(query, key, 2)).toBe(false);
    // Concurrent: 5 racers, quota 3 → exactly 3 winners, count never exceeds 3.
    const key2 = `test_ps2_${uid()}`;
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => claimQuotaSlot(query, key2, 3)));
    expect(results.filter(Boolean).length).toBe(3);
    const r = await query(`SELECT count FROM daily_quotas WHERE quota_key = $1 AND day = CURRENT_DATE`, [key2]);
    expect(Number(r.rows[0].count)).toBe(3);
  });
});
