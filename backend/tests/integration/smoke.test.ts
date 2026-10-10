/**
 * Harness smoke test — proves the integration setup works end to end
 * (real Postgres bseo_test + real Redis DB 1 + fake SMTP/webhook catchers).
 *
 * This is NOT a verification of any Wave 1 item. Auth lifecycle tests
 * (signup → logout → login → /auth/me, token revocation) land with P0-01
 * after the Backend Lead's branch is ready — the parent signals when.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from './helpers/app.js';
import { query, resetDb } from './helpers/db.js';
import { getTestRedis, resetRedis } from './helpers/redis.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  await resetRedis();
});

describe('integration harness smoke', () => {
  it('GET /healthz returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('unauthenticated /auth/me returns the 401 error envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(res.statusCode).toBe(401);
    expect((res.json() as any).error.code).toBe('UNAUTHORIZED');
  });

  it('resetDb() empties tenant-scoped tables (hermetic per test)', async () => {
    await query(`INSERT INTO tenants (id, name, plan_id) VALUES (gen_random_uuid(), 'probe', 'starter')`);
    const before = await query('SELECT COUNT(*)::int AS n FROM tenants');
    expect(before.rows[0].n).toBe(1);
    await resetDb();
    const after = await query('SELECT COUNT(*)::int AS n FROM tenants');
    expect(after.rows[0].n).toBe(0);
  });

  it('resetRedis() flushes the test Redis DB', async () => {
    const r = getTestRedis();
    await r.set('probe:key', '1');
    expect(await r.get('probe:key')).toBe('1');
    await resetRedis();
    expect(await r.get('probe:key')).toBeNull();
  });
});
