// S-01 — email verification flow + Google merge rules (pre-account-hijack defense).
// DB-backed integration tests against bseo_test_security (see tests/setup.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import { query } from '../src/db.js';
import { createSigninState, OAUTH_STATE_COOKIE, signOAuthStates } from '../src/services/oauthState.js';
import {
  authHeaders,
  createTestSite,
  createTestUser,
  ensureTestDb,
  flushTestQueues,
  loginAs,
  truncateAll,
} from './helpers.js';

const MOCK_EMAIL = process.env.MOCK_GOOGLE_EMAIL ?? 'mock.user@example.com';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  await ensureTestDb();
  app = await buildApp();
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  await flushTestQueues();
  delete process.env.MOCK_GOOGLE_EMAIL_VERIFIED;
});

afterAll(async () => {
  await app.close();
});

async function verifiedAt(userId: string): Promise<string | null> {
  const r = await query('SELECT email_verified_at FROM users WHERE id = $1', [userId]);
  return r.rows[0]?.email_verified_at ?? null;
}

describe('auth scoping regression (fp encapsulation)', () => {
  // Baseline bug: backlinks/geo/reports registered authPlugin directly on the
  // shared /api/v1 scope, so EVERY api route (incl. public signup/login)
  // returned 401. The hook must stay inside each file's encapsulated context.
  it('public routes work without a token; authed routes require one', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'scoping@example.com', password: 'Password123!' },
    });
    expect(signup.statusCode).toBe(201);
    const token = (signup.json() as any).token as string;

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'scoping@example.com', password: 'Password123!' },
    });
    expect(login.statusCode).toBe(200);

    for (const [method, url] of [
      ['GET', '/api/v1/sites'],
      ['GET', '/api/v1/auth/me'],
      ['GET', '/api/v1/billing/subscription'],
    ] as const) {
      const anon = await app.inject({ method, url });
      expect(anon.statusCode).toBe(401);
      const authed = await app.inject({ method, url, headers: authHeaders(token) });
      expect(authed.statusCode).toBe(200);
    }
  });
});

describe('S-01 email verification flow', () => {
  it('signup creates an UNVERIFIED user and issues a verification token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'newbie@example.com', password: 'Password123!', name: 'Newbie' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as any;
    expect(body.user.emailVerified).toBe(false);
    // Test-env debug field: lets tests complete the flow without reading email.
    expect(typeof body.verifyToken).toBe('string');

    const r = await query('SELECT id, email_verified_at FROM users WHERE email = $1', ['newbie@example.com']);
    expect(r.rows[0].email_verified_at).toBeNull();
    const t = await query('SELECT token_hash, consumed_at FROM email_verification_tokens WHERE user_id = $1', [
      r.rows[0].id,
    ]);
    expect(t.rows.length).toBe(1);
    expect(t.rows[0].consumed_at).toBeNull();
    // Only a hash is stored — the raw token is never persisted.
    expect(t.rows[0].token_hash).not.toContain(body.verifyToken);
  });

  it('verify with a valid token marks the user verified (one-time)', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'verifyme@example.com', password: 'Password123!' },
    });
    const rawToken = (signup.json() as any).verifyToken as string;
    const userId = (signup.json() as any).user.id as string;

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      payload: { token: rawToken },
    });
    expect(res.statusCode).toBe(200);
    expect(await verifiedAt(userId)).not.toBeNull();

    // Reuse is rejected.
    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      payload: { token: rawToken },
    });
    expect(reuse.statusCode).toBe(400);
  });

  it('verify rejects unknown and expired tokens', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      payload: { token: 'a'.repeat(64) },
    });
    expect(bad.statusCode).toBe(400);

    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'expired@example.com', password: 'Password123!' },
    });
    const rawToken = (signup.json() as any).verifyToken as string;
    await query(`UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute'`);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      payload: { token: rawToken },
    });
    expect(res.statusCode).toBe(400);
  });

  it('resend is enumeration-safe and throttled', async () => {
    // Unknown email -> same generic 200, nothing sent.
    const ghost = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/resend',
      payload: { email: 'nobody-here@example.com' },
    });
    expect(ghost.statusCode).toBe(200);
    expect(ghost.json()).toEqual({ ok: true });

    await createTestUser('resendme@example.com');
    const count = async () => {
      const r = await query(
        `SELECT count(*)::int AS c FROM email_verification_tokens WHERE created_at > now() - interval '1 hour'`,
      );
      return r.rows[0].c as number;
    };
    const before = await count();
    // Hammer the endpoint: only MAX_RESENDS_PER_WINDOW new tokens may be issued.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/email/resend',
        payload: { email: 'resendme@example.com' },
      });
      expect(res.statusCode).toBe(200); // always generic — no enumeration
    }
    expect((await count()) - before).toBeLessThanOrEqual(3);
  });
});

describe('S-01 unverified accounts cannot use paid/crawl features', () => {
  async function unverifiedUserWithSite() {
    const { userId } = await createTestUser('unverified@example.com');
    const token = await loginAs(app, 'unverified@example.com');
    const siteId = await createTestSite(app, token);
    return { userId, token, siteId };
  }

  // [method, url, payload] for every paid/cost-incurring route.
  const paidCalls: Array<{ name: string; url: (siteId: string) => string; payload: any }> = [
    { name: 'crawl', url: (s) => `/api/v1/sites/${s}/audits`, payload: {} },
    { name: 'backlinks refresh', url: (s) => `/api/v1/sites/${s}/backlinks/refresh`, payload: {} },
    { name: 'content create', url: (s) => `/api/v1/sites/${s}/content`, payload: { title: 'T' } },
    { name: 'ranks refresh', url: (s) => `/api/v1/sites/${s}/ranks/refresh`, payload: {} },
    { name: 'reports generate', url: (s) => `/api/v1/sites/${s}/reports/generate`, payload: {} },
    { name: 'keyword research', url: (s) => `/api/v1/sites/${s}/keywords/research`, payload: { seeds: ['seo'] } },
    { name: 'geo check', url: (s) => `/api/v1/sites/${s}/geo/check`, payload: { query: 'best seo tool' } },
  ];

  it.each(paidCalls.map((c) => [c.name, c]))('blocks %s for unverified users (403 EMAIL_NOT_VERIFIED)', async (_n, call) => {
    const { token, siteId } = await unverifiedUserWithSite();
    const res = await app.inject({
      method: 'POST',
      url: call.url(siteId),
      headers: authHeaders(token),
      payload: call.payload,
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as any).error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('blocks paid checkout for unverified users', async () => {
    const { token } = await unverifiedUserWithSite();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: authHeaders(token),
      payload: { planId: 'growth' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as any).error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('allows paid features after verification', async () => {
    const { userId, token, siteId } = await unverifiedUserWithSite();
    await query('UPDATE users SET email_verified_at = now() WHERE id = $1', [userId]);
    const freshToken = await loginAs(app, 'unverified@example.com'); // picks up verified flag
    void token;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/audits`,
      headers: authHeaders(freshToken),
      payload: {},
    });
    expect(res.statusCode).not.toBe(403);

    const checkout = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: authHeaders(freshToken),
      payload: { planId: 'growth' },
    });
    expect(checkout.statusCode).not.toBe(403);
  });

  it('free routes stay open for unverified users', async () => {
    const { token } = await unverifiedUserWithSite();
    const res = await app.inject({ method: 'GET', url: '/api/v1/sites', headers: authHeaders(token) });
    expect(res.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders(token) });
    expect((me.json() as any).user.emailVerified).toBe(false);
  });
});

describe('S-01 Google merge rules (pre-account-hijack defense)', () => {
  // S-04: the test browser carries the signed state cookie, like a real one.
  async function googleCallback() {
    const { state } = await createSigninState();
    const cookie = signOAuthStates([state]);
    return app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=mock&state=${state}`,
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${cookie}` },
    });
  }

  it('verified Google + unverified local account -> links, verifies, drops untrusted password, revokes sessions', async () => {
    process.env.MOCK_GOOGLE_EMAIL_VERIFIED = 'true';
    const { userId } = await createTestUser(MOCK_EMAIL); // unverified password account
    const before = await query('SELECT token_version, password_hash FROM users WHERE id = $1', [userId]);

    const res = await googleCallback();
    expect(res.statusCode).toBe(302);

    const after = await query(
      'SELECT google_id, email_verified_at, token_version, password_hash FROM users WHERE id = $1',
      [userId],
    );
    const row = after.rows[0];
    expect(row.google_id).toBe('mock-google-id');
    expect(row.email_verified_at).not.toBeNull();
    // The password was set by someone who never proved email ownership -> dropped.
    expect(row.password_hash).toBeNull();
    // Sessions revoked.
    expect(Number(row.token_version)).toBe(Number(before.rows[0].token_version) + 1);
  });

  it('verified Google + already-verified local account -> links, keeps password', async () => {
    process.env.MOCK_GOOGLE_EMAIL_VERIFIED = 'true';
    const { userId } = await createTestUser(MOCK_EMAIL, { verified: true });

    const res = await googleCallback();
    expect(res.statusCode).toBe(302);

    const row = (
      await query('SELECT google_id, email_verified_at, password_hash FROM users WHERE id = $1', [userId])
    ).rows[0];
    expect(row.google_id).toBe('mock-google-id');
    expect(row.email_verified_at).not.toBeNull();
    expect(row.password_hash).not.toBeNull(); // benign link keeps the password
  });

  it('UNVERIFIED Google email can never merge into / take over a local account', async () => {
    process.env.MOCK_GOOGLE_EMAIL_VERIFIED = 'false';
    const { userId } = await createTestUser(MOCK_EMAIL, { verified: true });

    const res = await googleCallback();
    expect(res.statusCode).toBe(403);
    expect((res.json() as any).error.code).toBe('EMAIL_NOT_VERIFIED');

    const row = (await query('SELECT google_id FROM users WHERE id = $1', [userId])).rows[0];
    expect(row.google_id).toBeNull();
  });

  it('new Google signup: verified immediately iff Google attests the email', async () => {
    process.env.MOCK_GOOGLE_EMAIL_VERIFIED = 'true';
    const res = await googleCallback();
    expect(res.statusCode).toBe(302);
    const row = (await query('SELECT email_verified_at, google_id FROM users WHERE email = $1', [MOCK_EMAIL]))
      .rows[0];
    expect(row.email_verified_at).not.toBeNull();
    expect(row.google_id).toBe('mock-google-id');
  });

  it('new Google signup with unverified Google email stays unverified and gets a token', async () => {
    process.env.MOCK_GOOGLE_EMAIL_VERIFIED = 'false';
    const res = await googleCallback();
    expect(res.statusCode).toBe(302);
    const row = (await query('SELECT id, email_verified_at FROM users WHERE email = $1', [MOCK_EMAIL])).rows[0];
    expect(row.email_verified_at).toBeNull();
    const t = await query('SELECT id FROM email_verification_tokens WHERE user_id = $1', [row.id]);
    expect(t.rows.length).toBe(1);
  });

  it('OAuth state is one-time: replaying a state fails', async () => {
    process.env.MOCK_GOOGLE_EMAIL_VERIFIED = 'true';
    const { state } = await createSigninState();
    const headers = { cookie: `${OAUTH_STATE_COOKIE}=${signOAuthStates([state])}` };
    const first = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=mock&state=${state}`,
      headers,
    });
    expect(first.statusCode).toBe(302);
    const replay = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=mock&state=${state}`,
      headers,
    });
    expect(replay.statusCode).toBe(400);
  });
});
