// S-03 — Proxy / rate-limit correctness: trustProxy, Redis-backed rate limits,
// login lockout with backoff, signup abuse protection, CAPTCHA hook.
// DB-backed integration tests against bseo_test_security (see tests/setup.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { buildApp } from '../src/index.js';
import { config, parseTrustProxy } from '../src/config.js';
import { query } from '../src/db.js';
import { createRateLimitStore, tenantRateLimit } from '../src/services/redisRateLimitStore.js';
import {
  clearLoginAttempts,
  isLoginLocked,
  recordFailedLogin,
  LOGIN_LOCKOUT_DEFAULTS,
} from '../src/services/loginLockout.js';
import { isDisposableEmail } from '../src/services/disposableEmail.js';
import { getCaptcha } from '../src/providers/captcha.js';
import { authHeaders, createTestUser, ensureTestDb, truncateAll } from './helpers.js';

// Namespaced Redis keys so parallel unit-test files never collide.
const NS = `bseo:test:s03:${randomBytes(4).toString('hex')}:`;
const testRedis = new Redis(config.redisUrl);

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  process.env.AUTH_RATE_LIMIT_PER_MIN = '1000';
  await ensureTestDb();
  app = await buildApp();
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  delete process.env.CAPTCHA_PROVIDER;
  delete process.env.DISPOSABLE_EMAIL_BLOCK;
  delete process.env.TENANT_EXPENSIVE_LIMIT_PER_HOUR;
  // Lockout keys: unit-level (namespaced) and route-level (production prefix).
  const unitKeys = await testRedis.keys(`${NS}loginfail:*`);
  if (unitKeys.length > 0) await testRedis.del(...unitKeys);
  const routeKeys = await testRedis.keys('bseo:loginfail:*');
  if (routeKeys.length > 0) await testRedis.del(...routeKeys);
});

afterAll(async () => {
  delete process.env.AUTH_RATE_LIMIT_PER_MIN;
  // Clean up our namespaced keys and close handles.
  const keys = await testRedis.keys(`${NS}*`);
  if (keys.length > 0) await testRedis.del(...keys);
  const lockKeys = await testRedis.keys('bseo:loginfail:*');
  if (lockKeys.length > 0) await testRedis.del(...lockKeys);
  const rlKeys = await testRedis.keys('bseo:rl:*');
  if (rlKeys.length > 0) await testRedis.del(...rlKeys);
  const acctKeys = await testRedis.keys('bseo:acct-rl:*');
  if (acctKeys.length > 0) await testRedis.del(...acctKeys);
  testRedis.disconnect();
  await app.close();
});

describe('S-03 trustProxy parsing', () => {
  it('parses env values: true/false/hop-count', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('TRUE')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('nonsense')).toBe(false);
  });

  it('defaults to fail-closed (no proxy trust)', () => {
    // TRUST_PROXY is unset in this env: req.ip must come from the socket,
    // never from X-Forwarded-For (prevents IP-spoofing of rate limits).
    expect(config.trustProxy).toBe(false);
  });
});

describe('S-03 Redis rate-limit store', () => {
  it('shares counters across store instances (multi-instance safety)', async () => {
    const Ctor = createRateLimitStore(testRedis, `${NS}rl:`);
    const a: any = new (Ctor as any)({ timeWindow: 60000, max: 3 });
    const b: any = new (Ctor as any)({ timeWindow: 60000, max: 3 });
    const incr = (s: any, k: string) =>
      new Promise<{ current: number; ttl: number }>((resolve, reject) =>
        s.incr(k, (err: Error | null, res?: { current: number; ttl: number }) =>
          err ? reject(err) : resolve(res!),
        ),
      );
    // Child stores (per-route) prefix keys per route.
    const childA = a.child({ routeInfo: { method: 'POST', url: '/login' }, timeWindow: 60000, max: 3 });
    const childB = b.child({ routeInfo: { method: 'POST', url: '/login' }, timeWindow: 60000, max: 3 });
    const r1 = await incr(childA, '1.2.3.4');
    const r2 = await incr(childB, '1.2.3.4');
    expect(r1.current).toBe(1);
    expect(r2.current).toBe(2); // second INSTANCE sees the first's count
    expect(r2.ttl).toBeGreaterThan(0);
  });
});

describe('S-03 login lockout', () => {
  const email = 'victim@example.com';
  const ip = '9.9.9.9';

  it('is not locked before the threshold', async () => {
    for (let i = 0; i < LOGIN_LOCKOUT_DEFAULTS.maxAttempts - 1; i++) {
      await recordFailedLogin(testRedis, email, ip, { keyPrefix: NS });
    }
    const s = await isLoginLocked(testRedis, email, ip, { keyPrefix: NS });
    expect(s.locked).toBe(false);
  });

  it('locks after maxAttempts failures, with exponential backoff growth', async () => {
    const opts = { maxAttempts: 3, baseLockoutMs: 60_000, maxLockoutMs: 3_600_000, keyPrefix: NS };
    for (let i = 0; i < 3; i++) await recordFailedLogin(testRedis, email, ip, opts);
    let s = await isLoginLocked(testRedis, email, ip, opts);
    expect(s.locked).toBe(false);
    await recordFailedLogin(testRedis, email, ip, opts); // 4th failure
    s = await isLoginLocked(testRedis, email, ip, opts);
    expect(s.locked).toBe(true);
    const firstBackoff = s.retryAfterMs;
    expect(firstBackoff).toBeGreaterThan(0);
    expect(firstBackoff).toBeLessThanOrEqual(60_000);
    // More failures while locked extend the lockout (exponential backoff).
    for (let i = 0; i < 3; i++) await recordFailedLogin(testRedis, email, ip, opts);
    const s2 = await isLoginLocked(testRedis, email, ip, opts);
    expect(s2.retryAfterMs).toBeGreaterThan(firstBackoff);
    expect(s2.retryAfterMs).toBeLessThanOrEqual(3_600_000); // capped
  });

  it('tracks email and IP independently (no cross-user lockout)', async () => {
    const opts = { maxAttempts: 2, baseLockoutMs: 60_000, maxLockoutMs: 3_600_000, keyPrefix: NS };
    await recordFailedLogin(testRedis, 'a@example.com', '1.1.1.1', opts);
    await recordFailedLogin(testRedis, 'a@example.com', '1.1.1.1', opts);
    await recordFailedLogin(testRedis, 'a@example.com', '1.1.1.1', opts); // locked
    expect((await isLoginLocked(testRedis, 'a@example.com', '1.1.1.1', opts)).locked).toBe(true);
    // A different email from a different IP is unaffected.
    expect((await isLoginLocked(testRedis, 'b@example.com', '2.2.2.2', opts)).locked).toBe(false);
  });

  it('successful login clears the counter', async () => {
    const opts = { maxAttempts: 2, baseLockoutMs: 60_000, maxLockoutMs: 3_600_000, keyPrefix: NS };
    await recordFailedLogin(testRedis, email, '3.3.3.3', opts);
    await recordFailedLogin(testRedis, email, '3.3.3.3', opts);
    await recordFailedLogin(testRedis, email, '3.3.3.3', opts);
    expect((await isLoginLocked(testRedis, email, '3.3.3.3', opts)).locked).toBe(true);
    await clearLoginAttempts(testRedis, email, '3.3.3.3', { keyPrefix: NS });
    expect((await isLoginLocked(testRedis, email, '3.3.3.3', opts)).locked).toBe(false);
  });
});

describe('S-03 disposable email block', () => {
  it('flags known disposable domains, passes real ones', () => {
    expect(isDisposableEmail('x@mailinator.com')).toBe(true);
    expect(isDisposableEmail('x@10minutemail.com')).toBe(true);
    expect(isDisposableEmail('x@guerrillamail.com')).toBe(true);
    expect(isDisposableEmail('x@sub.mailinator.com')).toBe(true);
    expect(isDisposableEmail('x@gmail.com')).toBe(false);
    expect(isDisposableEmail('x@beyonixsolutions.com')).toBe(false);
    expect(isDisposableEmail('not-an-email')).toBe(false);
  });
});

describe('S-03 CAPTCHA hook', () => {
  it('none provider always passes', async () => {
    process.env.CAPTCHA_PROVIDER = 'none';
    expect(await getCaptcha().verify('anything')).toBe(true);
  });

  it('test provider accepts only the test token', async () => {
    process.env.CAPTCHA_PROVIDER = 'test';
    expect(await getCaptcha().verify('captcha-test-pass')).toBe(true);
    expect(await getCaptcha().verify('bogus')).toBe(false);
    expect(await getCaptcha().verify('')).toBe(false);
  });

  it('hcaptcha fails closed without a secret', async () => {
    process.env.CAPTCHA_PROVIDER = 'hcaptcha';
    expect(await getCaptcha().verify('some-token')).toBe(false);
  });
});

describe('S-03 HTTP: signup abuse protection', () => {
  it('blocks disposable emails when DISPOSABLE_EMAIL_BLOCK=true', async () => {
    process.env.DISPOSABLE_EMAIL_BLOCK = 'true';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'junk@mailinator.com', password: 'J7#kP9!mV2@qX5$zR8&' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as any).error.code).toBe('VALIDATION_ERROR');
    const r = await query('SELECT id FROM users WHERE email = $1', ['junk@mailinator.com']);
    expect(r.rows.length).toBe(0);
  });

  it('allows disposable emails when the block is off (default)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'junk2@mailinator.com', password: 'J7#kP9!mV2@qX5$zR8&' },
    });
    expect(res.statusCode).toBe(201);
  });

  it('requires a CAPTCHA token when CAPTCHA_PROVIDER=test', async () => {
    process.env.CAPTCHA_PROVIDER = 'test';
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'nocap@example.com', password: 'J7#kP9!mV2@qX5$zR8&' },
    });
    expect(missing.statusCode).toBe(400);
    expect((missing.json() as any).error.code).toBe('CAPTCHA_FAILED');
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'nocap@example.com', password: 'J7#kP9!mV2@qX5$zR8&', captchaToken: 'wrong' },
    });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'capok@example.com', password: 'J7#kP9!mV2@qX5$zR8&', captchaToken: 'captcha-test-pass' },
    });
    expect(good.statusCode).toBe(201);
  });
});

describe('S-03 HTTP: login lockout end-to-end', () => {
  // Fixed TEST-NET-3 source IP: per-IP lockout state must not leak into
  // other test files (all injects default to 127.0.0.1).
  const REMOTE = '203.0.113.7';
  const via = (payload: object) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', payload, remoteAddress: REMOTE });

  it('locks the account after repeated bad passwords (generic messages)', { timeout: 30000 }, async () => {
    const email = 'locked@example.com';
    await createTestUser(email, { password: 'Correct1!' });
    let last: any;
    for (let i = 0; i < 6; i++) {
      last = await via({ email, password: 'WrongPassword!' });
      expect(last.statusCode).toBe(401);
    }
    const locked = await via({ email, password: 'WrongPassword!' });
    expect(locked.statusCode).toBe(429);
    expect((locked.json() as any).error.code).toBe('LOGIN_LOCKED');
    // Generic: locked even with the RIGHT password; no existence signal.
    const rightPw = await via({ email, password: 'Correct1!' });
    expect(rightPw.statusCode).toBe(429);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nosuchuser@example.com', password: 'WrongPassword!' },
      remoteAddress: '203.0.113.99', // different IP: not locked
    });
    expect(unknown.statusCode).toBe(401);
    expect((unknown.json() as any).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('lockout state is shared across app instances (Redis-backed)', { timeout: 30000 }, async () => {
    const email = 'shared@example.com';
    await createTestUser(email, { password: 'Correct1!' });
    const app2 = await buildApp();
    await app2.ready();
    try {
      for (let i = 0; i < 6; i++) {
        await app2.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email, password: 'WrongPassword!' },
          remoteAddress: REMOTE,
        });
      }
      // The FIRST instance must observe the lockout created via the second.
      const viaApp1 = await via({ email, password: 'WrongPassword!' });
      expect(viaApp1.statusCode).toBe(429);
      expect((viaApp1.json() as any).error.code).toBe('LOGIN_LOCKED');
    } finally {
      await app2.close();
    }
  });
});

describe('S-03 HTTP: per-account rate limits', () => {
  it('tenantRateLimit 429s a tenant that exceeds max/window', async () => {
    const Fastify = (await import('fastify')).default;
    const mini = Fastify();
    mini.post(
      '/expensive',
      {
        preHandler: tenantRateLimit({
          redis: testRedis,
          max: 3,
          windowMs: 60_000,
          keyPrefix: `${NS}acct:`,
          keyFn: () => 'tenant-xyz',
        }),
      },
      async () => ({ ok: true }),
    );
    await mini.ready();
    try {
      for (let i = 0; i < 3; i++) {
        const r = await mini.inject({ method: 'POST', url: '/expensive' });
        expect(r.statusCode).toBe(200);
      }
      const over = await mini.inject({ method: 'POST', url: '/expensive' });
      expect(over.statusCode).toBe(429);
      // Mini app has no contract error envelope; the message is what matters.
      expect((over.json() as any).message).toContain('Too many requests');
    } finally {
      await mini.close();
    }
  });
});

describe('S-03 HTTP: expensive routes carry per-tenant limits', () => {
  it('keywords/research is tenant rate-limited (429 after burst)', async () => {
    await createTestUser('rlexp@example.com', { password: 'Correct1!', verified: true });
    const token = (await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'rlexp@example.com', password: 'Correct1!' },
    }).then((r) => r.json() as any)).token as string;
    const site = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: authHeaders(token),
      payload: { domain: 'rl-test.example' },
    });
    expect(site.statusCode).toBe(201);
    const siteId = (site.json() as any).id as string;
    // TENANT_EXPENSIVE_LIMIT_PER_HOUR is lowered via live env for this test.
    process.env.TENANT_EXPENSIVE_LIMIT_PER_HOUR = '3';
    let saw429 = false;
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({
        method: 'POST',
        url: `/api/v1/sites/${siteId}/keywords/research`,
        headers: authHeaders(token),
        payload: { seeds: ['seo'] },
      });
      if (r.statusCode === 429) {
        saw429 = true;
        expect((r.json() as any).error.code).toBe('RATE_LIMITED');
        break;
      }
      expect([200, 201].includes(r.statusCode)).toBe(true);
    }
    expect(saw429).toBe(true);
  });
});
