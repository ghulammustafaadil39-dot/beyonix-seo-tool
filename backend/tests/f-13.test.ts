import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import type { FastifyInstance } from 'fastify';
import { pool, query, runMigrations } from '../src/db.js';
import { auth, signupVerified, tenantCollector } from './helpers-ba.js';

/**
 * F-13 (public API keys) backend: key CRUD (hash-only storage, show-once),
 * revocation, per-key rate limits, scope enforcement middleware.
 * SECURITY-SENSITIVE — Security Lead review required.
 *
 * Needs DATABASE_URL at a test database (bseo_test_ba) + Redis.
 */
const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

describe.runIf(HAS_TEST_DB)('F-13 API keys', () => {
  let app: FastifyInstance;
  const tc = tenantCollector();

  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
  }, 60000);

  afterAll(async () => {
    await app?.close();
    if (tc.ids.length) await query('DELETE FROM tenants WHERE id = ANY($1)', [tc.ids]);
    await pool.end();
  });

  it('create shows the raw key once; list never exposes hash or raw', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/apikeys',
      headers: auth(u.token),
      payload: { name: 'ci', scopes: ['sites:read'] },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as any;
    expect(body.key).toMatch(/^bseo_[0-9a-f]{64}$/);
    expect(body).not.toHaveProperty('key_hash');
    const raw = body.key as string;

    // DB stores only the sha256 hash.
    const row = await query(`SELECT key_hash, key_prefix FROM api_keys WHERE tenant_id = $1`, [u.tenantId]);
    expect(row.rows[0].key_hash).not.toContain(raw);
    expect(row.rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(raw.startsWith(row.rows[0].key_prefix)).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/v1/apikeys', headers: auth(u.token) });
    const item = (list.json() as any).data[0];
    expect(item).not.toHaveProperty('key');
    expect(item).not.toHaveProperty('key_hash');
    expect(item.key_prefix).toBe(row.rows[0].key_prefix);
  });

  it('key authenticates via x-api-key and Bearer; unknown scopes rejected at creation', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/apikeys',
      headers: auth(u.token),
      payload: { name: 'bad', scopes: ['nope:write'] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('UNKNOWN_SCOPE');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/apikeys',
      headers: auth(u.token),
      payload: { name: 'reader', scopes: ['sites:read'] },
    });
    const raw = (created.json() as any).key as string;

    const viaHeader = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { 'x-api-key': raw },
    });
    expect(viaHeader.statusCode).toBe(200);

    const viaBearer = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { authorization: `Bearer ${raw}` },
    });
    expect(viaBearer.statusCode).toBe(200);

    const bogus = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { 'x-api-key': 'bseo_' + '0'.repeat(64) },
    });
    expect(bogus.statusCode).toBe(401);
  });

  it('scope enforcement: key without webhooks:write cannot manage webhooks', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/apikeys',
      headers: auth(u.token),
      payload: { name: 'narrow', scopes: ['sites:read'] },
    });
    const raw = (created.json() as any).key as string;

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: { 'x-api-key': raw },
      payload: { url: 'http://127.0.0.1:9/h', events: ['limit.near'] },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('INSUFFICIENT_SCOPE');

    // A key WITH the scope passes the gate (loopback is allowed in tests,
    // so the endpoint registers — the point is the scope gate passed).
    const wide = await app.inject({
      method: 'POST',
      url: '/api/v1/apikeys',
      headers: auth(u.token),
      payload: { name: 'wide', scopes: ['webhooks:write'] },
    });
    const rawWide = (wide.json() as any).key as string;
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: { 'x-api-key': rawWide },
      payload: { url: 'http://127.0.0.1:9/h', events: ['limit.near'] },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('revocation kills the key immediately', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/apikeys',
      headers: auth(u.token),
      payload: { name: 'doomed', scopes: ['sites:read'] },
    });
    const { key: raw, id } = created.json() as any;

    const before = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: { 'x-api-key': raw } });
    expect(before.statusCode).toBe(200);

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/apikeys/${id}`,
      headers: auth(u.token),
    });
    expect(revoke.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: { 'x-api-key': raw } });
    expect(after.statusCode).toBe(401);
  });

  it('per-key rate limit: 429 after the budget is spent', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/apikeys',
      headers: auth(u.token),
      payload: { name: 'limited', scopes: ['sites:read'], rateLimitPerMin: 2 },
    });
    const raw = (created.json() as any).key as string;
    const h = { 'x-api-key': raw };
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings', headers: h })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings', headers: h })).statusCode).toBe(200);
    const third = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: h });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('API_KEY_RATE_LIMITED');
  });

  it('non-admin team members cannot create keys', async () => {
    const owner = await signupVerified(app);
    tc.add(owner.tenantId);

    // Real viewer session via invite + accept.
    const viewerEmail = `viewer-${Date.now()}@beyo.test`;
    const inv = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations',
      headers: auth(owner.token),
      payload: { email: viewerEmail, role: 'viewer' },
    });
    expect(inv.statusCode).toBe(200);
    const viewer = await signupVerified(app, viewerEmail);
    tc.add(viewer.tenantId);
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations/accept',
      headers: auth(viewer.token),
      payload: { token: (inv.json() as any).token },
    });
    expect(accept.statusCode).toBe(200);
    const viewerToken = (accept.json() as any).token as string; // accept issues a fresh tenant-bound token

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/apikeys',
      headers: auth(viewerToken),
      payload: { name: 'x', scopes: ['sites:read'] },
    });
    expect(denied.statusCode).toBe(403);
  });
});
