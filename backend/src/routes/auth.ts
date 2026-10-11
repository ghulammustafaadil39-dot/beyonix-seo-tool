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
  signToken,
  verifyPassword,
} from '../middleware/auth.js';
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
  sendVerificationEmail,
} from '../services/emailVerification.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Debug helper: in test env only, the raw verification token is returned so
 * integration tests can complete the flow without reading email. */
function testVerifyTokenField(rawToken: string): Record<string, string> {
  return config.nodeEnv === 'test' ? { verifyToken: rawToken } : {};
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
      `INSERT INTO tenants (id, name, plan_id)
       VALUES (gen_random_uuid(), $1, 'starter')
       RETURNING id`,
      [profile.name],
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
  await query(
    `UPDATE users SET email = $2, pending_email = NULL, email_verified_at = now() WHERE id = $1`,
    [userId, pending],
  );
}

/** S-03: live re-read of the disposable-email toggle (test hook friendly). */
function disposableBlockEnabled(): boolean {
  return process.env.DISPOSABLE_EMAIL_BLOCK === 'true' || config.disposableEmailBlock;
}

export async function registerAuthRoutes(fastify: FastifyInstance) {
  // Brute-force guard: auth endpoints get a much stricter limit than the
  // global 300/min (per-IP).
  const strictRateLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  fastify.post('/auth/signup', { schema: signupSchema, ...strictRateLimit }, async (req, reply) => {
    const { email, password, name, captchaToken } = req.body as {
      email: string;
      password: string;
      name?: string;
      captchaToken?: string;
    };
    const cleanEmail = (email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail)) throw validationError('Invalid email address');
    if (!password || password.length < 8) throw validationError('Password must be at least 8 characters');
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
        `INSERT INTO tenants (id, name, plan_id)
         VALUES (gen_random_uuid(), $1, 'starter')
         RETURNING id, name, plan_id`,
        [displayName],
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
      // token tv against users.token_version).
      const token = signToken(user.id as string, tenantId, Number(user.token_version ?? 0));
      setAuthCookie(reply, token);
      return reply.status(201).send({
        token,
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

  fastify.post('/auth/login', { schema: loginSchema, ...strictRateLimit }, async (req, reply) => {
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
    const verified = await isEmailVerified(row.id as string);
    // P0-01: sign with the stored token_version (logout bumps it); a default
    // tv=0 here would be permanently revoked after the first logout.
    const token = signToken(row.id as string, row.tenant_id as string, Number(row.token_version ?? 0));
    setAuthCookie(reply, token);
    return {
      token,
      user: { id: row.id, email: row.email, name: row.name, emailVerified: verified },
      tenant: { id: row.tenant_id, name: row.tenant_name, plan_id: row.plan_id },
    };
  });

  // S-01: consume an email-verification token (signup or email change).
  fastify.post('/auth/email/verify', { schema: verifyEmailSchema, ...strictRateLimit }, async (req) => {
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
  fastify.post('/auth/email/resend', { schema: resendEmailSchema, ...strictRateLimit }, async (req) => {
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

  fastify.post('/auth/logout', async (req, reply) => {
    // Revoke the session server-side too (bumps token_version so the JWT
    // stops working even if copied). Best-effort: cookie is always cleared.
    try {
      const h = req.headers.authorization;
      const token = h?.startsWith('Bearer ')
        ? h.slice(7)
        : (req as any).cookies?.['bseo_token'];
      if (token) {
        const payload = jwt.verify(token, config.jwtSecret) as any;
        if (payload?.uid) {
          await query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [payload.uid]);
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

    const token = signToken(userId, tenantId, tokenVersion);
    setAuthCookie(reply, token);
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
  });
}
