// S-04 — OAuth state in Redis + signed httpOnly cookie binding + PKCE.
// DB-backed integration tests against bseo_test_security (see tests/setup.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { buildApp } from '../src/index.js';
import { config } from '../src/config.js';
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
  codeChallenge,
  consumeGscState,
  consumeSigninState,
  createGscState,
  createSigninState,
  signOAuthStates,
  verifyOAuthStates,
} from '../src/services/oauthState.js';
import { authHeaders, createTestSite, createTestUser, ensureTestDb, truncateAll } from './helpers.js';

const NS = `bseo:test:s04:${randomBytes(4).toString('hex')}:`;
const testRedis = new Redis(config.redisUrl);
const opts = { keyPrefix: NS };

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  await ensureTestDb();
  app = await buildApp();
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  const keys = await testRedis.keys(`${NS}*`);
  if (keys.length > 0) await testRedis.del(...keys);
  testRedis.disconnect();
  await app.close();
});

function stateFromLocation(location: string | undefined): string {
  const m = /[?&]state=([^&]+)/.exec(location ?? '');
  if (!m) throw new Error(`no state in Location: ${location}`);
  return decodeURIComponent(m[1]);
}

function cookieFromSetCookie(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie.find((h) => h.startsWith(`${OAUTH_STATE_COOKIE}=`)) : setCookie;
  if (!header || !header.startsWith(`${OAUTH_STATE_COOKIE}=`)) throw new Error('oauth state cookie not set');
  return header.split(';')[0].slice(OAUTH_STATE_COOKIE.length + 1);
}

describe('S-04 OAuth state store (Redis)', () => {
  it('signin state is one-time use', async () => {
    const { state } = await createSigninState(testRedis, opts);
    const first = await consumeSigninState(state, testRedis, opts);
    expect(first?.codeVerifier).toBeTruthy();
    expect(await consumeSigninState(state, testRedis, opts)).toBeNull();
  });

  it('gsc state round-trips tenant+site binding and is one-time', async () => {
    const { state } = await createGscState({ tenantId: 't1', siteId: 's1' }, testRedis, opts);
    const got = await consumeGscState(state, testRedis, opts);
    expect(got?.data).toEqual({ tenantId: 't1', siteId: 's1' });
    expect(got?.codeVerifier).toBeTruthy();
    expect(await consumeGscState(state, testRedis, opts)).toBeNull();
  });

  it('state is shared across Redis clients (multi-instance safety)', async () => {
    const other = new Redis(config.redisUrl);
    try {
      const { state } = await createSigninState(testRedis, opts);
      // A DIFFERENT client (another API instance) can consume it: the store
      // is Redis, not process memory.
      const got = await consumeSigninState(state, other, opts);
      expect(got?.codeVerifier).toBeTruthy();
    } finally {
      other.disconnect();
    }
  });

  it('records expire (TTL ~15 min)', async () => {
    const { state } = await createSigninState(testRedis, opts);
    const ttl = await testRedis.pttl(`${NS}oauth:signin:${state}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(OAUTH_STATE_TTL_MS);
  });

  it('PKCE challenge matches the stored verifier', async () => {
    const created = await createSigninState(testRedis, opts);
    const consumed = await consumeSigninState(created.state, testRedis, opts);
    expect(codeChallenge(consumed!.codeVerifier)).toBe(created.codeChallenge);
    // Challenge is base64url(sha256) — 43 chars, no padding.
    expect(created.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('S-04 signed state cookie', () => {
  it('verifies a signed state list, rejects tampering', () => {
    const cookie = signOAuthStates(['state-a', 'state-b']);
    expect(verifyOAuthStates(cookie, 'state-a')).toBe(true);
    expect(verifyOAuthStates(cookie, 'state-b')).toBe(true);
    expect(verifyOAuthStates(cookie, 'state-c')).toBe(false);
    expect(verifyOAuthStates(undefined, 'state-a')).toBe(false);
    expect(verifyOAuthStates('', 'state-a')).toBe(false);
    // Tampered payload fails the HMAC check.
    const [payload, sig] = cookie.split('.');
    const evil = Buffer.from(JSON.stringify(['state-c']), 'utf8').toString('base64url');
    expect(verifyOAuthStates(`${evil}.${sig}`, 'state-c')).toBe(false);
    // Truncated signature fails.
    expect(verifyOAuthStates(`${payload}.deadbeef`, 'state-a')).toBe(false);
  });
});

describe('S-04 HTTP: Google sign-in flow binding', () => {
  async function startFlow() {
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/google' });
    expect(res.statusCode).toBe(302);
    return {
      state: stateFromLocation(res.headers.location),
      cookie: cookieFromSetCookie(res.headers['set-cookie']),
      setCookieHeader: res.headers['set-cookie'] as string,
    };
  }

  it('sets a signed httpOnly state cookie on flow start', async () => {
    const { setCookieHeader } = await startFlow();
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('SameSite=Lax');
  });

  it('rejects the callback without the binding cookie (login-CSRF defense)', async () => {
    const { state } = await startFlow();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=mock&state=${state}`,
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as any).error.code).toBe('INVALID_STATE');
  });

  it('rejects the callback when the cookie names a different state', async () => {
    const { state } = await startFlow();
    const other = signOAuthStates(['some-other-state']);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=mock&state=${state}`,
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${other}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('completes the full flow with cookie + one-time state', async () => {
    const { state, cookie } = await startFlow();
    const headers = { cookie: `${OAUTH_STATE_COOKIE}=${cookie}` };
    const ok = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=mock&state=${state}`,
      headers,
    });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toContain('/dashboard');
    // Replaying the same state fails (one-time use).
    const replay = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=mock&state=${state}`,
      headers,
    });
    expect(replay.statusCode).toBe(400);
  });
});

describe('S-04 HTTP: GSC connect flow binding', () => {
  it('auth-url sets the cookie; callback requires it', async () => {
    await createTestUser('gscflow@example.com', { password: 'Correct1!', verified: true });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'gscflow@example.com', password: 'Correct1!' },
    });
    const token = (login.json() as any).token as string;
    const siteId = await createTestSite(app, token);

    const authUrl = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${siteId}/gsc/auth-url`,
      headers: authHeaders(token),
    });
    expect(authUrl.statusCode).toBe(200);
    const state = stateFromLocation((authUrl.json() as any).url);
    const cookie = cookieFromSetCookie(authUrl.headers['set-cookie']);

    // No cookie -> rejected.
    const noCookie = await app.inject({
      method: 'GET',
      url: `/api/v1/gsc/callback?code=mock&state=${state}`,
    });
    expect(noCookie.statusCode).toBe(400);

    // With cookie -> connected.
    const ok = await app.inject({
      method: 'GET',
      url: `/api/v1/gsc/callback?code=mock&state=${state}`,
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${cookie}` },
    });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toContain('gsc=1');
  });
});

describe('S-04 HTTP: GA4 connect flow binding', () => {
  it('auth-url sets the cookie; callback requires it', async () => {
    await createTestUser('ga4flow@example.com', { password: 'Correct1!', verified: true });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'ga4flow@example.com', password: 'Correct1!' },
    });
    const token = (login.json() as any).token as string;
    const siteId = await createTestSite(app, token);

    const authUrl = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${siteId}/ga4/auth-url`,
      headers: authHeaders(token),
    });
    expect(authUrl.statusCode).toBe(200);
    const state = stateFromLocation((authUrl.json() as any).url);
    const cookie = cookieFromSetCookie(authUrl.headers['set-cookie']);

    const noCookie = await app.inject({
      method: 'GET',
      url: `/api/v1/ga4/callback?code=mock&state=${state}`,
    });
    expect(noCookie.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'GET',
      url: `/api/v1/ga4/callback?code=mock&state=${state}`,
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${cookie}` },
    });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toContain('ga4=1');
  });
});
