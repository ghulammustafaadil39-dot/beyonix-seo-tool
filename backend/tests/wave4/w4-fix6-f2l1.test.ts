/**
 * Wave-4 Pass#6 fix regression tests (LA).
 * F2-L-1: the E4-M-2 reprocess path (crashed attempt retried, or a
 * concurrent duplicate delivery that lost the insert race) must not
 * double-apply money effects. The charge.refunded -> tenant_credits path
 * is guarded by the webhook event id (tenant_credits.webhook_event_id);
 * coupons are guarded by coupon_redemptions (Worker C).
 */
import { it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, query, signupOwner } from './helpers.js';
import { resetDb, ensureMigrated } from '../integration/helpers/db.js';
import { applyPaymentEvent } from '../../src/providers/stripe.js';

let app: FastifyInstance;
let tenantId: string;

beforeAll(async () => {
  app = await buildTestApp();
  await ensureMigrated(); // applies 046 (coupon_redemptions) + 048 (webhook_event_id)
  await resetDb();
  const owner = await signupOwner(app);
  tenantId = owner.tenantId;
});
afterAll(async () => { await app.close(); });

async function creditCount(): Promise<number> {
  const r = await query(`SELECT COUNT(*)::int AS c FROM tenant_credits WHERE tenant_id = $1`, [tenantId]);
  return r.rows[0].c as number;
}

const refundEvt = () => ({
  type: 'charge.refunded',
  data: { id: 'ch_f2l1', amount_refunded: 5000, metadata: { tenantId } },
});

it('F2-L-1a: reprocessing the same refund event (E4-M-2 path) credits exactly once', async () => {
  const eventId = 'evt_f2l1_refund_reprocess';
  const first = await applyPaymentEvent(refundEvt(), query, eventId);
  expect(first.deduplicated).toBe(false);
  expect(await creditCount()).toBe(1);
  // Simulate a crash between side effects and markProcessed (or a
  // concurrent duplicate that lost the insert race): the ledger row exists
  // but was never marked processed, so the next delivery reprocesses.
  await query(`UPDATE stripe_webhook_events SET processed_at = NULL WHERE event_id = $1`, [eventId]);
  const second = await applyPaymentEvent(refundEvt(), query, eventId);
  expect(second.deduplicated).toBe(false); // it reprocessed...
  expect(await creditCount()).toBe(1); // ...but the guard held: no double credit
});

it('F2-L-1b: a distinct refund event for the same charge credits only the delta (G5-L#1)', async () => {
  // G5-L#1: amount_refunded is cumulative. A distinct event with the same
  // cumulative total means nothing new was refunded → no new credit row.
  const before = await creditCount();
  await applyPaymentEvent(refundEvt(), query, 'evt_f2l1_refund_same_total');
  expect(await creditCount()).toBe(before);
  // A higher cumulative total credits only the delta (8000 - 5000 = 3000).
  const higher = {
    type: 'charge.refunded',
    data: { id: 'ch_f2l1', amount_refunded: 8000, metadata: { tenantId } },
  };
  await applyPaymentEvent(higher, query, 'evt_f2l1_refund_higher_total');
  expect(await creditCount()).toBe(before + 1);
  const sum = await query(
    `SELECT COALESCE(SUM(amount_cents), 0)::int AS s FROM tenant_credits WHERE tenant_id = $1`,
    [tenantId],
  );
  expect(Number(sum.rows[0].s)).toBe(8000); // 5000 + 3000 delta, not 13000
});

it('F2-L-1c: already-processed redelivery is still deduped with no new credit', async () => {
  const eventId = 'evt_f2l1_refund_processed';
  await applyPaymentEvent(refundEvt(), query, eventId);
  const before = await creditCount();
  const res = await applyPaymentEvent(refundEvt(), query, eventId);
  expect(res.deduplicated).toBe(true);
  expect(await creditCount()).toBe(before);
});
