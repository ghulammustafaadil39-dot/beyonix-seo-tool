/**
 * Wave-4 Pass #1 LOW regression tests (backend).
 *
 * A1-L1: batched backlink INSERT (upload route + job loop).
 * A1-L2: /metrics basic-auth gate.
 * A1-L3: CONTRACTS.md documents the real error envelope.
 * A1-L5: actorUserId() null for API keys.
 * A1-L6: PATCH /settings llm_api_key: '' clears the key.
 * A2-L1: jwt.verify pinned to HS256 (3 sites).
 * A2-L3: dead export storeIdempotentResponse removed.
 * A2-L5: local coupon code mapped to a Stripe coupon id.
 * A2-L6: committed usage_reservations purged on the 13-month window.
 * A2-L7: heartbeatHeavySlot extends the fairness slot TTL.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, query, signupOwner, createSite, authz } from './helpers.js';
import { actorUserId } from '../../src/middleware/access.js';
import { registerMetricsRoutes } from '../../src/routes/metrics.js';
import { config } from '../../src/config.js';
import { runRetentionCleanup } from '../../src/services/retention.js';
import { acquireHeavySlot, releaseHeavySlot, heartbeatHeavySlot } from '../../src/services/fairness.js';
import { getRedis, redisKeyPrefix } from '../../src/redis.js';

let app: Awaited<ReturnType<typeof buildTestApp>>;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('A1-L1: batched backlink INSERT', () => {
  it('uploads N links with one batched statement path and inserts all', async () => {
    const owner = await signupOwner(app);
    const siteId = await createSite(app, owner);
    const rows = Array.from(
      { length: 7 },
      (_, i) => `https://blog.example.com/post-${i}, https://target${i}.example.net/page`,
    ).join('\n');
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/backlinks/upload`,
      headers: authz(owner),
      payload: { csv: rows },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as any).imported).toBe(7);
    const count = await query(`SELECT COUNT(*)::int c FROM backlinks WHERE site_id = $1`, [siteId]);
    expect(count.rows[0].c).toBe(7);
    // Re-upload: same links upsert (no duplicates).
    const res2 = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/backlinks/upload`,
      headers: authz(owner),
      payload: { csv: rows },
    });
    expect(res2.statusCode).toBe(200);
    const count2 = await query(`SELECT COUNT(*)::int c FROM backlinks WHERE site_id = $1`, [siteId]);
    expect(count2.rows[0].c).toBe(7);
  });
});

describe('A1-L2: /metrics basic-auth gate', () => {
  it('401s without credentials and 200s with them when METRICS_BASIC_AUTH is set', async () => {
    const prev = config.metricsBasicAuth;
    config.metricsBasicAuth = 'ops:s3cret-metrics';
    try {
      const mapp = Fastify({ logger: false });
      await registerMetricsRoutes(mapp);
      const anon = await mapp.inject({ method: 'GET', url: '/metrics' });
      expect(anon.statusCode).toBe(401);
      const wrong = await mapp.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Basic ${Buffer.from('ops:wrong').toString('base64')}` },
      });
      expect(wrong.statusCode).toBe(401);
      const ok = await mapp.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Basic ${Buffer.from('ops:s3cret-metrics').toString('base64')}` },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['content-type']).toContain('text/plain');
      const statusAnon = await mapp.inject({ method: 'GET', url: '/status' });
      expect(statusAnon.statusCode).toBe(401);
      await mapp.close();
    } finally {
      config.metricsBasicAuth = prev;
    }
  });

  it('stays open when METRICS_BASIC_AUTH is unset (documented default)', async () => {
    const prev = config.metricsBasicAuth;
    config.metricsBasicAuth = '';
    try {
      const mapp = Fastify({ logger: false });
      await registerMetricsRoutes(mapp);
      const res = await mapp.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(200);
      await mapp.close();
    } finally {
      config.metricsBasicAuth = prev;
    }
  });
});

describe('A1-L3: CONTRACTS.md error envelope doc', () => {
  it('documents the real frozen envelope (ok:false + error.code)', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const doc = readFileSync(join(root, 'CONTRACTS.md'), 'utf8');
    expect(doc).toContain('ok: false');
    expect(doc).toContain('VALIDATION_ERROR');
  });
});

describe('A1-L5: actorUserId()', () => {
  it('returns null for API-key callers, the user id for sessions', () => {
    expect(actorUserId({ tenant: { apiKeyId: 'key-1', userId: 'apikey:key-1' } } as any)).toBeNull();
    expect(actorUserId({ tenant: { userId: 'user-1' } } as any)).toBe('user-1');
    expect(actorUserId({} as any)).toBeNull();
  });
});

describe('A1-L6: empty llm_api_key clears the key', () => {
  it("PATCH /settings with llm_api_key '' sets llm_key_set=false", async () => {
    const owner = await signupOwner(app);
    const set = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: authz(owner),
      payload: { llm_api_key: 'sk-test-not-real-key' },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as any).llm_key_set).toBe(true);
    const clear = await app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: authz(owner),
      payload: { llm_api_key: '' },
    });
    expect(clear.statusCode).toBe(200);
    expect((clear.json() as any).llm_key_set).toBe(false);
    const row = await query(`SELECT llm_api_key_enc FROM tenants WHERE id = $1`, [owner.tenantId]);
    expect(row.rows[0].llm_api_key_enc).toBeNull();
  });
});

describe('A2-L1: jwt.verify pinned to HS256', () => {
  it('rejects a token signed with a different algorithm (HS512)', async () => {
    const owner = await signupOwner(app);
    const secret = process.env.JWT_SECRET!;
    const forged = jwt.sign(
      { sub: owner.userId, tid: owner.tenantId, tv: 0 },
      secret,
      { algorithm: 'HS512', expiresIn: '1h' },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sites',
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('still accepts a genuine HS256 session token', async () => {
    const owner = await signupOwner(app);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sites',
      headers: authz(owner),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('A2-L3: dead export removed', () => {
  it('storeIdempotentResponse is no longer exported', async () => {
    const mod = await import('../../src/middleware/idempotency.js');
    expect('storeIdempotentResponse' in mod).toBe(false);
  });
});

describe('A2-L5: local coupon mapped to Stripe coupon id', () => {
  it('checkout with a local code stores a resolved Stripe coupon id (mock)', async () => {
    const owner = await signupOwner(app);
    const code = `W4L${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await query(
      `INSERT INTO billing_coupons (code, percent_off, duration, active) VALUES ($1, 20, 'once', TRUE)`,
      [code],
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: authz(owner),
      payload: { planId: 'growth', interval: 'monthly', couponCode: code },
    });
    expect(res.statusCode).toBe(200);
    const row = await query(`SELECT stripe_coupon_id FROM billing_coupons WHERE code = $1`, [code]);
    expect(row.rows[0].stripe_coupon_id).toBe(`mock_${code}`);
  });

  it('an unknown coupon code is still rejected', async () => {
    const owner = await signupOwner(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: authz(owner),
      payload: { planId: 'growth', interval: 'monthly', couponCode: 'NOPE-DOES-NOT-EXIST' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as any).error.code).toBe('INVALID_COUPON');
  });
});

describe('A2-L6: committed reservations purged on the 13-month window', () => {
  it('purges committed reservations older than 13 months, keeps recent ones', async () => {
    const owner = await signupOwner(app);
    const oldR = await query(
      `INSERT INTO usage_reservations (id, tenant_id, event_type, units, status, created_at)
       VALUES (gen_random_uuid(), $1, 'ai_words', 10, 'committed', now() - interval '14 months')
       RETURNING id`,
      [owner.tenantId],
    );
    const newR = await query(
      `INSERT INTO usage_reservations (id, tenant_id, event_type, units, status, created_at)
       VALUES (gen_random_uuid(), $1, 'ai_words', 10, 'committed', now() - interval '1 month')
       RETURNING id`,
      [owner.tenantId],
    );
    const oldId = oldR.rows[0].id as string;
    const newId = newR.rows[0].id as string;
    const results = await runRetentionCleanup();
    const committed = results.find((r) => r.entity === 'usage_reservations_committed');
    expect(committed).toBeDefined();
    expect(committed!.deleted).toBeGreaterThanOrEqual(1);
    const old = await query(`SELECT 1 FROM usage_reservations WHERE id = $1`, [oldId]);
    expect(old.rows.length).toBe(0);
    const fresh = await query(`SELECT 1 FROM usage_reservations WHERE id = $1`, [newId]);
    expect(fresh.rows.length).toBe(1);
  });
});

describe('A2-L7: fairness slot heartbeat', () => {
  it('heartbeatHeavySlot extends the slot TTL back to the full window', async () => {
    const redis = getRedis();
    const tenantId = `w4-hb-${Date.now()}`;
    const slot = await acquireHeavySlot(tenantId, 1);
    expect(slot).toBeTruthy();
    try {
      const key = `${redisKeyPrefix()}fair:heavy:${tenantId}`;
      await redis.expire(key, 5);
      expect(await redis.ttl(key)).toBeLessThanOrEqual(5);
      const ok = await heartbeatHeavySlot(tenantId, slot!);
      expect(ok).toBe(true);
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(800);
    } finally {
      await releaseHeavySlot(tenantId, slot!);
    }
  });
});
