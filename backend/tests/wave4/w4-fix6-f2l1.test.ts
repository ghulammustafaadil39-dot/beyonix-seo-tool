/**
 * Wave-4 Pass#6 fix regression tests (LA).
 * F2-L-1: the E4-M-2 reprocess fix must not reprocess a CONCURRENT
 * duplicate delivery (insert-race loser sees processed_at IS NULL while the
 * first attempt is still in flight). started_at disambiguates:
 * fresh -> dedupe (old, safer behavior); stale -> reprocess (crash recovery).
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
  await ensureMigrated(); // applies 047 (started_at) on a fresh test DB
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

it('F2-L-1a: concurrent duplicate (fresh started_at, unprocessed) is deduped — no double credit', async () => {
  const eventId = 'evt_f2l1_concurrent';
  await query(
    `INSERT INTO stripe_webhook_events (event_id, event_type, started_at) VALUES ($1, 'charge.refunded', now())`,
    [eventId],
  );
  const before = await creditCount();
  const res = await applyPaymentEvent(refundEvt(), query, eventId);
  expect(res.deduplicated).toBe(true);
  expect(await creditCount()).toBe(before);
});

it('F2-L-1b: crashed attempt (stale started_at, unprocessed) is reprocessed — credit applied exactly once', async () => {
  const eventId = 'evt_f2l1_crashed';
  await query(
    `INSERT INTO stripe_webhook_events (event_id, event_type, started_at)
     VALUES ($1, 'charge.refunded', now() - interval '10 minutes')`,
    [eventId],
  );
  const before = await creditCount();
  const res = await applyPaymentEvent(refundEvt(), query, eventId);
  expect(res.deduplicated).toBe(false);
  expect(await creditCount()).toBe(before + 1);
});

it('F2-L-1c: already-processed redelivery is still deduped', async () => {
  const eventId = 'evt_f2l1_processed';
  await query(
    `INSERT INTO stripe_webhook_events (event_id, event_type, started_at, processed_at)
     VALUES ($1, 'charge.refunded', now() - interval '1 hour', now() - interval '30 minutes')`,
    [eventId],
  );
  const before = await creditCount();
  const res = await applyPaymentEvent(refundEvt(), query, eventId);
  expect(res.deduplicated).toBe(true);
  expect(await creditCount()).toBe(before);
});
