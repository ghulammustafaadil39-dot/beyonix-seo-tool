import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool, query } from '../db.js';
import { ApiError, badRequest, conflict } from '../errors.js';
import {
  authPlugin,
  clearAuthCookie,
  hashPassword,
  setAuthCookie,
  signToken,
  verifyPassword,
} from '../middleware/auth.js';
import { getGoogle } from '../providers/google.js';
import { getPlan } from '../plans.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

/** state -> createdAt for the Google sign-in OAuth flow. */
const oauthStates = new Map<string, number>();

function sweepOauthStates() {
  if (oauthStates.size < 500) return;
  const now = Date.now();
  for (const [k, v] of oauthStates) {
    if (now - v > OAUTH_STATE_TTL_MS) oauthStates.delete(k);
  }
}

const signupSchema = {
  body: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', maxLength: 320 },
      password: { type: 'string', maxLength: 200 },
      name: { type: 'string', maxLength: 200 },
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

export async function registerAuthRoutes(fastify: FastifyInstance) {
  // Brute-force guard: auth endpoints get a much stricter limit than the
  // global 300/min (per-IP).
  const strictRateLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };

  fastify.post('/auth/signup', { schema: signupSchema, ...strictRateLimit }, async (req, reply) => {
    const { email, password, name } = req.body as { email: string; password: string; name?: string };
    const cleanEmail = (email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail)) throw badRequest('Invalid email address');
    if (!password || password.length < 8) throw badRequest('Password must be at least 8 characters');

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
         RETURNING id, email, name`,
        [tenantId, cleanEmail, pwHash, displayName],
      );
      await client.query('COMMIT');
      const user = u.rows[0];
      const token = signToken(user.id as string, tenantId);
      setAuthCookie(reply, token);
      return reply.status(201).send({
        token,
        user: { id: user.id, email: user.email, name: user.name },
        tenant: { id: tenantId, name: t.rows[0].name, plan_id: t.rows[0].plan_id },
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
    const r = await query(
      `SELECT u.id, u.email, u.name, u.password_hash, u.tenant_id,
              t.name AS tenant_name, t.plan_id
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1`,
      [cleanEmail],
    );
    const row = r.rows[0];
    const ok = row?.password_hash ? await verifyPassword(password ?? '', row.password_hash) : false;
    if (!row || !ok) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    const token = signToken(row.id as string, row.tenant_id as string);
    setAuthCookie(reply, token);
    return {
      token,
      user: { id: row.id, email: row.email, name: row.name },
      tenant: { id: row.tenant_id, name: row.tenant_name, plan_id: row.plan_id },
    };
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

  fastify.get('/auth/google', async (_req, reply) => {
    const state = randomBytes(16).toString('hex');
    sweepOauthStates();
    oauthStates.set(state, Date.now());
    return reply.redirect(getGoogle().getAuthUrl(state));
  });

  fastify.get('/auth/google/callback', { schema: oauthCallbackSchema }, async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const createdAt = state ? oauthStates.get(state) : undefined;
    if (state) oauthStates.delete(state);
    if (!state || createdAt === undefined || Date.now() - createdAt > OAUTH_STATE_TTL_MS || !code) {
      throw new ApiError(400, 'INVALID_STATE', 'Invalid or expired OAuth state');
    }
    const profile = await getGoogle().getProfile(code);
    const cleanEmail = profile.email.trim().toLowerCase();

    const existing = await query(
      `SELECT u.id, u.tenant_id, u.token_version, t.name AS tenant_name, t.plan_id
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.google_id = $1 OR u.email = $2
       LIMIT 1`,
      [profile.googleId, cleanEmail],
    );

    let userId: string;
    let tenantId: string;
    let tenantName: string;
    let planId: string;
    let tokenVersion = 0;

    if (existing.rows.length === 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const t = await client.query(
          `INSERT INTO tenants (id, name, plan_id)
           VALUES (gen_random_uuid(), $1, 'starter')
           RETURNING id, name, plan_id`,
          [profile.name],
        );
        tenantId = t.rows[0].id as string;
        tenantName = t.rows[0].name as string;
        planId = t.rows[0].plan_id as string;
        const u = await client.query(
          `INSERT INTO users (id, tenant_id, email, name, role, google_id)
           VALUES (gen_random_uuid(), $1, $2, $3, 'owner', $4)
           RETURNING id`,
          [tenantId, cleanEmail, profile.name, profile.googleId],
        );
        userId = u.rows[0].id as string;
        await client.query('COMMIT');
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
    } else {
      const row = existing.rows[0];
      userId = row.id as string;
      tenantId = row.tenant_id as string;
      tenantName = row.tenant_name as string;
      planId = row.plan_id as string;
      tokenVersion = Number(row.token_version ?? 0);
      await query('UPDATE users SET google_id = $1 WHERE id = $2', [profile.googleId, userId]);
    }

    const token = signToken(userId, tenantId, tokenVersion);
    setAuthCookie(reply, token);
    return reply.redirect(`${config.appUrl}/dashboard`);
  });

  // Authenticated-only routes.
  await fastify.register(async (authed) => {
    await authed.register(authPlugin);

    authed.get('/auth/me', async (req) => {
      const r = await query('SELECT id, name, plan_id FROM tenants WHERE id = $1', [req.tenant.tenantId]);
      const t = r.rows[0];
      return {
        user: { id: req.tenant.userId, email: req.tenant.email, name: req.tenant.name },
        tenant: { id: t.id, name: t.name, plan_id: t.plan_id },
        plan: getPlan(t.plan_id),
      };
    });
  });
}
