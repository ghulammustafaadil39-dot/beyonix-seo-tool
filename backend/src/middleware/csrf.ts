// S-06: CSRF double-submit for cookie-authenticated mutations.
//
// The API accepts both httpOnly-cookie sessions (browsers) and Bearer tokens
// (scripts/mobile). CSRF only threatens the cookie path: the guard requires
// cookie-authenticated POST/PUT/PATCH/DELETE requests to echo the readable
// `bseo_csrf` cookie value in the `x-csrf-token` header. An attacker's
// cross-site form can't read the cookie, so it can't forge the header.
// Bearer-authenticated requests are exempt (no ambient credentials).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';

export const CSRF_COOKIE = 'bseo_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Unpredictable per-session CSRF token (set as the readable cookie). */
export function issueCsrfToken(): string {
  return randomBytes(32).toString('hex');
}

/** Timing-safe double-submit comparison. Empty/missing never validates. */
export function csrfTokenValid(
  cookieVal: string | undefined,
  headerVal: string | undefined,
): boolean {
  if (!cookieVal || !headerVal) return false;
  const a = Buffer.from(cookieVal, 'utf8');
  const b = Buffer.from(headerVal, 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * True when this request must pass the CSRF check: a state-changing method
 * with an ambient session cookie and no explicit Authorization header.
 * Pure and unit-testable; the Fastify guard below wraps it.
 */
export function requiresCsrfCheck(
  method: string,
  hasSessionCookie: boolean,
  hasAuthHeader: boolean,
): boolean {
  return MUTATION_METHODS.has(method.toUpperCase()) && hasSessionCookie && !hasAuthHeader;
}

/**
 * Fastify preHandler: enforces the double-submit on cookie-authenticated
 * mutations. Register inside the /api/v1 scope (NOT global) so the rule
 * stays scoped to the API.
 */
export async function csrfGuard(req: FastifyRequest): Promise<void> {
  const cookies = (req as any).cookies as Record<string, string> | undefined;
  const hasSessionCookie = !!cookies?.['bseo_token'];
  const hasAuthHeader = !!req.headers.authorization?.startsWith('Bearer ');
  if (!requiresCsrfCheck(req.method, hasSessionCookie, hasAuthHeader)) return;
  const ok = csrfTokenValid(cookies?.[CSRF_COOKIE], req.headers[CSRF_HEADER] as string | undefined);
  if (!ok) {
    throw new ApiError(403, 'CSRF_INVALID', 'Missing or invalid CSRF token');
  }
}
