/**
 * Wave-4 Pass #1 regression-test helpers.
 * Runs in the `integration` vitest project: real Postgres (DATABASE_URL from
 * env — use your own test DB, never the shared one) + real Redis DB 1.
 */
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../integration/helpers/app.js';
import { query } from '../integration/helpers/db.js';
import { uniqueEmail } from '../integration/helpers/db.js';
import { hashPassword } from '../../src/middleware/auth.js';

export { buildTestApp, query, uniqueEmail };

export interface W4User {
  token: string;
  userId: string;
  email: string;
  tenantId: string;
  role: string;
}

/** Extract the bseo_token session JWT from a login/signup response. */
export function tokenFrom(res: { headers: any }): string {
  const raw = res.headers?.['set-cookie'];
  const list: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const pair = list.find((c: string) => c.startsWith('bseo_token='));
  if (!pair) throw new Error('expected bseo_token cookie in response');
  return pair.split(';')[0].slice('bseo_token='.length);
}

/** Sign up an owner (verified) through the real API. */
export async function signupOwner(app: FastifyInstance, password = 'W4$x9Qv!2LpR7#tZ'): Promise<W4User> {
  const email = uniqueEmail('w4owner');
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, password, name: 'W4 Owner' },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
  const body = res.json() as any;
  await query('UPDATE users SET email_verified_at = now() WHERE id = $1', [body.user.id]);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  return { token: tokenFrom(login), userId: body.user.id, email, tenantId: body.tenant.id, role: 'owner' };
}

/** Add a team member with the given F-09 role to an existing tenant. */
export async function addTeamMember(
  app: FastifyInstance,
  tenantId: string,
  role: 'admin' | 'editor' | 'viewer',
  password = 'W4$x9Qv!2LpR7#tZ',
): Promise<W4User> {
  const email = uniqueEmail(`w4${role}`);
  const pwHash = await hashPassword(password);
  const u = await query(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, role, email_verified_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now()) RETURNING id`,
    [tenantId, email.toLowerCase(), pwHash, `W4 ${role}`, role],
  );
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password } });
  if (login.statusCode !== 200) throw new Error(`login failed for ${role}: ${login.statusCode} ${login.body}`);
  return { token: tokenFrom(login), userId: u.rows[0].id as string, email, tenantId, role };
}

/** Create a site via the API as the given user. */
export async function createSite(app: FastifyInstance, user: W4User, domain?: string): Promise<string> {
  const d = domain ?? `w4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/sites',
    headers: { authorization: `Bearer ${user.token}` },
    payload: { domain: d },
  });
  if (res.statusCode !== 201) throw new Error(`createSite failed: ${res.statusCode} ${res.body}`);
  return (res.json() as any).id as string;
}

export function authz(user: W4User): Record<string, string> {
  return { authorization: `Bearer ${user.token}` };
}
