/**
 * Wave-4 Pass#7 regression tests — Pass7 Billing Fix Worker.
 *
 * Runs in the `integration` vitest project: real Postgres (DATABASE_URL from
 * env — use your own test DB, never the shared one) + real Redis DB 1.
 *
 * Covers:
 * - G5-M#1: checkout.session.completed with an UNEXPANDED string
 *   subscription id (the real Stripe path — Stripe never expands it) fails
 *   CLOSED to 'incomplete' instead of recording 'active' and clobbering a
 *   correct 'incomplete' row written by customer.subscription.created.
 * - G5-M#2: invoice.paid recovery from past_due restores plan_id on both
 *   rows and recomputes read_only (mirrors the canceled-revival branch).
 * - G5-L#1: charge.refunded credits only the DELTA over already-credited
 *   amounts for the same charge (amount_refunded is cumulative).
 * - G1-L-1: a reprocessed (E4-M-2 crash-retry) webhook event sends each
 *   customer lifecycle email exactly once (dedupe on (event_id, type)).
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
const PRICE_GROWTH = `price_p7_growth_${uid()}`;

async function subRow(tenantId: string) {
  const r = await query(
    `SELECT status, plan_id, stripe_sub_id, grace_until FROM subscriptions WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0];
}

async function tenantRow(tenantId: string) {
  const r = await query(`SELECT plan_id, read_only FROM tenants WHERE id = $1`, [tenantId]);
  return r.rows[0];
}

describe.runIf(HAS_TEST_DB)('Pass#7 billing fixes (G5-M#1, G5-M#2, G5-L#1, G1-L-1)', () => {
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

  test('G5-M#1(i): checkout.completed with a string subscription id fails closed to incomplete', async () => {
    const owner = await signupOwner(app);
    const subId = `sub_p7m1_${uid()}`;
    const evtId = `evt_p7m1_co_${uid()}`;
    await applyPaymentEvent(
      {
        id: evtId,
        type: 'checkout.session.completed',
        created: nowSec(),
        data: {
          metadata: { tenantId: owner.tenantId, planId: 'growth' },
          customer: `cus_p7m1_${uid()}`,
          subscription: subId, // STRING id — the real Stripe path
        },
      },
      query,
      evtId,
    );
    const sub = await subRow(owner.tenantId);
    expect(sub.status).toBe('incomplete');
    // No paid limits: the tenant plan is NOT activated.
    const t = await tenantRow(owner.tenantId);
    expect(t.plan_id).toBe('starter');
  });

  test('G5-M#1(ii): a later subscription.created(active) flips the fail-closed row to active', async () => {
    const owner = await signupOwner(app);
    const subId = `sub_p7m1b_${uid()}`;
    const customerId = `cus_p7m1b_${uid()}`;
    const t1 = nowSec();
    await applyPaymentEvent(
      {
        id: `evt_p7m1b_co_${uid()}`,
        type: 'checkout.session.completed',
        created: t1,
        data: {
          metadata: { tenantId: owner.tenantId, planId: 'growth' },
          customer: customerId,
          subscription: subId,
        },
      },
      query,
      `evt_p7m1b_co_${uid()}`,
    );
    expect((await subRow(owner.tenantId)).status).toBe('incomplete');
    // Stripe delivers customer.subscription.created with the full object.
    await applyPaymentEvent(
      {
        id: `evt_p7m1b_cr_${uid()}`,
        type: 'customer.subscription.created',
        created: t1 + 5,
        data: {
          id: subId,
          status: 'active',
          customer: customerId,
          items: { data: [{ price: { id: PRICE_GROWTH } }] },
          metadata: { tenantId: owner.tenantId },
          current_period_start: t1,
          current_period_end: t1 + 30 * 86400,
        },
      },
      query,
      `evt_p7m1b_cr_${uid()}`,
    );
    const sub = await subRow(owner.tenantId);
    expect(sub.status).toBe('active');
    const t = await tenantRow(owner.tenantId);
    expect(t.plan_id).toBe('growth');
  });

  test('G5-M#1(iii): mock path (no subscription at all) is still treated as paid', async () => {
    const owner = await signupOwner(app);
    const evtId = `evt_p7m1c_co_${uid()}`;
    await applyPaymentEvent(
      {
        id: evtId,
        type: 'checkout.session.completed',
        created: nowSec(),
        data: {
          metadata: { tenantId: owner.tenantId, planId: 'growth' },
          customer: `cus_p7m1c_${uid()}`,
          // no subscription key — mock completions carry none
        },
      },
      query,
      evtId,
    );
    const sub = await subRow(owner.tenantId);
    expect(sub.status).toBe('active');
    const t = await tenantRow(owner.tenantId);
    expect(t.plan_id).toBe('growth');
  });

  test('G5-M#1(iv): pre-existing incomplete row is not clobbered by the string-id checkout event', async () => {
    const owner = await signupOwner(app);
    const subId = `sub_p7m1d_${uid()}`;
    const customerId = `cus_p7m1d_${uid()}`;
    const t1 = nowSec();
    // The earlier customer.subscription.created(incomplete) writes the
    // correct row: status 'incomplete' + a grace period.
    await applyPaymentEvent(
      {
        id: `evt_p7m1d_cr_${uid()}`,
        type: 'customer.subscription.created',
        created: t1,
        data: {
          id: subId,
          status: 'incomplete',
          customer: customerId,
          items: { data: [{ price: { id: PRICE_GROWTH } }] },
          metadata: { tenantId: owner.tenantId },
          current_period_start: t1,
          current_period_end: t1 + 30 * 86400,
        },
      },
      query,
      `evt_p7m1d_cr_${uid()}`,
    );
    const before = await subRow(owner.tenantId);
    expect(before.status).toBe('incomplete');
    expect(before.grace_until).not.toBeNull();
    const graceBefore = new Date(before.grace_until).getTime();
    // checkout.session.completed arrives LATER (newer created — the C-01
    // stale guard does not drop it) with the unexpanded string id.
    await applyPaymentEvent(
      {
        id: `evt_p7m1d_co_${uid()}`,
        type: 'checkout.session.completed',
        created: t1 + 10,
        data: {
          metadata: { tenantId: owner.tenantId, planId: 'growth' },
          customer: customerId,
          subscription: subId,
        },
      },
      query,
      `evt_p7m1d_co_${uid()}`,
    );
    const after = await subRow(owner.tenantId);
    expect(after.status).toBe('incomplete'); // NOT clobbered to 'active'
    expect(after.grace_until).not.toBeNull(); // grace NOT wiped
    expect(new Date(after.grace_until).getTime()).toBe(graceBefore);
    const t = await tenantRow(owner.tenantId);
    expect(t.plan_id).toBe('starter'); // paid plan NOT activated
  });

  test('G5-M#2: invoice.paid recovery from past_due restores plan and clears read_only', async () => {
    const owner = await signupOwner(app);
    const subId = `sub_p7m2_${uid()}`;
    // Post-grace-expiry state: subscription past_due, product downgraded to
    // starter + read_only.
    await query(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, stripe_customer_id, plan_id, status, grace_until)
       VALUES (gen_random_uuid(), $1, $2, $3, 'growth', 'past_due', NULL)`,
      [owner.tenantId, subId, `cus_p7m2_${uid()}`],
    );
    await query(`UPDATE tenants SET plan_id = 'starter', read_only = TRUE WHERE id = $1`, [owner.tenantId]);
    const evtId = `evt_p7m2_paid_${uid()}`;
    await applyPaymentEvent(
      {
        id: evtId,
        type: 'invoice.paid',
        created: nowSec(),
        data: {
          id: `in_p7m2_${uid()}`,
          customer: `cus_p7m2_${uid()}`,
          subscription: subId,
          amount_paid: 2900,
          currency: 'usd',
          lines: { data: [{ price: { id: PRICE_GROWTH } }] },
          metadata: { tenantId: owner.tenantId },
        },
      },
      query,
      evtId,
    );
    const sub = await subRow(owner.tenantId);
    expect(sub.status).toBe('active');
    expect(sub.plan_id).toBe('growth');
    const t = await tenantRow(owner.tenantId);
    expect(t.plan_id).toBe('growth');
    expect(t.read_only).toBe(false);
  });

  test('G5-M#2: no resolvable plan on the invoice keeps the old status-flip-only behavior', async () => {
    const owner = await signupOwner(app);
    const subId = `sub_p7m2b_${uid()}`;
    await query(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, plan_id, status, grace_until)
       VALUES (gen_random_uuid(), $1, $2, 'growth', 'past_due', NULL)`,
      [owner.tenantId, subId],
    );
    const evtId = `evt_p7m2b_paid_${uid()}`;
    await applyPaymentEvent(
      {
        id: evtId,
        type: 'invoice.paid',
        created: nowSec(),
        data: {
          id: `in_p7m2b_${uid()}`,
          subscription: subId,
          amount_paid: 2900,
          currency: 'usd',
          // no lines price, no metadata planId → unresolvable
          metadata: { tenantId: owner.tenantId },
        },
      },
      query,
      evtId,
    );
    const sub = await subRow(owner.tenantId);
    expect(sub.status).toBe('active'); // status revived...
    expect(sub.plan_id).toBe('growth'); // ...plan kept, not guessed
    const t = await tenantRow(owner.tenantId);
    expect(t.plan_id).toBe('starter'); // tenants.plan_id untouched
  });

  test('G5-L#1: two partial refunds credit the delta, not the cumulative total twice', async () => {
    const owner = await signupOwner(app);
    const chargeId = `ch_p7l1_${uid()}`;
    // First partial refund: $5 of a $20 charge.
    await applyPaymentEvent(
      {
        id: `evt_p7l1_a_${uid()}`,
        type: 'charge.refunded',
        created: nowSec(),
        data: { id: chargeId, amount_refunded: 500, metadata: { tenantId: owner.tenantId } },
      },
      query,
      `evt_p7l1_a_${uid()}`,
    );
    // Second partial refund: cumulative amount_refunded is now $15.
    await applyPaymentEvent(
      {
        id: `evt_p7l1_b_${uid()}`,
        type: 'charge.refunded',
        created: nowSec(),
        data: { id: chargeId, amount_refunded: 1500, metadata: { tenantId: owner.tenantId } },
      },
      query,
      `evt_p7l1_b_${uid()}`,
    );
    const r = await query(
      `SELECT COUNT(*)::int c, COALESCE(SUM(amount_cents), 0)::int s FROM tenant_credits WHERE tenant_id = $1`,
      [owner.tenantId],
    );
    expect(Number(r.rows[0].c)).toBe(2);
    expect(Number(r.rows[0].s)).toBe(1500); // 500 + 1000 delta, NOT 500 + 1500
    // A third event with the same cumulative total credits nothing new.
    await applyPaymentEvent(
      {
        id: `evt_p7l1_c_${uid()}`,
        type: 'charge.refunded',
        created: nowSec(),
        data: { id: chargeId, amount_refunded: 1500, metadata: { tenantId: owner.tenantId } },
      },
      query,
      `evt_p7l1_c_${uid()}`,
    );
    const r2 = await query(
      `SELECT COUNT(*)::int c, COALESCE(SUM(amount_cents), 0)::int s FROM tenant_credits WHERE tenant_id = $1`,
      [owner.tenantId],
    );
    expect(Number(r2.rows[0].c)).toBe(2);
    expect(Number(r2.rows[0].s)).toBe(1500);
  });

  test('G1-L-1: reprocessing the same event sends the lifecycle email exactly once', async () => {
    const owner = await signupOwner(app);
    await query(`UPDATE tenants SET notify_email = $2 WHERE id = $1`, [
      owner.tenantId,
      `p7l1-${uid()}@beyo.test`,
    ]);
    const evtId = `evt_p7g1l1_${uid()}`;
    const evt: any = {
      id: evtId,
      type: 'charge.refunded',
      created: nowSec(),
      data: {
        id: `ch_p7g1l1_${uid()}`,
        amount_refunded: 2900,
        metadata: { tenantId: owner.tenantId },
      },
    };
    const sentCount = async () =>
      Number(
        (
          await query(
            `SELECT COUNT(*)::int c FROM notification_log
             WHERE event_id = $1 AND notification_type = 'charge.refunded' AND status = 'sent'`,
            [evtId],
          )
        ).rows[0].c,
      );
    // First attempt: email goes out.
    await applyPaymentEvent(evt, query, evtId);
    expect(await sentCount()).toBe(1);
    // Simulate the E4-M-2 crash: side effects applied, markProcessed never ran.
    await query(`UPDATE stripe_webhook_events SET processed_at = NULL WHERE event_id = $1`, [evtId]);
    // Stripe redelivers — the money path stays idempotent AND the customer
    // must not get the same email twice.
    const res = await applyPaymentEvent(evt, query, evtId);
    expect(res.deduplicated).toBe(false); // it reprocessed...
    expect(await sentCount()).toBe(1); // ...but no second email
  });

  test('H2-L-1: concurrent duplicate (live sending claim) does not double-send', async () => {
    const owner = await signupOwner(app);
    await query(`UPDATE tenants SET notify_email = $2 WHERE id = $1`, [
      owner.tenantId,
      `p7h2l1-${uid()}@beyo.test`,
    ]);
    const evtId = `evt_p7h2l1_${uid()}`;
    // Simulate the insert-race loser: the winner's claim row exists with a
    // FRESH 'sending' status (first attempt still in flight).
    await query(
      `INSERT INTO notification_log (id, tenant_id, notification_type, channel, status, detail, event_id)
       VALUES (gen_random_uuid(), $1, 'charge.refunded', 'email', 'sending', 'simulated in-flight', $2)`,
      [owner.tenantId, evtId],
    );
    const evt: any = {
      id: evtId,
      type: 'charge.refunded',
      created: nowSec(),
      data: {
        id: `ch_p7h2l1_${uid()}`,
        amount_refunded: 2900,
        metadata: { tenantId: owner.tenantId },
      },
    };
    // Count ACTUAL email sends (not log rows): the pre-fix code sent the
    // email here (its check only looked for 'sent' rows) even though its
    // post-send INSERT then hit the unique index.
    const spy = vi.spyOn(getNotify(), 'sendEmail').mockResolvedValue(undefined);
    try {
      await applyPaymentEvent(evt, query, evtId);
      expect(spy).toHaveBeenCalledTimes(0); // skipped — the live claim belongs to the in-flight attempt
    } finally {
      spy.mockRestore();
    }
  });

  test('H2-L-1: stale sending claim (crashed mid-send) is taken over exactly once', async () => {
    const owner = await signupOwner(app);
    await query(`UPDATE tenants SET notify_email = $2 WHERE id = $1`, [
      owner.tenantId,
      `p7h2l1b-${uid()}@beyo.test`,
    ]);
    const evtId = `evt_p7h2l1b_${uid()}`;
    // A 'sending' row older than 10 minutes = the sender crashed mid-send.
    await query(
      `INSERT INTO notification_log (id, tenant_id, notification_type, channel, status, detail, event_id, created_at)
       VALUES (gen_random_uuid(), $1, 'charge.refunded', 'email', 'sending', 'simulated crash', $2, now() - interval '15 minutes')`,
      [owner.tenantId, evtId],
    );
    const evt: any = {
      id: evtId,
      type: 'charge.refunded',
      created: nowSec(),
      data: {
        id: `ch_p7h2l1b_${uid()}`,
        amount_refunded: 2900,
        metadata: { tenantId: owner.tenantId },
      },
    };
    const spy = vi.spyOn(getNotify(), 'sendEmail').mockResolvedValue(undefined);
    try {
      await applyPaymentEvent(evt, query, evtId);
      expect(spy).toHaveBeenCalledTimes(1); // taken over and sent exactly once
    } finally {
      spy.mockRestore();
    }
  });
});
