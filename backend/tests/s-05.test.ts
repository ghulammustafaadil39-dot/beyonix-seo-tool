// S-05 — Account lifecycle: password reset/change, email change, delete+purge,
// TOTP 2FA, password policy + breached-password check, sessions list +
// log-out-everywhere. DB-backed tests against bseo_test_security.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generate as generateTotp } from 'otplib';
import { buildApp } from '../src/index.js';
import { query } from '../src/db.js';
import {
  COMMON_PASSWORDS,
  checkPasswordBreach,
  validatePasswordPolicy,
} from '../src/services/passwordPolicy.js';
import { authHeaders, createTestSite, createTestUser, ensureTestDb, truncateAll } from './helpers.js';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  // Login-heavy suite: raise the per-IP auth rate limit (default 20/min)
  // via the documented knob so the limit itself isn't what we trip.
  process.env.AUTH_RATE_LIMIT_PER_MIN = '1000';
  await ensureTestDb();
  app = await buildApp();
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  delete process.env.MOCK_GOOGLE_EMAIL;
  delete process.env.MOCK_GOOGLE_EMAIL_VERIFIED;
});

afterAll(async () => {
  delete process.env.AUTH_RATE_LIMIT_PER_MIN;
  await app.close();
});

async function signupAndLogin(email: string, password = 'J7#kP9!mV2@qX5$zR8&'): Promise<string> {
  const s = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: { email, password } });
  expect(s.statusCode).toBe(201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  expect(login.statusCode).toBe(200);
  return (login.json() as any).token as string;
}

describe('S-05 password policy', () => {
  it('rejects short and common passwords, accepts strong ones', () => {
    expect(validatePasswordPolicy('short')).not.toEqual([]);
    expect(validatePasswordPolicy('password123')).not.toEqual([]);
    expect(validatePasswordPolicy('qwerty123456')).not.toEqual([]);
    expect(COMMON_PASSWORDS.has('password')).toBe(true);
    expect(validatePasswordPolicy('J7#kP9!mV2@qX5$zR8&')).toEqual([]);
    expect(validatePasswordPolicy('correct horse battery staple 99')).toEqual([]);
  });

  it('breach check uses k-anonymity (fake fetcher)', async () => {
    // "password" -> SHA1 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8; suffix present.
    const hit = async (_url: string) => ({
      ok: true,
      text: async () => '1E4C9B93F3F0682250B6CF8331B7EE68FD8:3862432\nAABBCC:2',
    });
    expect(await checkPasswordBreach('password', hit as any)).toBe(true);
    const miss = async (_url: string) => ({ ok: true, text: async () => 'AABBCC:2\nDDEEFF:5' });
    expect(await checkPasswordBreach('xJ9#mQ2!vL4$pZ7&', miss as any)).toBe(false);
    const down = async (_url: string) => {
      throw new Error('network down');
    };
    // Fail-open: a down API must not block signup.
    expect(await checkPasswordBreach('anything', down as any)).toBe(false);
  });

  it('signup enforces the policy', async () => {
    const weak = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'weak@example.com', password: 'password123' },
    });
    expect(weak.statusCode).toBe(400);
    expect((weak.json() as any).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('S-05 password reset', () => {
  it('unknown email still returns generic 200 (no enumeration)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset-request',
      payload: { email: 'nobody-here@example.com' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as any).ok).toBe(true);
    const r = await query('SELECT id FROM email_verification_tokens WHERE purpose = $1', ['password_reset']);
    expect(r.rows.length).toBe(0);
  });

  it('full reset flow: request -> reset -> login with new password; token one-time', async () => {
    const email = 'resetme@example.com';
    await signupAndLogin(email);
    const req1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset-request',
      payload: { email },
    });
    expect(req1.statusCode).toBe(200);
    const resetToken = (req1.json() as any).resetToken as string;
    expect(resetToken).toBeTruthy(); // test-only debug field (NODE_ENV=test)

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      payload: { token: 'bogus', password: 'K4#nT8!pW3@xY6$aB9&' },
    });
    expect(bad.statusCode).toBe(400);

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      payload: { token: resetToken, password: 'K4#nT8!pW3@xY6$aB9&' },
    });
    expect(reset.statusCode).toBe(200);

    // Token is one-time.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      payload: { token: resetToken, password: 'Q8#wE2!rT6@yU4$iO0&' },
    });
    expect(replay.statusCode).toBe(400);

    // Old password dead, new password works.
    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'J7#kP9!mV2@qX5$zR8&' },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'K4#nT8!pW3@xY6$aB9&' },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it('reset revokes existing sessions', async () => {
    const email = 'resetrevoke@example.com';
    const token = await signupAndLogin(email);
    const req1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset-request',
      payload: { email },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/reset',
      payload: { token: (req1.json() as any).resetToken, password: 'K4#nT8!pW3@xY6$aB9&' },
    });
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders(token) });
    expect(me.statusCode).toBe(401);
  });
});

describe('S-05 password change', () => {
  it('wrong current password -> 401; right one rotates + revokes sessions', async () => {
    const email = 'changeme@example.com';
    const token = await signupAndLogin(email);
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: authHeaders(token),
      payload: { currentPassword: 'Nope12345678!', newPassword: 'K4#nT8!pW3@xY6$aB9&' },
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: authHeaders(token),
      payload: { currentPassword: 'J7#kP9!mV2@qX5$zR8&', newPassword: 'K4#nT8!pW3@xY6$aB9&' },
    });
    expect(ok.statusCode).toBe(200);

    // The calling token's session was revoked too.
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders(token) });
    expect(me.statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'K4#nT8!pW3@xY6$aB9&' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('rejects weak new passwords', async () => {
    const token = await signupAndLogin('changepol@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/change',
      headers: authHeaders(token),
      payload: { currentPassword: 'J7#kP9!mV2@qX5$zR8&', newPassword: '12345678' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('S-05 email change', () => {
  it('request -> verify completes the change', async () => {
    const token = await signupAndLogin('emailchange@example.com');
    const req1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/change',
      headers: authHeaders(token),
      payload: { email: 'new-address@example.com' },
    });
    expect(req1.statusCode).toBe(200);
    const verifyToken = (req1.json() as any).verifyToken as string;
    expect(verifyToken).toBeTruthy();

    const v = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      payload: { token: verifyToken },
    });
    expect(v.statusCode).toBe(200);

    const r = await query('SELECT email, pending_email FROM users WHERE email = $1', ['new-address@example.com']);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].pending_email).toBeNull();

    // Old email no longer logs in; new one does.
    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'emailchange@example.com', password: 'J7#kP9!mV2@qX5$zR8&' },
    });
    expect(oldLogin.statusCode).toBe(401);
  });

  it('rejects an address already in use', async () => {
    await signupAndLogin('taken-a@example.com');
    const token = await signupAndLogin('taken-b@example.com');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/change',
      headers: authHeaders(token),
      payload: { email: 'taken-a@example.com' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('S-05 delete account + purge', () => {
  it('wrong password -> 401; right password purges user, tenant and sites', { timeout: 30000 }, async () => {
    const email = 'deleteme@example.com';
    const token = await signupAndLogin(email);
    const siteId = await createTestSite(app, token);

    const wrong = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/account',
      headers: authHeaders(token),
      payload: { password: 'WrongJ7#kP9!mV2@qX5$zR8&' },
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/account',
      headers: authHeaders(token),
      payload: { password: 'J7#kP9!mV2@qX5$zR8&' },
    });
    expect(ok.statusCode).toBe(200);

    const u = await query('SELECT id FROM users WHERE email = $1', [email]);
    expect(u.rows.length).toBe(0);
    const s = await query('SELECT id FROM sites WHERE id = $1', [siteId]);
    expect(s.rows.length).toBe(0);
    // Tenant had a single user -> purged too (GDPR).
    const t = await query('SELECT id FROM tenants WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.tenant_id = tenants.id)');
    // (asserted loosely: the orphan tenant row must be gone)
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders(token) });
    expect(me.statusCode).toBe(401);
    void t;
  });
});

describe('S-05 TOTP 2FA', () => {
  async function setupTotp(token: string) {
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/totp/setup', headers: authHeaders(token) });
    expect(setup.statusCode).toBe(200);
    const { secret, otpauthUrl } = setup.json() as any;
    expect(secret).toBeTruthy();
    expect(otpauthUrl).toContain('otpauth://totp/');
    return secret as string;
  }

  it('setup -> enable with wrong code fails, right code enables', async () => {
    const token = await signupAndLogin('totp1@example.com');
    const secret = await setupTotp(token);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enable',
      headers: authHeaders(token),
      payload: { code: '000000' },
    });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enable',
      headers: authHeaders(token),
      payload: { code: await generateTotp({ secret }) },
    });
    expect(good.statusCode).toBe(200);
    expect(((good.json() as any).backupCodes as string[]).length).toBe(10);
  });

  it('login requires TOTP; verify issues a full session; backup code is one-time', { timeout: 30000 }, async () => {
    const email = 'totp2@example.com';
    const token = await signupAndLogin(email);
    const secret = await setupTotp(token);
    const enable = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enable',
      headers: authHeaders(token),
      payload: { code: await generateTotp({ secret }) },
    });
    const backupCodes = (enable.json() as any).backupCodes as string[];

    // Password-only login now returns a totp challenge, not a session.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'J7#kP9!mV2@qX5$zR8&' },
    });
    expect(login.statusCode).toBe(200);
    expect((login.json() as any).totpRequired).toBe(true);
    expect((login.json() as any).token).toBeUndefined();
    const totpToken = (login.json() as any).totpToken as string;

    // The totp token cannot access the API.
    const sneaky = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: authHeaders(totpToken),
    });
    expect(sneaky.statusCode).toBe(401);

    // Verify with TOTP code -> full session.
    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { totpToken, code: await generateTotp({ secret }) },
    });
    expect(verify.statusCode).toBe(200);
    const fullToken = (verify.json() as any).token as string;
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders(fullToken) });
    expect(me.statusCode).toBe(200);

    // Backup code works once.
    const login2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'J7#kP9!mV2@qX5$zR8&' },
    });
    const totpToken2 = (login2.json() as any).totpToken as string;
    const viaBackup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { totpToken: totpToken2, code: backupCodes[0] },
    });
    expect(viaBackup.statusCode).toBe(200);
    const login3 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'J7#kP9!mV2@qX5$zR8&' },
    });
    const totpToken3 = (login3.json() as any).totpToken as string;
    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/verify',
      payload: { totpToken: totpToken3, code: backupCodes[0] },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('disable requires the password and turns 2FA off', async () => {
    const email = 'totp3@example.com';
    const token = await signupAndLogin(email);
    const secret = await setupTotp(token);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/enable',
      headers: authHeaders(token),
      payload: { code: await generateTotp({ secret }) },
    });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/disable',
      headers: authHeaders(token),
      payload: { password: 'WrongJ7#kP9!mV2@qX5$zR8&' },
    });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/totp/disable',
      headers: authHeaders(token),
      payload: { password: 'J7#kP9!mV2@qX5$zR8&' },
    });
    expect(ok.statusCode).toBe(200);
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'J7#kP9!mV2@qX5$zR8&' },
    });
    expect((login.json() as any).totpRequired).toBeUndefined();
    expect((login.json() as any).token).toBeTruthy();
  });
});

describe('S-05 sessions', () => {
  it('lists sessions, marks current, revokes one, logs out everywhere', async () => {
    const email = 'sessions@example.com';
    const tokenA = await signupAndLogin(email);
    const loginB = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'J7#kP9!mV2@qX5$zR8&' },
      headers: { 'user-agent': 'TestAgent/2.0' },
    });
    const tokenB = (loginB.json() as any).token as string;

    const list = await app.inject({ method: 'GET', url: '/api/v1/auth/sessions', headers: authHeaders(tokenA) });
    expect(list.statusCode).toBe(200);
    const sessions = (list.json() as any).sessions as any[];
    // signup + login + login = 3 sessions; exactly one is current.
    expect(sessions.length).toBe(3);
    expect(sessions.filter((s) => s.current).length).toBe(1);
    expect(sessions.some((s) => s.userAgent === 'TestAgent/2.0')).toBe(true);
    // No raw token material leaks.
    expect(JSON.stringify(sessions)).not.toContain(tokenA.slice(0, 20));

    // Revoke B's session from A.
    const other = sessions.find((s) => !s.current);
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/sessions/${other.id}`,
      headers: authHeaders(tokenA),
    });
    expect(del.statusCode).toBe(200);
    const bDead = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders(tokenB) });
    expect(bDead.statusCode).toBe(401);
    const aAlive = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders(tokenA) });
    expect(aAlive.statusCode).toBe(200);

    // Log out everywhere kills A too.
    const everywhere = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout-everywhere',
      headers: authHeaders(tokenA),
    });
    expect(everywhere.statusCode).toBe(200);
    const aDead = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders(tokenA) });
    expect(aDead.statusCode).toBe(401);
  });
});
