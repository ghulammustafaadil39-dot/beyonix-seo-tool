/**
 * Wave-4 Pass#11 regression tests — fixes for the pass#11 hostile-audit findings.
 * (Pass#11 was the FIRST clean pass: 0 new HIGH/MEDIUM, 11 new LOWs.)
 *
 * - K5-LOW-1: a $0 invoice.paid must NOT revive a canceled subscription to
 *   'active' (no retry cycle to self-heal, unlike past_due); positive
 *   amounts still revive.
 * - K1-LOW-1: the public /api/v1/openapi.json must not enumerate /admin/*
 *   routes (back-office obscurity).
 * - K2-3: checkout.session.completed with a real session id releases a
 *   'creating' claim whose 'open' UPDATE was swallowed (NULL session id)
 *   via the fallback path.
 * - K5-LOW-3: an 'open' claim older than 24h is stolen (Stripe session
 *   expired) instead of handing back a dead checkout URL.
 *
 * Runs in the `integration` vitest project: real Postgres (DATABASE_URL from
 * env) + real Redis.
 */
import { beforeAll, afterAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, query, signupOwner } from './helpers.js';
import { resetDb } from '../integration/helpers/db.js';
import { applyPaymentEvent } from '../../src/providers/stripe.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');
const uid = () => `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const PRICE_GROWTH = `price_p11_growth_${uid()}`;

async function subRow(tenantId: string) {
  const r = await query(
    `SELECT status, plan_id, stripe_sub_id FROM subscriptions WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0];
}

describe.runIf(HAS_TEST_DB)('Pass#11 fixes', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildTestApp();
    await resetDb();
    process.env.STRIPE_PRICE_GROWTH = PRICE_GROWTH;
  }, 60000);
  afterAll(async () => {
    delete process.env.STRIPE_PRICE_GROWTH;
    await app.close();
  });

  test('K5-LOW-1: $0 invoice.paid does NOT revive canceled; positive does', async () => {
    const mkCanceled = async () => {
      const owner = await signupOwner(app);
      const subId = `sub_p11_${uid()}`;
      const customerId = `cus_p11_${uid()}`;
      await query(
        `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, plan_id, status)
         VALUES (gen_random_uuid(), $1, $2, 'growth', 'canceled')`,
        [owner.tenantId, subId],
      );
      return { owner, subId, customerId };
    };
    const paidEvt = (subId: string, customerId: string, tenantId: string, amountPaid: number) => ({
      id: `evt_p11_paid_${uid()}`,
      type: 'invoice.paid',
      created: nowSec(),
      data: {
        id: `in_p11_${uid()}`,
        customer: customerId,
        subscription: subId,
        amount_paid: amountPaid,
        amount_due: 0,
        total: amountPaid,
        currency: 'usd',
        lines: { data: [{ price: { id: PRICE_GROWTH } }] },
        metadata: { tenantId },
      },
    });

    // $0 (auto-paid final invoice / late redelivery) → stays canceled.
    {
      const { owner, subId, customerId } = await mkCanceled();
      await applyPaymentEvent(paidEvt(subId, customerId, owner.tenantId, 0), query, `evt_p11_z_${uid()}`);
      expect((await subRow(owner.tenantId)).status).toBe('canceled');
    }
    // Positive payment → revives (existing D1-H-1/D5-M-2 behavior preserved).
    {
      const { owner, subId, customerId } = await mkCanceled();
      await applyPaymentEvent(paidEvt(subId, customerId, owner.tenantId, 2900), query, `evt_p11_p_${uid()}`);
      expect((await subRow(owner.tenantId)).status).toBe('active');
    }
  });

  test('K1-LOW-1: public openapi.json excludes /admin/* routes', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(r.statusCode).toBe(200);
    const spec = r.json() as any;
    expect(spec.openapi).toBe('3.1.0');
    // Public routes still documented…
    expect(spec.paths['/api/v1/billing/checkout']?.post).toBeTruthy();
    // …but the back-office surface is not enumerated.
    expect(spec.paths['/api/v1/admin/tenants']).toBeFalsy();
    expect(Object.keys(spec.paths).some((p: string) => /(^|\/)admin(\/|$)/.test(p))).toBe(false);
  });

  test('K2-3: completed releases a creating-NULL claim via the fallback path', async () => {
    const owner = await signupOwner(app);
    // Simulates the swallowed 'open' UPDATE: claim stuck 'creating' with
    // NULL session id, but the Stripe session was created and paid.
    await query(
      `INSERT INTO checkout_sessions (tenant_id, plan_id, billing_interval, status)
       VALUES ($1, 'growth', 'monthly', 'creating')`,
      [owner.tenantId],
    );
    await applyPaymentEvent(
      {
        id: `evt_p11_k23_${uid()}`,
        type: 'checkout.session.completed',
        created: nowSec(),
        data: {
          id: 'cs_k23_paid',
          metadata: { tenantId: owner.tenantId, planId: 'growth', interval: 'monthly' },
          customer: `cus_p11k23_${uid()}`,
          subscription: `sub_mock_p11k23_${uid()}`,
        },
      },
      query,
      `evt_p11_k23_${uid()}`,
    );
    // The session-scoped DELETE can't match NULL, but the fallback clears it.
    const r = await query(`SELECT COUNT(*)::int c FROM checkout_sessions WHERE tenant_id = $1`, [owner.tenantId]);
    expect(Number(r.rows[0].c)).toBe(0);
    // And the subscription was still created from the completed event.
    expect((await subRow(owner.tenantId)).status).toBe('active');
  });

  test('K5-LOW-3: open claim older than 24h is stolen (no dead URL reuse)', async () => {
    const owner = await signupOwner(app);
    await query(
      `INSERT INTO checkout_sessions (tenant_id, plan_id, billing_interval, status, stripe_session_id, checkout_url, created_at)
       VALUES ($1, 'growth', 'monthly', 'open', 'cs_expired', 'https://checkout.test/expired', now() - interval '24 hours 5 minutes')`,
      [owner.tenantId],
    );
    const r = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { authorization: `Bearer ${owner.token}` },
      payload: { planId: 'growth', interval: 'monthly' },
    });
    expect(r.statusCode).toBe(200);
    // Stolen and replaced — not the dead expired URL.
    expect((r.json() as any).url).not.toBe('https://checkout.test/expired');
  });
});
