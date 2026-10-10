import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import { pool, runMigrations } from '../src/db.js';

/**
 * N-QA-1 (CRITICAL) regression: the auth preHandler hook leaked onto the
 * whole /api/v1 scope (authPlugin was fastify-plugin-wrapped and registered
 * on the v1 instance by backlinks/geo/reports), so every public route —
 * signup, login, logout, Google OAuth, Stripe webhooks, GSC/GA4 callbacks —
 * returned 401 UNAUTHORIZED. Nobody could sign up or log in, and Stripe
 * webhooks would 401 in production.
 *
 * These tests assert the public routes are reachable WITHOUT a token while
 * protected routes still require one.
 *
 * Requires a real database: run with DATABASE_URL pointing at bseo_test_backend.
 */
describe('N-QA-1 public routes are not auth-gated', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const email = `nqa1_${Date.now()}@example.com`;
  const password = 'correct-horse-9';

  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
    await app.ready();
  }, 60000);

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE id IN (SELECT tenant_id FROM users WHERE email = $1)', [email]);
    await app.close();
    await pool.end();
  });

  it('POST /auth/signup works without a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email, password },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toBeTruthy();
  });

  it('POST /auth/login reaches the handler without a token (bad creds -> INVALID_CREDENTIALS, not "Authentication required")', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@example.com', password: 'wrong-password-1' },
    });
    expect(res.statusCode).toBe(401);
    // Proves the request got PAST the auth hook to the login handler:
    // the hook's error code is UNAUTHORIZED/"Authentication required".
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('POST /billing/webhook is reachable without a token (mock provider)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/webhook',
      payload: { type: 'unknown.test.event' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().received).toBe(true);
  });

  it('GET /auth/google (OAuth start) is reachable without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/google' });
    // Mock Google provider redirects to a fake consent page — must NOT be 401.
    expect(res.statusCode).toBe(302);
  });

  it('protected routes still require a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sites' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('a logged-in user can still reach protected routes', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${login.json().token}` },
    });
    expect(me.statusCode).toBe(200);
  });
});
