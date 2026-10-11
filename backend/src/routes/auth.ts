import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool, query } from '../db.js';
import { ApiError, conflict, validationError } from '../errors.js';
import {
  authPlugin,
  clearAuthCookie,
  hashPassword,
  setAuthCookie,
  setCsrfCookie,
  signToken,
  verifyPassword,
} from '../middleware/auth.js';
import { humanUserId, requireHumanSession } from '../middleware/access.js';
import { issueCsrfToken } from '../middleware/csrf.js';
import { getGoogle } from '../providers/google.js';
import { getCaptcha, isCaptchaRequired } from '../providers/captcha.js';
import { getRedis } from '../redis.js';
import { getPlan } from '../plans.js';
import {
  OAUTH_STATE_COOKIE,
  clearOAuthStateCookie,
  consumeSigninState,
  createSigninState,
  setOAuthStateCookie,
  verifyOAuthStates,
} from '../services/oauthState.js';
import { isDisposableEmail } from '../services/disposableEmail.js';
import {
  clearLoginAttempts,
  isLoginLocked,
  recordFailedLogin,
} from '../services/loginLockout.js';
import {
  assertResendAllowed,
  consumeVerificationToken,
  issueVerificationToken,
  sendEmailChangeEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from '../services/emailVerification.js';
import { validatePassword } from '../services/passwordPolicy.js';
import {
  beginTotpSetup,
  disableTotp,
  enableTotp,
  getTotpState,
  isTotpEnabled,
  verifyTotpOrBackup,
} from '../services/totp.js';
import {
  createSession,
  hashJti,
  listSessions,
  revokeAllSessions,
  revokeSession,
} from '../services/sessions.js';
import { newTenantTrialEndsAt } from '../services/billing.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Debug helper: in test env only, the raw verification token is returned so
 * integration tests can complete the flow without reading email. */
function testVerifyTokenField(rawToken: string): Record<string, string> {
  return config.nodeEnv === 'test' ? { verifyToken: rawToken } : {};
}

/** S-05: same pattern for the password-reset debug token. */
function testResetTokenField(rawToken: string | null): Record<string, string> {
  return config.nodeEnv === 'test' && rawToken ? { resetToken: rawToken } : {};
}

/**
 * S-05: issues an auth token AND registers the server-side session (for the
 * session list / per-session revocation), then sets the auth cookie.
 * S-06: also sets the readable CSRF double-submit cookie.
 */
async function issueAuthSession(
  req: any,
  reply: any,
  userId: string,
  tenantId: string,
  tokenVersion: number,
): Promise<string> {
  const token = signToken(userId, tenantId, tokenVersion);
  const decoded = jwt.decode(token) as { jti?: string } | null;
  if (decoded?.jti) {
    await createSession(
      userId,
      decoded.jti,
      req.headers?.['user-agent'] as string | undefined,
      req.ip,
    );
  }
  setAuthCookie(reply, token);
  setCsrfCookie(reply, issueCsrfToken());
  return token;
}

const signupSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', maxLength: 320 },
      password: { type: 'string', maxLength: 200 },
      name: { type: 'string', maxLength: 200 },
      // S-03: CAPTCHA token (required only when a CAPTCHA provider is configured).
      captchaToken: { type: 'string', maxLength: 2000 },
    },
    additionalProperties: false,
  },
} as const;

const loginSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', maxLength: 320 },
      password: { type: 'string', maxLength: 200 },
    },
    additionalProperties: false,
  },
} as const;

const oauthCallbackSchema = {
  querystring: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      state: { type: 'string' },
    },
  },
} as const;

const verifyEmailSchema = {
  body: {
    type: 'object',
    required: ['token'],
    properties: { token: { type: 'string', minLength: 8, maxLength: 200 } },
    additionalProperties: false,
  },
} as const;

const resendEmailSchema = {
  body: {
    type: 'object',
    required: ['email'],
    properties: { email: { type: 'string', maxLength: 320 } },
    additionalProperties: false,
  },
} as const;

async function isEmailVerified(userId: string): Promise<boolean> {
  const r = await query('SELECT email_verified_at FROM users WHERE id = $1', [userId]);
  return r.rows[0]?.email_verified_at != null;
}

/** Creates a tenant+user for Google sign-in. Verified iff Google attests the email. */
async function createGoogleUser(
  cleanEmail: string,
  profile: { name: string; googleId: string; emailVerified: boolean },
): Promise<{ userId: string; tenantId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query(
      `INSERT INTO tenants (id, name, plan_id, trial_ends_at)
       VALUES (gen_random_uuid(), $1, 'starter', $2)
       RETURNING id`,
      [profile.name, newTenantTrialEndsAt()],
    );
    const tenantId = t.rows[0].id as string;
    const u = await client.query(
      `INSERT INTO users (id, tenant_id, email, name, role, google_id, email_verified_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'owner', $4, ${profile.emailVerified ? 'now()' : 'NULL'})
       RETURNING id`,
      [tenantId, cleanEmail, profile.name, profile.googleId || null],
    );
    const userId = u.rows[0].id as string;
    await client.query('COMMIT');
    if (!profile.emailVerified) {
      // After commit: the token row FK-references the now-visible user.
      const rawToken = await issueVerificationToken(userId, 'signup');
      await sendVerificationEmail(cleanEmail, profile.name, rawToken);
    }
    return { userId, tenantId };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback errors */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** S-05/S-01: completes a pending email change after the new address is verified. */
export async function confirmEmailChange(userId: string): Promise<void> {
  const r = await query('SELECT pending_email FROM users WHERE id = $1', [userId]);
  const pending = (r.rows[0]?.pending_email as string | null) ?? null;
  if (!pending) return;
  const clash = await query('SELECT id FROM users WHERE email = $1 AND id <> $2', [pending, userId]);
  if (clash.rows.length > 0) {
    throw new ApiError(409, 'EMAIL_EXISTS', 'That email address is already in use');
  }
  // C1-L-16: the clash check is check-then-act — two concurrent confirms
  // for the same address race to the unique constraint. Translate the
  // 23505 into the same clean 409 as the check above instead of a raw 500.
  try {
    await query(
      `UPDATE users SET email = $2, pending_email = NULL, email_verified_at = now() WHERE id = $1`,
      [userId, pending],
    );
  } catch (err: any) {
    if (err?.code === '23505') {
      throw new ApiError(409, 'EMAIL_EXISTS', 'That email address is already in use');
    }
    throw err;
  }
}

/** S-03: live re-read of the disposable-email toggle (test hook friendly). */
function disposableBlockEnabled(): boolean {
  return process.env.DISPOSABLE_EMAIL_BLOCK === 'true' || config.disposableEmailBlock;
}

/** S-03: strict per-IP limit for auth endpoints (default 20/min). */
function authStrictLimit(): number {
  const v = parseInt(process.env.AUTH_RATE_LIMIT_PER_MIN ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 20;
}

export async function registerAuthRoutes(fastify: FastifyInstance) {
  // Brute-force guard: auth endpoints get a much stricter limit than the
  // global per-IP limit. The max is re-read per registration (live env
  // fallback) so tests can raise it via AUTH_RATE_LIMIT_PER_MIN without
  // changing the production default of 20.
  const strictRateLimit = () => ({
    config: { rateLimit: { max: authStrictLimit(), timeWindow: '1 minute' } },
  });

  fastify.post('/auth/signup', { schema: signupSchema, ...strictRateLimit() }, async (req, reply) => {
    const { email, password, name, captchaToken } = req.body as {
      email: string;
      password: string;
      name?: string;
      captchaToken?: string;
    };
    const cleanEmail = (email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail)) throw validationError('Invalid email address');
    // S-05: password policy (length, common-password list, breach corpus).
    const pwProblems = await validatePassword(password ?? '');
    if (pwProblems.length > 0) throw validationError(pwProblems[0]);
    // S-03: optional disposable-email block (signup abuse protection).
    if (disposableBlockEnabled() && isDisposableEmail(cleanEmail)) {
      throw validationError('Please sign up with a permanent email address');
    }
    // S-03: CAPTCHA when a provider is configured.
    if (isCaptchaRequired()) {
      const ok = await getCaptcha().verify(captchaToken ?? '', req.ip);
      if (!ok) throw new ApiError(400, 'CAPTCHA_FAILED', 'CAPTCHA verification failed — please try again');
    }

    const existing = await query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) throw conflict('EMAIL_EXISTS', 'An account with this email already exists');

    const displayName = (name ?? '').trim() || cleanEmail.split('@')[0];

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const t = await client.query(
        `INSERT INTO tenants (id, name, plan_id, trial_ends_at)
         VALUES (gen_random_uuid(), $1, 'starter', $2)
         RETURNING id, name, plan_id`,
        [displayName, newTenantTrialEndsAt()],
      );
      const tenantId = t.rows[0].id as string;
      const pwHash = await hashPassword(password);
      const u = await client.query(
        `INSERT INTO users (id, tenant_id, email, password_hash, name, role)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'owner')
         RETURNING id, email, name, token_version`,
        [tenantId, cleanEmail, pwHash, displayName],
      );
      await client.query('COMMIT');
      const user = u.rows[0];
      // S-01: every password signup starts unverified; paid/crawl features
      // stay gated until the email is verified.
      const rawToken = await issueVerificationToken(user.id as string, 'signup');
      await sendVerificationEmail(cleanEmail, user.name as string, rawToken);
      // P0-01: sign with the row's token_version (logout revocation compares
      // token tv against users.token_version). S-05: also registers the
      // server-side session. JWT-in-body fix: the session token is delivered
      // ONLY via the httpOnly cookie (setAuthCookie inside issueAuthSession)
      // — never in the JSON body, where any XSS could read it.
      await issueAuthSession(req, reply, user.id as string, tenantId, Number(user.token_version ?? 0));
      return reply.status(201).send({
        user: { id: user.id, email: user.email, name: user.name, emailVerified: false },
        tenant: { id: tenantId, name: t.rows[0].name, plan_id: t.rows[0].plan_id },
        ...testVerifyTokenField(rawToken),
      });
    } catch (err: any) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore rollback errors */
      }
      if (err?.code === '23505') throw conflict('EMAIL_EXISTS', 'An account with this email already exists');
      throw err;
    } finally {
      client.release();
    }
  });

  fastify.post('/auth/login', { schema: loginSchema, ...strictRateLimit() }, async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };
    const cleanEmail = (email ?? '').trim().toLowerCase();
    // S-03: login lockout with backoff. Checked BEFORE the user lookup and
    // answered generically, so the 429 reveals nothing about whether the
    // email is registered.
    const redis = getRedis();
    const lockOpts = {
      maxAttempts: config.loginLockout.maxAttempts,
      baseLockoutMs: config.loginLockout.baseLockoutMin * 60_000,
      maxLockoutMs: config.loginLockout.maxLockoutMin * 60_000,
    };
    const locked = await isLoginLocked(redis, cleanEmail, req.ip, lockOpts);
    if (locked.locked) {
      throw new ApiError(
        429,
        'LOGIN_LOCKED',
        `Too many failed sign-in attempts — please try again in ${Math.max(1, Math.ceil(locked.retryAfterMs / 60000))} minute(s)`,
      );
    }
    const r = await query(
      `SELECT u.id, u.email, u.name, u.password_hash, u.tenant_id, u.token_version,
              t.name AS tenant_name, t.plan_id
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1`,
      [cleanEmail],
    );
    const row = r.rows[0];
    const ok = row?.password_hash ? await verifyPassword(password ?? '', row.password_hash) : false;
    if (!row || !ok) {
      // Count the failure for both the email hash and the IP, even for
      // unknown emails (no existence oracle), then the generic 401.
      await recordFailedLogin(redis, cleanEmail, req.ip, lockOpts);
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    // Success: clear any accumulated failures.
    await clearLoginAttempts(redis, cleanEmail, req.ip);
    // S-05: 2FA challenge — password was correct, but no session yet. The
    // short-lived totpToken can only be exchanged at POST /auth/totp/verify.
    const tv = Number(row.token_version ?? 0);
    if (await isTotpEnabled(row.id as string)) {
      const totpToken = signToken(row.id as string, row.tenant_id as string, tv, {
        purpose: 'totp',
        expiresIn: '5m',
      });
      return { totpRequired: true, totpToken };
    }
    const verified = await isEmailVerified(row.id as string);
    // P0-01: sign with the stored token_version (logout bumps it); a default
    // tv=0 here would be permanently revoked after the first logout.
    // JWT-in-body fix: session token goes ONLY into the httpOnly cookie —
    // never the JSON body.
    await issueAuthSession(req, reply, row.id as string, row.tenant_id as string, tv);
    return {
      user: { id: row.id, email: row.email, name: row.name, emailVerified: verified },
      tenant: { id: row.tenant_id, name: row.tenant_name, plan_id: row.plan_id },
    };
  });

  // S-01: consume an email-verification token (signup or email change).
  fastify.post('/auth/email/verify', { schema: verifyEmailSchema, ...strictRateLimit() }, async (req) => {
    const { token } = req.body as { token?: string };
    if (!token) throw validationError('Verification token is required');
    const consumed = await consumeVerificationToken(token);
    if (!consumed) throw new ApiError(400, 'INVALID_TOKEN', 'This verification link is invalid or has expired');
    if (consumed.purpose === 'email_change') {
      await confirmEmailChange(consumed.userId);
    } else {
      await query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [
        consumed.userId,
      ]);
    }
    const u = await query('SELECT email FROM users WHERE id = $1', [consumed.userId]);
    return { ok: true, email: u.rows[0]?.email ?? null };
  });

  // S-01: resend the verification email. Always 200 with a generic body so
  // the endpoint cannot be used to enumerate registered emails.
  fastify.post('/auth/email/resend', { schema: resendEmailSchema, ...strictRateLimit() }, async (req) => {
    const { email } = req.body as { email?: string };
    const cleanEmail = (email ?? '').trim().toLowerCase();
    if (EMAIL_RE.test(cleanEmail)) {
      const r = await query('SELECT id, name, email_verified_at FROM users WHERE email = $1', [cleanEmail]);
      const row = r.rows[0];
      if (row && !row.email_verified_at) {
        try {
          await assertResendAllowed(row.id as string);
          const rawToken = await issueVerificationToken(row.id as string, 'signup');
          await sendVerificationEmail(cleanEmail, (row.name as string) ?? '', rawToken);
        } catch {
          // Throttled — still return the generic response (no enumeration).
        }
      }
    }
    return { ok: true };
  });

  // S-05: password reset request. ALWAYS 200 with a generic body — the
  // endpoint must not reveal whether the email is registered.
  fastify.post('/auth/password/reset-request', { schema: resendEmailSchema, ...strictRateLimit() }, async (req) => {
    const { email } = req.body as { email?: string };
    const cleanEmail = (email ?? '').trim().toLowerCase();
    let debugToken: string | null = null;
    if (EMAIL_RE.test(cleanEmail)) {
      const r = await query('SELECT id, name FROM users WHERE email = $1', [cleanEmail]);
      const row = r.rows[0];
      // Passwordless (Google-only) accounts have no password to reset.
      if (row) {
        const pw = await query('SELECT password_hash FROM users WHERE id = $1', [row.id]);
        if (pw.rows[0]?.password_hash) {
          try {
            await assertResendAllowed(row.id as string);
            const rawToken = await issueVerificationToken(row.id as string, 'password_reset');
            await sendPasswordResetEmail(cleanEmail, (row.name as string) ?? '', rawToken);
            debugToken = rawToken;
          } catch {
            // Throttled — still return the generic response (no enumeration).
          }
        }
      }
    }
    return { ok: true, ...testResetTokenField(debugToken) };
  });

  // S-05: consume a password-reset token (one-time, 24h) and set the new
  // password. All sessions are revoked — a compromised password dies
  // everywhere at once.
  fastify.post(
    '/auth/password/reset',
    {
      schema: {
        body: {
          type: 'object',
          required: ['token', 'password'],
          properties: {
            token: { type: 'string', minLength: 8, maxLength: 200 },
            password: { type: 'string', maxLength: 200 },
          },
          additionalProperties: false,
        },
      },
      ...strictRateLimit(),
    },
    async (req) => {
      const { token, password } = req.body as { token?: string; password?: string };
      const problems = await validatePassword(password ?? '');
      if (problems.length > 0) throw validationError(problems[0]);
      const consumed = await consumeVerificationToken(token ?? '', 'password_reset');
      if (!consumed) throw new ApiError(400, 'INVALID_TOKEN', 'This reset link is invalid or has expired');
      await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
        consumed.userId,
        await hashPassword(password!),
      ]);
      await revokeAllSessions(consumed.userId);
      return { ok: true };
    },
  );

  // S-05: exchanges the short-lived 2FA challenge token (+ TOTP code or
  // backup code) for a full session. Public — the totpToken is the auth.
  fastify.post(
    '/auth/totp/verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['totpToken', 'code'],
          properties: {
            totpToken: { type: 'string', minLength: 8, maxLength: 2000 },
            code: { type: 'string', minLength: 4, maxLength: 32 },
          },
          additionalProperties: false,
        },
      },
      ...strictRateLimit(),
    },
    async (req, reply) => {
      const { totpToken, code } = req.body as { totpToken?: string; code?: string };
      let payload: any;
      try {
        payload = jwt.verify(totpToken ?? '', config.jwtSecret, { algorithms: ['HS256'] });
      } catch {
        throw new ApiError(401, 'INVALID_TOKEN', 'Invalid or expired 2FA challenge');
      }
      if (!payload || payload.purpose !== 'totp' || !payload.uid) {
        throw new ApiError(401, 'INVALID_TOKEN', 'Invalid or expired 2FA challenge');
      }
      const ok = await verifyTotpOrBackup(payload.uid as string, code ?? '');
      if (!ok) throw new ApiError(401, 'INVALID_CODE', 'Invalid authentication code');
      const r = await query(
        `SELECT u.id, u.email, u.name, u.tenant_id, u.token_version, u.email_verified_at,
                t.name AS tenant_name, t.plan_id
         FROM users u JOIN tenants t ON t.id = u.tenant_id
         WHERE u.id = $1`,
        [payload.uid],
      );
      const row = r.rows[0];
      if (!row) throw new ApiError(401, 'INVALID_TOKEN', 'Invalid or expired 2FA challenge');
      // JWT-in-body fix: the full session token is delivered ONLY via the
      // httpOnly cookie — never in the JSON body.
      await issueAuthSession(req, reply, row.id as string, row.tenant_id as string, Number(row.token_version ?? 0));
      return {
        user: { id: row.id, email: row.email, name: row.name, emailVerified: row.email_verified_at != null },
        tenant: { id: row.tenant_id, name: row.tenant_name, plan_id: row.plan_id },
      };
    },
  );

  fastify.post('/auth/logout', async (req, reply) => {
    // D1-M-1: plain logout revokes ONLY the current session (jti-scoped).
    // The old code called revokeAllSessions (logout-everywhere semantics)
    // despite the comment claiming jti-scoped revocation; "log out
    // everywhere" lives at POST /auth/logout-everywhere. token_version is
    // deliberately NOT bumped — that would kill every other device's
    // session too. Best-effort: the cookie is always cleared.
    try {
      const h = req.headers.authorization;
      const token = h?.startsWith('Bearer ')
        ? h.slice(7)
        : (req as any).cookies?.['bseo_token'];
      if (token) {
        const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as any;
        const uid = payload?.uid as string | undefined;
        const jti = payload?.jti as string | undefined;
        if (uid && jti) {
          const s = await query(
            'SELECT id FROM user_sessions WHERE user_id = $1 AND jti_hash = $2 AND revoked_at IS NULL',
            [uid, hashJti(jti)],
          );
          const sessionId = s.rows[0]?.id as string | undefined;
          // Session-less legacy tokens have no row — nothing server-side
          // to revoke; the cleared cookie ends the session regardless.
          if (sessionId) await revokeSession(uid, sessionId);
        }
      }
    } catch {
      /* invalid/expired token — nothing to revoke */
    }
    clearAuthCookie(reply);
    return { ok: true };
  });

  fastify.get('/auth/google', async (req, reply) => {
    // S-04: state lives in Redis (shared across instances), is bound to this
    // browser via a signed httpOnly cookie, and carries a PKCE verifier.
    const { state, codeChallenge } = await createSigninState();
    setOAuthStateCookie(reply, state, req);
    return reply.redirect(getGoogle().getAuthUrl(state, { codeChallenge }));
  });

  fastify.get('/auth/google/callback', { schema: oauthCallbackSchema }, async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    // S-04: the state must have been initiated by THIS browser (signed
    // cookie) — otherwise an attacker could complete their OAuth flow in the
    // victim's browser (login CSRF).
    const cookieVal = (req as any).cookies?.[OAUTH_STATE_COOKIE] as string | undefined;
    if (!state || !verifyOAuthStates(cookieVal, state)) {
      throw new ApiError(400, 'INVALID_STATE', 'Invalid or expired OAuth state');
    }
    const consumed = await consumeSigninState(state);
    if (!consumed || !code) {
      throw new ApiError(400, 'INVALID_STATE', 'Invalid or expired OAuth state');
    }
    const profile = await getGoogle().getProfile(code, consumed.codeVerifier);
    const cleanEmail = profile.email.trim().toLowerCase();

    let userId: string;
    let tenantId: string;
    let tokenVersion = 0;

    // 1) Already linked via google_id -> straight sign-in.
    const byGid = profile.googleId
      ? await query(
          `SELECT u.id, u.tenant_id, u.token_version
           FROM users u WHERE u.google_id = $1 LIMIT 1`,
          [profile.googleId],
        )
      : { rows: [] as any[] };

    if (byGid.rows.length > 0) {
      const row = byGid.rows[0];
      userId = row.id as string;
      tenantId = row.tenant_id as string;
      tokenVersion = Number(row.token_version ?? 0);
    } else {
      // 2) Merge-by-email candidate.
      const byEmail = await query(
        `SELECT u.id, u.tenant_id, u.token_version, u.email_verified_at, u.password_hash,
                t.name AS tenant_name, t.plan_id
         FROM users u JOIN tenants t ON t.id = u.tenant_id
         WHERE u.email = $1 LIMIT 1`,
        [cleanEmail],
      );

      if (byEmail.rows.length === 0) {
        // 3) Brand-new user. Verified immediately only when Google attests it;
        // otherwise they must complete the email-verification flow.
        const created = await createGoogleUser(cleanEmail, profile);
        userId = created.userId;
        tenantId = created.tenantId;
        tokenVersion = 0;
      } else {
        // S-01 merge rules (pre-account-hijack defense):
        // merge by email ONLY when Google attests email_verified=true.
        // A Google account with an unverified email can never take over a
        // local account.
        if (!profile.emailVerified) {
          throw new ApiError(
            403,
            'EMAIL_NOT_VERIFIED',
            'This Google account\u2019s email is not verified. Verify it with Google first, ' +
              'or sign in with your password and verify your email address.',
          );
        }
        const row = byEmail.rows[0];
        userId = row.id as string;
        tenantId = row.tenant_id as string;
        const wasVerified = row.email_verified_at != null;
        // Google attests the email -> mark verified and link the Google id.
        // Always bump token_version (kicks any sessions from before the link).
        // If the local account was NEVER verified, its password may have been
        // set by someone who never proved email ownership (pre-hijack) — drop
        // it; the owner recovers via Google sign-in or password reset.
        await query(
          `UPDATE users
           SET google_id = $1,
               email_verified_at = COALESCE(email_verified_at, now()),
               token_version = token_version + 1
               ${wasVerified ? '' : ', password_hash = NULL'}
           WHERE id = $2`,
          [profile.googleId, userId],
        );
        tokenVersion = Number(row.token_version ?? 0) + 1;
      }
    }

    // S-05: accounts with 2FA enabled get the short-lived challenge instead
    // of a session — the frontend collects the TOTP code next.
    if (await isTotpEnabled(userId)) {
      const totpToken = signToken(userId, tenantId, tokenVersion, { purpose: 'totp', expiresIn: '5m' });
      clearOAuthStateCookie(reply);
      return reply.redirect(
        `${config.appUrl}/login?totp=1&token=${encodeURIComponent(totpToken)}`,
      );
    }
    const token = await issueAuthSession(req, reply, userId, tenantId, tokenVersion);
    clearOAuthStateCookie(reply); // S-04: flow complete, drop the binding cookie
    return reply.redirect(`${config.appUrl}/dashboard`);
  });

  // Authenticated-only routes.
  await fastify.register(async (authed) => {
    await authPlugin(authed);

    authed.get('/auth/me', async (req) => {
      const r = await query('SELECT id, name, plan_id FROM tenants WHERE id = $1', [req.tenant.tenantId]);
      const t = r.rows[0];
      return {
        user: {
          id: req.tenant.userId,
          email: req.tenant.email,
          name: req.tenant.name,
          emailVerified: req.tenant.emailVerified,
        },
        tenant: { id: t.id, name: t.name, plan_id: t.plan_id },
        plan: getPlan(t.plan_id),
      };
    });

    // S-05: change password. Requires the current password; revokes ALL
    // sessions (the caller's included) so a compromised password dies
    // everywhere at once.
    // B1-R1: human-only — API keys have no user (userId is null for them).
    authed.post(
      '/auth/password/change',
      {
        preHandler: requireHumanSession,
        schema: {
          body: {
            type: 'object',
            required: ['currentPassword', 'newPassword'],
            properties: {
              currentPassword: { type: 'string', maxLength: 200 },
              newPassword: { type: 'string', maxLength: 200 },
            },
            additionalProperties: false,
          },
        },
      },
      async (req) => {
        const { currentPassword, newPassword } = req.body as {
          currentPassword?: string;
          newPassword?: string;
        };
        const userId = humanUserId(req);
        const r = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
        const hash = r.rows[0]?.password_hash as string | null;
        if (!hash || !(await verifyPassword(currentPassword ?? '', hash))) {
          throw new ApiError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
        }
        const problems = await validatePassword(newPassword ?? '');
        if (problems.length > 0) throw validationError(problems[0]);
        await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
          userId,
          await hashPassword(newPassword!),
        ]);
        await revokeAllSessions(userId);
        return { ok: true };
      },
    );

    // S-05: request an email change. The NEW address must be verified before
    // it takes effect (existing /auth/email/verify + confirmEmailChange).
    // B1-R1: human-only.
    authed.post(
      '/auth/email/change',
      {
        preHandler: requireHumanSession,
        schema: {
          body: {
            type: 'object',
            required: ['email'],
            properties: { email: { type: 'string', maxLength: 320 } },
            additionalProperties: false,
          },
        },
      },
      async (req) => {
        const { email } = req.body as { email?: string };
        const cleanEmail = (email ?? '').trim().toLowerCase();
        if (!EMAIL_RE.test(cleanEmail)) throw validationError('Invalid email address');
        const clash = await query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
        if (clash.rows.length > 0) {
          throw conflict('EMAIL_EXISTS', 'That email address is already in use');
        }
        const userId = humanUserId(req);
        // C1-L-15: throttle like /auth/email/resend and password reset —
        // a stolen session must not be usable to email-bomb addresses.
        await assertResendAllowed(userId);
        await query('UPDATE users SET pending_email = $2 WHERE id = $1', [userId, cleanEmail]);
        const rawToken = await issueVerificationToken(userId, 'email_change');
        await sendEmailChangeEmail(cleanEmail, req.tenant.name, rawToken);
        return { ok: true, ...testVerifyTokenField(rawToken) };
      },
    );

    // S-05: delete the account and purge its data (GDPR). Requires the
    // password when the account has one; passwordless (Google-only) accounts
    // require a TOTP code when 2FA is on, and must set a password first
    // otherwise. The tenant row is purged when its last user is gone
    // (cascades to sites, audits, keywords, content, sessions, tokens).
    // B1-R1: human-only.
    authed.delete(
      '/auth/account',
      {
        preHandler: requireHumanSession,
        schema: {
          body: {
            type: 'object',
            properties: {
              password: { type: 'string', maxLength: 200 },
              code: { type: 'string', maxLength: 32 },
            },
            additionalProperties: false,
          },
        },
      },
      async (req, reply) => {
        const { password, code } = req.body as { password?: string; code?: string };
        const userId = humanUserId(req);
        const tenantId = req.tenant.tenantId;
        const r = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
        const hash = r.rows[0]?.password_hash as string | null;
        if (hash) {
          if (!password || !(await verifyPassword(password, hash))) {
            throw new ApiError(401, 'INVALID_CREDENTIALS', 'Password is incorrect');
          }
        } else if (await isTotpEnabled(userId)) {
          if (!code || !(await verifyTotpOrBackup(userId, code))) {
            throw new ApiError(401, 'INVALID_CODE', 'Two-factor code is incorrect');
          }
        } else {
          throw new ApiError(
            400,
            'PASSWORD_REQUIRED',
            'Set a password via password reset before deleting a passwordless account',
          );
        }
        // C1-L-14: a sole owner deleting themselves while other members
        // remain would orphan the tenant (nobody left to invite/promote).
        const myRole = await query('SELECT role FROM users WHERE id = $1', [userId]);
        if (myRole.rows[0]?.role === 'owner') {
          const counts = await query(
            `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE role = 'owner')::int AS owners
             FROM users WHERE tenant_id = $1`,
            [tenantId],
          );
          if (Number(counts.rows[0]?.owners ?? 0) === 1 && Number(counts.rows[0]?.total ?? 0) > 1) {
            throw new ApiError(
              400,
              'LAST_OWNER',
              'You are the only owner — transfer ownership to another member before deleting your account',
            );
          }
        }
        // C1-H-1: when this deletion purges the tenant (last user), cancel
        // the Stripe subscription(s) FIRST. On failure: abort with 502 —
        // no rows are deleted, so the customer is never charged with no
        // account left to reach the billing portal.
        const others = await query(`SELECT COUNT(*)::int AS c FROM users WHERE tenant_id = $1 AND id <> $2`, [
          tenantId,
          userId,
        ]);
        let canceled: string[] = [];
        let forfeitedCents = 0;
        if (Number(others.rows[0]?.c ?? 0) === 0) {
          const { cancelTenantBilling } = await import('../providers/stripe.js');
          ({ canceled, creditsCents: forfeitedCents } = await cancelTenantBilling(tenantId));
        }
        if (forfeitedCents > 0) {
          // C1-H-2: outstanding credits (money owed to the customer) are
          // never silently hard-deleted — the tombstone survives in the
          // audit log so support can reconcile/refund after the fact.
          // Inserted BEFORE the deletes (the FK needs the rows to exist;
          // ON DELETE SET NULL nulls the references afterwards).
          await query(
            `INSERT INTO admin_audit_log (id, actor_user_id, actor_tenant_id, action, target_tenant_id, meta)
             VALUES (gen_random_uuid(), $1, $2, 'billing.credits_forfeited', $2, $3)`,
            [
              userId,
              tenantId,
              JSON.stringify({
                tenantId,
                amountCents: forfeitedCents,
                reason: 'account deleted with outstanding credit balance; contact support to claim a refund',
              }),
            ],
          );
        }
        await query('DELETE FROM users WHERE id = $1', [userId]);
        await query(
          'DELETE FROM tenants WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM users WHERE tenant_id = $1)',
          [tenantId],
        );
        clearAuthCookie(reply);
        return { ok: true, subscriptionsCanceled: canceled.length, creditsForfeitedCents: forfeitedCents };
      },
    );

    // S-05: TOTP setup — generates the secret, stores it encrypted (not yet
    // enabled). The secret is shown ONCE; enable with a valid code.
    // B1-R1: human-only.
    authed.post('/auth/totp/setup', { preHandler: requireHumanSession }, async (req) => {
      const userId = humanUserId(req);
      const { enabled } = await getTotpState(userId);
      if (enabled) throw new ApiError(400, 'TOTP_ALREADY_ENABLED', 'Two-factor is already enabled');
      return beginTotpSetup(userId);
    });

    // S-05: TOTP enable — verifies the code, enables 2FA, returns one-time
    // backup codes (shown ONCE).
    // B1-R1: human-only.
    authed.post(
      '/auth/totp/enable',
      {
        preHandler: requireHumanSession,
        schema: {
          body: {
            type: 'object',
            required: ['code'],
            properties: { code: { type: 'string', minLength: 4, maxLength: 32 } },
            additionalProperties: false,
          },
        },
      },
      async (req) => {
        const { code } = req.body as { code?: string };
        const userId = humanUserId(req);
        const codes = await enableTotp(userId, code ?? '');
        if (!codes) throw new ApiError(400, 'INVALID_CODE', 'Invalid code — 2FA was not enabled');
        // New factor, new session baseline: revoke everything EXCEPT the
        // session that just enabled 2FA (don't log the user out mid-setup).
        await revokeAllSessions(userId, req.tenant.jti);
        return { ok: true, backupCodes: codes };
      },
    );

    // S-05: TOTP disable — requires the account password.
    // B1-R1: human-only.
    authed.post(
      '/auth/totp/disable',
      {
        preHandler: requireHumanSession,
        schema: {
          body: {
            type: 'object',
            required: ['password'],
            properties: { password: { type: 'string', maxLength: 200 } },
            additionalProperties: false,
          },
        },
      },
      async (req) => {
        const { password } = req.body as { password?: string };
        const userId = humanUserId(req);
        const r = await query('SELECT password_hash FROM users WHERE id = $1', [userId]);
        const hash = r.rows[0]?.password_hash as string | null;
        if (!hash || !(await verifyPassword(password ?? '', hash))) {
          throw new ApiError(401, 'INVALID_CREDENTIALS', 'Password is incorrect');
        }
        await disableTotp(userId);
        return { ok: true };
      },
    );

    // S-05: session list. Never exposes token material — only metadata.
    // B1-R1: human-only.
    authed.get('/auth/sessions', { preHandler: requireHumanSession }, async (req) => {
      const userId = humanUserId(req);
      const sessions = await listSessions(userId);
      const currentHash = req.tenant.jti ? hashJti(req.tenant.jti) : null;
      const rows = await query(
        'SELECT id, jti_hash FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL',
        [userId],
      );
      const hashById = new Map((rows.rows as any[]).map((x) => [x.id as string, x.jti_hash as string]));
      return {
        sessions: sessions.map((s) => ({
          id: s.id,
          userAgent: s.user_agent,
          ip: s.ip,
          createdAt: s.created_at,
          lastSeenAt: s.last_seen_at,
          current: currentHash != null && hashById.get(s.id) === currentHash,
        })),
      };
    });

    // S-05: revoke one session (not-found when it isn't yours).
    // B1-R1: human-only.
    authed.delete('/auth/sessions/:id', { preHandler: requireHumanSession }, async (req) => {
      const { id } = req.params as { id: string };
      if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw validationError('Invalid session id');
      const ok = await revokeSession(humanUserId(req), id);
      if (!ok) throw new ApiError(404, 'NOT_FOUND', 'Session not found');
      return { ok: true };
    });

    // S-05: log out everywhere — revokes all sessions and bumps
    // token_version (kills even session-less legacy tokens).
    // B1-R1: human-only.
    authed.post('/auth/logout-everywhere', { preHandler: requireHumanSession }, async (req, reply) => {
      await revokeAllSessions(humanUserId(req));
      clearAuthCookie(reply);
      return { ok: true };
    });
  });
}
