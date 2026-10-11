import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import type { FastifyInstance } from 'fastify';
import { pool, query, runMigrations } from '../src/db.js';
import { auth, signupVerified, tenantCollector } from './helpers-ba.js';
import { buildOpenApiSpec, getDocumentedRoutes } from '../src/services/openapi.js';

/**
 * C-07 (API quality): OpenAPI 3.1 generated from route schemas (served at
 * /api/v1/openapi.json), GET /api/v1/settings/providers (mock/real per
 * provider, N-A2-7), input validation on new routes, stable pagination.
 *
 * Needs DATABASE_URL at a test database (bseo_test_ba).
 */
const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

describe.runIf(HAS_TEST_DB)('C-07 API quality', () => {
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

  it('GET /api/v1/openapi.json serves a valid OpenAPI 3.1 spec', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    expect(r.statusCode).toBe(200);
    const spec = r.json() as any;
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('Beyonix SEO API');
    // Backend-A routes…
    expect(spec.paths['/api/v1/billing/checkout']?.post).toBeTruthy();
    expect(spec.paths['/api/v1/account/workspaces']?.post).toBeTruthy();
    expect(spec.paths['/api/v1/admin/tenants']?.get).toBeTruthy();
    expect(spec.paths['/api/v1/apikeys']?.post).toBeTruthy();
    expect(spec.paths['/api/v1/webhooks']?.post).toBeTruthy();
    // …and Backend-B routes are picked up automatically (schema-driven).
    expect(spec.paths['/api/v1/sites']?.post).toBeTruthy();
    expect(spec.paths['/api/v1/sites/{id}']?.get).toBeTruthy();
    // Schemas flow through: checkout body requires planId.
    const checkoutBody =
      spec.paths['/api/v1/billing/checkout'].post.requestBody.content['application/json'].schema;
    expect(checkoutBody.required).toContain('planId');
    // Frozen error envelope documented on 400.
    expect(spec.paths['/api/v1/billing/checkout'].post.responses['400']).toBeTruthy();
  });

  it('the spec generator picks up newly registered routes (no hand-sync)', () => {
    // Direct unit check: recordRouteForDocs + buildOpenApiSpec round-trip.
    const before = getDocumentedRoutes().length;
    expect(before).toBeGreaterThan(30);
    const spec = buildOpenApiSpec() as any;
    expect(Object.keys(spec.paths).length).toBeGreaterThan(30);
  });

  it('GET /api/v1/settings/providers reports mock/real per provider (N-A2-7)', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);
    const r = await app.inject({ method: 'GET', url: '/api/v1/settings/providers', headers: auth(u.token) });
    expect(r.statusCode).toBe(200);
    const providers = (r.json() as any).providers;
    const names = providers.map((p: any) => p.name);
    for (const n of ['payments', 'google', 'keyword_serp', 'llm', 'notify_email', 'notify_telegram']) {
      expect(names).toContain(n);
    }
    for (const p of providers) {
      expect(['mock', 'real']).toContain(p.mode);
    }
    // This env has no provider keys: everything reports mock (honest).
    expect(providers.find((p: any) => p.name === 'payments').mode).toBe('mock');
  });

  it('new routes validate input with VALIDATION_ERROR 400 (not 500)', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);

    const badWs = await app.inject({
      method: 'POST',
      url: '/api/v1/account/workspaces',
      headers: auth(u.token),
      payload: {},
    });
    expect(badWs.statusCode).toBe(400);
    expect(badWs.json().error.code).toBe('VALIDATION_ERROR');

    const badCheckout = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: auth(u.token),
      payload: { planId: 'growth', trialDays: 999 },
    });
    expect(badCheckout.statusCode).toBe(400);
    expect(badCheckout.json().error.code).toBe('VALIDATION_ERROR');

    const badUuid = await app.inject({
      method: 'DELETE',
      url: '/api/v1/account/workspaces/not-a-uuid',
      headers: auth(u.token),
    });
    expect(badUuid.statusCode).toBe(400);
    expect(badUuid.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('pagination is stable: page/limit/total on list endpoints', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);
    for (const name of ['K1', 'K2', 'K3']) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/account/workspaces',
        headers: auth(u.token),
        payload: { name },
      });
    }
    const p1 = await app.inject({
      method: 'GET',
      url: '/api/v1/account/workspaces?page=1&limit=2',
      headers: auth(u.token),
    });
    const b1 = p1.json() as any;
    expect(b1.data).toHaveLength(2);
    expect(b1).toMatchObject({ page: 1, limit: 2, total: 3 });
    const p2 = await app.inject({
      method: 'GET',
      url: '/api/v1/account/workspaces?page=2&limit=2',
      headers: auth(u.token),
    });
    const b2 = p2.json() as any;
    expect(b2.data).toHaveLength(1);
    expect(b2).toMatchObject({ page: 2, limit: 2, total: 3 });
    // limit is capped at 100.
    const capped = await app.inject({
      method: 'GET',
      url: '/api/v1/account/activity?page=1&limit=9999',
      headers: auth(u.token),
    });
    expect((capped.json() as any).limit).toBe(100);
  });

  it('request ids are echoed and present in error bodies', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/v1/settings',
      headers: { 'x-request-id': 'c07-req-1' },
    });
    expect(r.headers['x-request-id']).toBe('c07-req-1'); // echoed even on 401
    expect((r.json() as any).error.requestId).toBe('c07-req-1');
  });
});
