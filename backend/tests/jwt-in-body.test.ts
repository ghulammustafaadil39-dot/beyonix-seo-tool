// JWT-in-body regression: the session JWT must be delivered ONLY via the
// httpOnly `bseo_token` cookie, never in a JSON response body. A body token
// widens the XSS blast radius (any script can read it) for zero benefit —
// the frontend authenticates via the cookie.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generate as generateTotp } from 'otplib';
import { buildApp } from '../src/index.js';
import { ensureTestDb, truncateAll } from './helpers.js';

const PW = 'J7#kP9!mV2@qX5$zR8&';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  process.env.AUTH_RATE_LIMIT_PER_MIN = '1000';
  await ensureTestDb();
  app = await buildApp();
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  delete process.env.AUTH_RATE_LIMIT_PER_MIN;
  await app.close();
});

/** Builds a cookie jar (plus CSRF echo header) from a response's set-cookie. */
function cookieJarFrom(res: { headers: any }): Record<string, string> {
  const raw = res.headers['set-cookie'];
  const list: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const pairs = list.map((c: string) => c.split(';')[0]);
  // The session must still be delivered — via the httpOnly cookie.
  expect(
    pairs.some((p) => p.startsWith('bseo_token=')),
    'expected bseo_token httpOnly cookie to be set',
  ).toBe(true);
  const csrf = pairs.find((p) => p.startsWith('bseo_csrf='))?.slice('bseo_csrf='.length) ?? '';
  return { cookie: pairs.join('; '), 'x-csrf-token': csrf };
}

describe('JWT-in-body regression', () => {
  it('signup: no `token` field in JSON body; session arrives via httpOnly cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'nobody1@example.com', password: PW, name: 'No Body' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('token');
    // The cookie session must still work.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: cookieJarFrom(res),
    });
    expect(me.statusCode).toBe(200);
  });

  it('login: no `token` field in JSON body; session arrives via httpOnly cookie', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'nobody2@example.com', password: PW },
    });
    expect(signup.statusCode).toBe(201);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody2@example.com', password: PW },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).not.toHaveProperty('token');
    // totpRequired logins keep their short-lived challenge token (the UI
    // needs it for the 2FA step); it is not a session token.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: cookieJarFrom(res),
    });
    expect(me.statusCode).toBe(200);
  });

  it('totp/verify: no `token` field in JSON body; session arrives via httpOnly cookie', async () => {
    const email = 'nobody3@example.com';
    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email, password: PW },
    });
    expect(signup.statusCode).toBe(201);
    const jar = cookieJarFrom(signup);

    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/setup',
      headers: jar,
    });
    expect(setup.statusCode).toBe(200);
    const { secret } = setup.json() as any;
    const enable = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enable',
      headers: jar,
      payload: { code: await generateTotp({ secret }) },
    });
    expect(enable.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: PW },
    });
    expect(login.statusCode).toBe(200);
    expect((login.json() as any).totpRequired).toBe(true);
    const totpToken = (login.json() as any).totpToken as string;

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { totpToken, code: await generateTotp({ secret }) },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json() as Record<string, unknown>).not.toHaveProperty('token');
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: cookieJarFrom(verify),
    });
    expect(me.statusCode).toBe(200);
  });
});
