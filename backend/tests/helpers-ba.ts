/**
 * Shared helpers for Backend-A Wave 2 tests (unit project, real PG/Redis).
 * NOT a test file itself (no .test.ts suffix).
 */
import type { FastifyInstance } from 'fastify';
import { sessionTokenFromResponse } from './helpers.js';

let seq = 0;

/** Unique email per call (never collides across files/workers). */
export function uniqueEmail(prefix = 'ba'): string {
  seq += 1;
  return `${prefix}+${Date.now()}-${process.pid}-${seq}@beyo.test`;
}

/**
 * Unique, non-breached password per signup. The S-05 breach check queries
 * the real HIBP corpus, so fixed test passwords get rejected.
 */
export function uniquePassword(): string {
  return `Ba!${Date.now()}${Math.floor(Math.random() * 1e9)}xQ9#Zz`;
}

export interface BaUser {
  token: string;
  userId: string;
  email: string;
  tenantId: string;
}

/** Signup + email verification through the real API. */
export async function signupVerified(app: FastifyInstance, email?: string): Promise<BaUser> {
  const em = email ?? uniqueEmail();
  const s = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email: em, password: uniquePassword(), name: 'BA' },
  });
  if (s.statusCode !== 201) throw new Error(`signup failed: ${s.statusCode} ${s.body}`);
  const body = s.json() as any;
  const v = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/email/verify',
    payload: { token: body.verifyToken },
  });
  if (v.statusCode !== 200) throw new Error(`verify failed: ${v.statusCode} ${v.body}`);
  return { token: sessionTokenFromResponse(s), userId: body.user.id as string, email: em, tenantId: body.tenant.id as string };
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/** Collect tenant ids for afterAll cleanup. */
export function tenantCollector() {
  const ids: string[] = [];
  return {
    ids,
    add: (...newIds: string[]) => ids.push(...newIds),
  };
}
