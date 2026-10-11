// QA Wave-2 gate fixes (agent/qa-fixes-1):
//  - BUG-QA-W2-1 [MEDIUM] worker (and API) entry guard ignored the tsx
//    dev entry (`src/worker.ts` / `src/index.ts`), so `npm run dev:worker`
//    silently no-oped. Predicate unit tests below; a scripted smoke run of
//    `tsx src/worker.ts` (logs "[worker] all processors started") was done
//    manually and is reported with this branch — a spawn test inside the
//    suite would hold BullMQ workers/Redis open and flake the shared DB.
//  - BUG-QA-W2-2 [LOW] mock Stripe webhook diverged from the real
//    envelope: a real-shaped payload (`data:{object:{...}}`) was returned
//    with HTTP 200 but silently ignored. Mock must unwrap `data.object`
//    like the real provider, while the existing direct convention
//    (`data` = the object itself, p0-05 / journey-billing) stays green.
//  - BUG-QA-W2-4 [LOW] keyword research / rank responses carried no mock
//    label. They now carry `dataSource: 'mock'|'real'` (additive
//    top-level field), same convention as the keyword-gap endpoint.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { isApiEntryPoint } from '../src/index.js';
import { isWorkerEntryPoint } from '../src/worker.js';
import { query } from '../src/db.js';
import { config } from '../src/config.js';
import {
  signMockWebhookEvent,
  verifyMockWebhookEvent,
} from '../src/providers/stripe.js';
import {
  ensureTestDb, truncateAll, createTestUser, loginAs, authHeaders,
} from './helpers.js';

const MOCK_SECRET = 'qa-fixes-1-webhook-secret';

describe('BUG-QA-W2-1 entry-point guards recognize tsx dev entries', () => {
  it('worker: built dist entry starts', () => {
    expect(isWorkerEntryPoint('/app/backend/dist/worker.js')).toBe(true);
    expect(isWorkerEntryPoint('dist/worker.js')).toBe(true);
  });
  it('worker: tsx dev entry starts (the bug)', () => {
    expect(isWorkerEntryPoint('/app/backend/src/worker.ts')).toBe(true);
    expect(isWorkerEntryPoint('src/worker.ts')).toBe(true);
  });
  it('worker: imports / other entries do NOT start', () => {
    expect(isWorkerEntryPoint(undefined)).toBe(false);
    expect(isWorkerEntryPoint('')).toBe(false);
    expect(isWorkerEntryPoint('/app/backend/src/index.ts')).toBe(false);
    expect(isWorkerEntryPoint('/app/backend/src/index.js')).toBe(false);
    expect(isWorkerEntryPoint('/app/backend/tests/qa-fixes-1.test.ts')).toBe(false);
    expect(isWorkerEntryPoint('/app/backend/src/worker.test.ts')).toBe(false);
  });
  it('api (index.ts has the identical pattern/problem): both entries start, imports do not', () => {
    expect(isApiEntryPoint('/app/backend/dist/index.js')).toBe(true);
    expect(isApiEntryPoint('/app/backend/src/index.ts')).toBe(true);
    expect(isApiEntryPoint(undefined)).toBe(false);
    expect(isApiEntryPoint('/app/backend/src/worker.ts')).toBe(false);
    expect(isApiEntryPoint('/app/backend/src/worker.js')).toBe(false);
  });
});

describe('BUG-QA-W2-2 mock webhook envelope unwrapping (unit)', () => {
  it('real-shaped payload: data.object is unwrapped like the real provider', () => {
    const inner = {
      id: 'cs_real_shape',
      object: 'checkout.session',
      customer: 'cus_mock_real',
      subscription: 'sub_real_shape',
      metadata: { tenantId: 'tenant-x', planId: 'growth' },
    };
    const raw = JSON.stringify({
      id: 'evt_real_shape',
      type: 'checkout.session.completed',
      data: { object: inner },
    });
    const sig = signMockWebhookEvent(raw, MOCK_SECRET);
    const evt = verifyMockWebhookEvent(raw, sig, MOCK_SECRET);
    expect(evt.type).toBe('checkout.session.completed');
    expect(evt.data).toEqual(inner);
    expect(evt.data.metadata.planId).toBe('growth');
  });

  it('direct-shape payload (existing p0-05 convention) still works: data IS the object', () => {
    const direct = {
      id: 'cs_direct',
      object: 'checkout.session', // string tag, NOT an envelope object
      customer: 'cus_mock_direct',
      subscription: 'sub_direct',
      metadata: { tenantId: 'tenant-y', planId: 'pro' },
    };
    const raw = JSON.stringify({
      id: 'evt_direct',
      type: 'checkout.session.completed',
      data: direct,
    });
    const sig = signMockWebhookEvent(raw, MOCK_SECRET);
    const evt = verifyMockWebhookEvent(raw, sig, MOCK_SECRET);
    expect(evt.data).toEqual(direct);
  });

  it('payload with no data.object and no object tag passes data through', () => {
    const raw = JSON.stringify({ type: 'unknown.test.event', data: {} });
    const sig = signMockWebhookEvent(raw, MOCK_SECRET);
    expect(verifyMockWebhookEvent(raw, sig, MOCK_SECRET).data).toEqual({});
  });
});

// ---- HTTP-level regression tests (mock providers, real DB) ----

let app: FastifyInstance;
let token: string;
let tenantId: string;
let siteId: string;
let tenant2Id: string;
let kwId: string;

beforeAll(async () => {
  await ensureTestDb();
  await truncateAll();
  (config as any).mockWebhookSecret = MOCK_SECRET;
  app = await buildApp();
  const u = await createTestUser('qa-fixes-1@example.com', { verified: true });
  tenantId = u.tenantId;
  token = await loginAs(app, 'qa-fixes-1@example.com');
  const u2 = await createTestUser('qa-fixes-1-b@example.com', { verified: true });
  tenant2Id = u2.tenantId;
  const s = await query(
    `INSERT INTO sites (id, tenant_id, domain, verified) VALUES (gen_random_uuid(), $1, 'example.com', TRUE) RETURNING id`,
    [tenantId],
  );
  siteId = s.rows[0].id as string;
  // Tracked keyword + one rank check for the rank endpoints.
  const k = await query(
    `INSERT INTO keywords (id, tenant_id, site_id, keyword, tracked) VALUES (gen_random_uuid(), $1, $2, 'qa fixes keyword', TRUE) RETURNING id`,
    [tenantId, siteId],
  );
  kwId = k.rows[0].id as string;
  await query(
    `INSERT INTO rank_checks (id, tenant_id, keyword_id, position, url) VALUES (gen_random_uuid(), $1, $2, 5, 'https://example.com/qa')`,
    [tenantId, kwId],
  );
}, 60000);

afterAll(async () => {
  (config as any).mockWebhookSecret = '';
  await app?.close();
});

async function sendMockWebhook(raw: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/billing/webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signMockWebhookEvent(raw, MOCK_SECRET),
    },
    payload: raw,
  });
}

describe('BUG-QA-W2-2 mock webhook over HTTP', () => {
  it('real-shaped signed checkout.session.completed actually creates the subscription', async () => {
    const periodStart = Math.floor(Date.now() / 1000) - 3600;
    const periodEnd = periodStart + 30 * 86400;
    const raw = JSON.stringify({
      id: `evt_qa_real_${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_qa_real',
          object: 'checkout.session',
          customer: 'cus_mock_qa_real',
          subscription: {
            id: 'sub_qa_real',
            object: 'subscription',
            status: 'active',
            current_period_start: periodStart,
            current_period_end: periodEnd,
          },
          metadata: { tenantId, planId: 'growth' },
        },
      },
    });
    const res = await sendMockWebhook(raw);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: true, deduplicated: false });
    const sub = await query(
      `SELECT plan_id, status, stripe_sub_id FROM subscriptions WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(sub.rows).toHaveLength(1);
    expect(sub.rows[0].plan_id).toBe('growth');
    expect(sub.rows[0].status).toBe('active');
    expect(sub.rows[0].stripe_sub_id).toBe('sub_qa_real');
    const tenant = await query(`SELECT plan_id FROM tenants WHERE id = $1`, [tenantId]);
    expect(tenant.rows[0].plan_id).toBe('growth');
  });

  it('direct-shaped signed payload still creates a subscription (back-compat)', async () => {
    const raw = JSON.stringify({
      id: `evt_qa_direct_${Date.now()}`,
      created: Math.floor(Date.now() / 1000),
      type: 'checkout.session.completed',
      data: {
        id: 'cs_qa_direct',
        object: 'checkout.session',
        customer: 'cus_mock_qa_direct',
        subscription: 'sub_qa_direct',
        metadata: { tenantId: tenant2Id, planId: 'pro' },
      },
    });
    const res = await sendMockWebhook(raw);
    expect(res.statusCode).toBe(200);
    const sub = await query(
      `SELECT plan_id, stripe_sub_id FROM subscriptions WHERE tenant_id = $1`,
      [tenant2Id],
    );
    expect(sub.rows).toHaveLength(1);
    expect(sub.rows[0].plan_id).toBe('pro');
    expect(sub.rows[0].stripe_sub_id).toBe('sub_qa_direct');
  });
});

describe('BUG-QA-W2-4 dataSource labels (mock provider)', () => {
  it('keyword research response carries dataSource: mock', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/keywords/research`,
      headers: authHeaders(token),
      payload: { seeds: ['qa fixes research'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dataSource).toBe('mock');
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.total).toBe(body.data.length);
  });

  it('keyword expand response carries dataSource: mock', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/keywords/expand`,
      headers: authHeaders(token),
      payload: { seeds: ['qa expand seed'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dataSource).toBe('mock');
  });

  it('latest ranks response carries dataSource: mock', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${siteId}/ranks`,
      headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dataSource).toBe('mock');
    expect(body.data.some((r: any) => r.keyword === 'qa fixes keyword' && r.position === 5)).toBe(true);
  });

  it('rank history response carries dataSource: mock', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/keywords/${kwId}/history`,
      headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dataSource).toBe('mock');
    expect(body.keyword).toBe('qa fixes keyword');
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('rank visibility response carries dataSource: mock', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${siteId}/ranks/visibility`,
      headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dataSource).toBe('mock');
  });
});
