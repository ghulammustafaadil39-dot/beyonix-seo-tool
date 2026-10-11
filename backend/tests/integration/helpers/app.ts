/**
 * Fastify app helpers for integration tests.
 *
 * buildTestApp() builds the real app (buildApp from src/index.ts) WITHOUT
 * listening on a socket — tests drive it with app.inject(). Each test file
 * builds its own instance in beforeAll and closes it in afterAll; the DB
 * pool and Redis client are worker-scoped and stay open across files.
 */
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../../src/index.js';
import { uniqueEmail } from './db.js';

export async function buildTestApp(): Promise<FastifyInstance> {
  return buildApp();
}

export interface TestUser {
  token: string;
  userId: string;
  email: string;
  tenantId: string;
}

/** Sign up a fresh user+tenant through the real API. Password is fixed. */
export async function signupUser(app: FastifyInstance, name = 'QA User'): Promise<TestUser> {
  const email = uniqueEmail();
  const password = 'TestPass123!';
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, password, name },
  });
  if (res.statusCode !== 201) {
    throw new Error(`signupUser failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json() as any;
  // JWT-in-body fix: the session JWT is delivered ONLY via the httpOnly
  // `bseo_token` cookie, never in the JSON body.
  const raw = res.headers['set-cookie'];
  const cookies: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const pair = cookies.find((c: string) => c.startsWith('bseo_token='));
  if (!pair) throw new Error('signupUser: expected bseo_token cookie in response');
  const token = pair.split(';')[0].slice('bseo_token='.length);
  return { token, userId: body.user.id, email, tenantId: body.tenant.id };
}

export function authHeaders(u: TestUser): Record<string, string> {
  return { authorization: `Bearer ${u.token}` };
}
