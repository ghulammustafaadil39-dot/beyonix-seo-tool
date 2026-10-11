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
 * with an ambient session cookie and no non-ambient credential. A present
 * `x-api-key` header proves a non-ambient credential exactly like an
 * Authorization header (A1-M2/A2-L4): API-key browser clients that also
 * carry the session cookie must not be CSRF-rejected on mutations.
 * Pure and unit-testable; the Fastify guard below wraps it.
 */
export function requiresCsrfCheck(
  method: string,
  hasSessionCookie: boolean,
  hasAuthHeader: boolean,
  hasApiKey = false,
): boolean {
  return (
    MUTATION_METHODS.has(method.toUpperCase()) && hasSessionCookie && !hasAuthHeader && !hasApiKey
  );
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
  // A1-M2: an x-api-key header is a non-ambient credential — exempt like
  // the Authorization header so API-key browser clients carrying the
  // session cookie aren't 403'd on every mutation.
  const hasApiKey = !!req.headers['x-api-key'];
  if (!requiresCsrfCheck(req.method, hasSessionCookie, hasAuthHeader, hasApiKey)) return;
  const ok = csrfTokenValid(cookies?.[CSRF_COOKIE], req.headers[CSRF_HEADER] as string | undefined);
  if (!ok) {
    throw new ApiError(403, 'CSRF_INVALID', 'Missing or invalid CSRF token');
  }
}
