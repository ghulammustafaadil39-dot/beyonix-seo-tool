import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import { pool, runMigrations } from '../src/db.js';
import { sessionTokenFromResponse } from './helpers.js';

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
 * Requires a real database: run with DATABASE_URL pointing at a test
 * database (e.g. bseo_test_backend). Skips otherwise — never touches a
 * non-test database by accident.
 */
const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');
if (!HAS_TEST_DB) console.warn('[n-qa-1] skipping: DATABASE_URL does not point at a test database');

describe.runIf(HAS_TEST_DB)('N-QA-1 public routes are not auth-gated', () => {
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
    // JWT-in-body fix: session arrives via httpOnly cookie, never the body.
    expect(res.json()).not.toHaveProperty('token');
    expect(sessionTokenFromResponse(res)).toBeTruthy();
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

  // Mock-provider only: with real Stripe keys the webhook requires a valid
  // Stripe signature (covered by the signed-fixture tests in p0-04.test.ts).
  // P0-05: mock webhooks require the local MOCK_WEBHOOK_SECRET signature.
  // This test proves the route is PUBLIC (no auth preHandler) by sending a
  // correctly SIGNED event (expect 200), and proves an unsigned event fails
  // on the webhook's own signature check — never on "Authentication required".
  it.runIf(!process.env.STRIPE_SECRET_KEY)(
    'POST /billing/webhook is reachable without a token (mock provider)',
    async () => {
      const { config } = await import('../src/config.js');
      const { signMockWebhookEvent } = await import('../src/providers/stripe.js');
      const secret = 'n-qa-1-webhook-test-secret';
      (config as unknown as Record<string, unknown>).mockWebhookSecret = secret;
      const raw = JSON.stringify({ type: 'unknown.test.event', data: {} });
      const sig = signMockWebhookEvent(raw, secret);
      const ok = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
        payload: raw,
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().received).toBe(true);
      const unsigned = await app.inject({
        method: 'POST',
        url: '/api/v1/billing/webhook',
        headers: { 'content-type': 'application/json' },
        payload: raw,
      });
      expect(unsigned.json().error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
      expect(unsigned.json().error.message).not.toMatch(/Authentication required/);
    },
  );

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
      headers: { authorization: `Bearer ${sessionTokenFromResponse(login)}` },
    });
    expect(me.statusCode).toBe(200);
  });
});
