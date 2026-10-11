import type { FastifyInstance, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { ApiError, unauthorized } from '../errors.js';
import { getRedis, incrWithTtl, redisKeyPrefix } from '../redis.js';
import { isSessionActive, touchSession } from '../services/sessions.js';
import { CSRF_COOKIE } from './csrf.js';
import { authCookieOptions, csrfCookieOptions } from '../services/securityHeaders.js';
import type { PlanId } from '../plans.js';

export interface TenantContext {
  /**
   * B1-R1: null when authenticated via API key. API keys authenticate as
   * the tenant — they have NO user, so user-scoped endpoints must not
   * receive a pseudo-id. (The old `apikey:<uuid>` string broke Postgres
   * UUID columns with 22P02 500s on ~15 endpoints; null is honest and
   * type-safe. Human-only routes additionally carry requireHumanSession.)
   */
  userId: string | null;
  tenantId: string;
  plan: PlanId;
  email: string;
  name: string;
  /** S-01: false until the user completes email verification. */
  emailVerified: boolean;
  /** S-05: the token's jti (undefined for pre-S-05 legacy tokens). */
  jti?: string;
  /** F-09: team role — owner|admin|editor|viewer (users.role). */
  role: string;
  /** F-14: platform admin (bypasses tenant scoping on /api/v1/admin). */
  isPlatformAdmin: boolean;
  /** C-01: downgraded-with-excess-usage tenants are read-only. */
  readOnly: boolean;
  /** F-13: set when authenticated via API key instead of a user session. */
  apiKeyId?: string;
  /** F-13: scopes granted to the API key (empty = none). */
  apiKeyScopes?: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant: TenantContext;
  }
}

const COOKIE_NAME = 'bseo_token';

export { COOKIE_NAME, CSRF_COOKIE };

export interface SignTokenOpts {
  /** 'auth' for API sessions, 'totp' for the short-lived 2FA challenge token. */
  purpose?: 'auth' | 'totp';
  expiresIn?: string;
}

/**
 * S-05: every token carries a jti (registered in user_sessions for
 * per-session revocation) and a purpose. The 'totp' purpose marks the
 * 5-minute 2FA challenge token, which authPlugin rejects for API access.
 */
export function signToken(
  userId: string,
  tenantId: string,
  tokenVersion = 0,
  opts: SignTokenOpts = {},
): string {
  return jwt.sign(
    { uid: userId, tid: tenantId, tv: tokenVersion, jti: randomUUID(), purpose: opts.purpose ?? 'auth' },
    config.jwtSecret,
    { expiresIn: (opts.expiresIn ?? '7d') as any },
  );
}

export function setAuthCookie(reply: any, token: string) {
  // S-06: flags from config (SameSite strategy + Secure), not hardcoded.
  reply.setCookie(COOKIE_NAME, token, authCookieOptions());
}

/** Sets the readable CSRF double-submit cookie alongside the auth cookie. */
export function setCsrfCookie(reply: any, csrfToken: string) {
  reply.setCookie(CSRF_COOKIE, csrfToken, csrfCookieOptions());
}

export function clearAuthCookie(reply: any) {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 12);
}

export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

function tokenFromRequest(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  const c = (req as any).cookies?.[COOKIE_NAME];
  return c ?? null;
}

/**
 * F-13: extracts a raw API key from the request. Keys are `bseo_`-prefixed
 * (32 random bytes, hex) and travel as `Authorization: Bearer bseo_...` or
 * the `x-api-key` header. JWT session tokens never have the prefix, so the
 * two mechanisms cannot collide.
 */
function apiKeyFromRequest(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer bseo_')) return h.slice(7);
  const x = req.headers['x-api-key'];
  if (typeof x === 'string' && x.startsWith('bseo_')) return x;
  return null;
}

/**
 * F-13: resolves an API key to a tenant context. Only the sha256 hash is
 * stored (017); the raw key is compared by hash, never logged. Revoked keys
 * are rejected; each key has its own per-minute rate limit.
 */
async function tenantFromApiKey(rawKey: string): Promise<{ ctx: TenantContext; suspendedAt: string | null }> {
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const r = await query(
    `SELECT k.id, k.tenant_id, k.scopes, k.rate_limit_per_min, k.revoked_at,
            t.plan_id, t.suspended_at, t.read_only
     FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
     WHERE k.key_hash = $1`,
    [keyHash],
  );
  const row = r.rows[0];
  if (!row || row.revoked_at) throw unauthorized('Invalid or revoked API key');

  // F-13: per-key rate limit (fixed window, Redis).
  // A2-M5: atomic INCR-with-TTL (Lua) — a crash between INCR and EXPIRE
  // used to leave a TTL-less key that 429'd the key forever.
  const redis = getRedis();
  const rlKey = `${redisKeyPrefix()}apikey:${row.id as string}`;
  const count = await incrWithTtl(redis, rlKey, 60);
  const max = Number(row.rate_limit_per_min ?? 60);
  if (count > max) {
    throw new ApiError(429, 'API_KEY_RATE_LIMITED', `API key rate limit exceeded (${max}/min)`, {
      retryAfterSec: 60,
    });
  }

  // Throttled last-used touch (one write per 5 min per key).
  await query(
    `UPDATE api_keys SET last_used_at = now()
     WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`,
    [row.id],
  );

  return {
    ctx: {
      // B1-R1: API keys carry no user — userId is null, never the old
      // `apikey:<uuid>` pseudo-id (which 500'd on UUID columns).
      userId: null,
      tenantId: row.tenant_id as string,
      plan: row.plan_id as PlanId,
      email: '',
      name: 'API key',
      emailVerified: true,
      // Keys authenticate as the tenant; fine-grained access is gated by
      // requireScope on each route, not by team roles.
      role: 'api-key',
      isPlatformAdmin: false,
      readOnly: row.read_only === true,
      apiKeyId: row.id as string,
      apiKeyScopes: (row.scopes as string[]) ?? [],
    },
    suspendedAt: (row.suspended_at as string | null) ?? null,
  };
}

/** Fastify plugin: verifies JWT and attaches req.tenant. Use on all tenant routes.
 * NOTE: this plugin MUST stay encapsulated (plain async function, no
 * fastify-plugin wrapper): fastify-plugin would lift the preHandler hook onto
 * the parent /api/v1 scope and force auth on public routes like
 * /auth/signup, /auth/login and /billing/webhook. */
export async function authPlugin(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (req) => {
    // F-13: API keys authenticate as the tenant (Bearer bseo_... or
    // x-api-key header). JWT session auth is the fallback.
    const apiKeyRaw = apiKeyFromRequest(req);
    if (apiKeyRaw) {
      const { ctx, suspendedAt } = await tenantFromApiKey(apiKeyRaw);
      req.tenant = ctx;
      enforceTenantState(req, suspendedAt);
      return;
    }
    const token = tokenFromRequest(req);
    if (!token) throw unauthorized('Authentication required');
    let payload: any;
    try {
      payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    const r = await query(
      `SELECT u.id AS user_id, u.email, u.name, u.tenant_id, u.token_version, u.email_verified_at,
              u.role, u.is_platform_admin, t.plan_id, t.suspended_at, t.read_only
       FROM users u JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1 AND u.tenant_id = $2`,
      [payload.uid, payload.tid],
    );
    if (r.rows.length === 0) throw unauthorized('Account not found');
    const row = r.rows[0];
    // Token version: logout bumps users.token_version, instantly revoking
    // all previously issued tokens for that user.
    if (Number(row.token_version ?? 0) !== Number(payload.tv ?? 0)) {
      throw unauthorized('Session revoked — please log in again');
    }
    // S-05: the 2FA challenge token is single-purpose — it can only be
    // exchanged at POST /auth/totp/verify, never used for API access.
    if (payload.purpose && payload.purpose !== 'auth') {
      throw unauthorized('Authentication required');
    }
    // S-05: per-session revocation. Tokens minted before S-05 have no jti
    // and skip this check (they still die on token_version bumps and expire
    // within 7 days).
    if (payload.jti) {
      const active = await isSessionActive(payload.uid as string, payload.jti as string);
      if (!active) throw unauthorized('Session revoked — please log in again');
      // Throttled last-seen touch (one write per 10 min per session).
      touchSession(payload.jti as string).catch(() => {});
    }
    req.tenant = {
      userId: row.user_id,
      tenantId: row.tenant_id,
      plan: row.plan_id as PlanId,
      email: row.email,
      name: row.name,
      emailVerified: row.email_verified_at != null,
      jti: typeof payload.jti === 'string' ? payload.jti : undefined,
      // F-09/F-13/F-14 (Backend-A): role, platform-admin flag and read-only
      // state ride on the session context (cross-module addition — flagged
      // to LA; B1 owns this file).
      role: (row.role as string) ?? 'owner',
      isPlatformAdmin: row.is_platform_admin === true,
      readOnly: row.read_only === true,
    };
    // C-01/F-14: suspended tenants blocked; read-only tenants limited to
    // reads + billing/admin/account/apikeys/settings mutations.
    enforceTenantState(req, row.suspended_at as string | null);
  });
}

/**
 * C-01 / F-14: suspended tenants are fully blocked; read-only tenants
 * (downgraded with excess usage) may read and manage billing/admin/account
 * but cannot mutate product resources. Enforcement lives here because
 * authPlugin is the single choke point for every tenant route.
 */
function enforceTenantState(req: FastifyRequest, suspendedAt?: string | null): void {
  if (suspendedAt) {
    throw new ApiError(
      403,
      'TENANT_SUSPENDED',
      'This workspace has been suspended. Please contact support.',
    );
  }
  const tenant = (req as { tenant?: TenantContext }).tenant;
  if (!tenant?.readOnly) return;
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
  const url = req.url.split('?')[0];
  // Billing/admin/account/apikeys/settings stay writable so a read-only
  // tenant can upgrade, manage their team, and configure alerts.
  if (/^\/api\/v1\/(billing|admin|account|apikeys|settings|auth|webhooks)(\/|$)/.test(url)) return;
  throw new ApiError(
    403,
    'READ_ONLY_MODE',
    'Your workspace is in read-only mode because usage exceeds your current plan limits. ' +
      'Upgrade your plan or remove excess resources to make changes.',
    { upgrade: true },
  );
}
