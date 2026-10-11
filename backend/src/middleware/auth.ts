import type { FastifyInstance, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { unauthorized } from '../errors.js';
import { isSessionActive, touchSession } from '../services/sessions.js';
import { CSRF_COOKIE } from './csrf.js';
import { authCookieOptions, csrfCookieOptions } from '../services/securityHeaders.js';
import type { PlanId } from '../plans.js';

export interface TenantContext {
  userId: string;
  tenantId: string;
  plan: PlanId;
  email: string;
  name: string;
  /** S-01: false until the user completes email verification. */
  emailVerified: boolean;
  /** S-05: the token's jti (undefined for pre-S-05 legacy tokens). */
  jti?: string;
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

/** Fastify plugin: verifies JWT and attaches req.tenant. Use on all tenant routes.
 * NOTE: this plugin MUST stay encapsulated (plain async function, no
 * fastify-plugin wrapper): fastify-plugin would lift the preHandler hook onto
 * the parent /api/v1 scope and force auth on public routes like
 * /auth/signup, /auth/login and /billing/webhook. */
export async function authPlugin(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (req) => {
    const token = tokenFromRequest(req);
    if (!token) throw unauthorized('Authentication required');
    let payload: any;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    const r = await query(
      `SELECT u.id AS user_id, u.email, u.name, u.tenant_id, u.token_version, u.email_verified_at, t.plan_id
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
    };
  });
}
