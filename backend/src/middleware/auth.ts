import type { FastifyInstance, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';
import { unauthorized } from '../errors.js';
import type { PlanId } from '../plans.js';

export interface TenantContext {
  userId: string;
  tenantId: string;
  plan: PlanId;
  email: string;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenant: TenantContext;
  }
}

const COOKIE_NAME = 'bseo_token';

export function signToken(userId: string, tenantId: string, tokenVersion = 0): string {
  return jwt.sign({ uid: userId, tid: tenantId, tv: tokenVersion }, config.jwtSecret, { expiresIn: '7d' });
}

export function setAuthCookie(reply: any, token: string) {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: '/',
    maxAge: 7 * 24 * 3600,
  });
}

export function clearAuthCookie(reply: any) {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
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
      `SELECT u.id AS user_id, u.email, u.name, u.tenant_id, u.token_version, t.plan_id
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
    req.tenant = {
      userId: row.user_id,
      tenantId: row.tenant_id,
      plan: row.plan_id as PlanId,
      email: row.email,
      name: row.name,
    };
  });
}

export { COOKIE_NAME };
