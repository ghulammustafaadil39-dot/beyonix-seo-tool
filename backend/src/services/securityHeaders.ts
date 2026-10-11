// S-06: cookies / helmet-style headers / CORS allow-list.
//
// Cookie strategy (N-A1-4): the frontend talks to the API through the
// same-origin /api proxy (P0-03), so the auth cookie is FIRST-party and
// SameSite=Lax is both correct and the most secure default. For non-proxied
// deploys (browser -> api.example.com directly, cross-site), the operator
// sets COOKIE_SAMESITE=none, which forces Secure (fail-safe).
import { config } from '../config.js';

export type SameSiteValue = 'lax' | 'strict' | 'none';

/** COOKIE_SAMESITE from env (live re-read for tests); invalid -> 'lax'. */
export function cookieSameSite(): SameSiteValue {
  const v = (process.env.COOKIE_SAMESITE ?? config.cookieSameSite ?? 'lax').trim().toLowerCase();
  if (v === 'lax' || v === 'strict' || v === 'none') return v;
  return 'lax';
}

/** Secure when in production OR when SameSite=None (browsers require it). */
function cookieSecure(): boolean {
  return config.nodeEnv === 'production' || cookieSameSite() === 'none';
}

export interface CookieFlags {
  httpOnly: boolean;
  sameSite: SameSiteValue;
  secure: boolean;
  path: string;
  maxAge: number;
}

/** Flags for the httpOnly auth cookie. */
export function authCookieOptions(): CookieFlags {
  return {
    httpOnly: true,
    sameSite: cookieSameSite(),
    secure: cookieSecure(),
    path: '/',
    maxAge: 7 * 24 * 3600,
  };
}

/**
 * Flags for the CSRF double-submit cookie. Deliberately NOT httpOnly — the
 * frontend reads it and echoes it in the x-csrf-token header (S-06).
 */
export function csrfCookieOptions(): CookieFlags {
  return {
    httpOnly: false,
    sameSite: cookieSameSite(),
    secure: cookieSecure(),
    path: '/',
    maxAge: 7 * 24 * 3600,
  };
}

/**
 * Helmet-style hardening headers applied to every API response (via an
 * onSend hook in index.ts). Deliberately excludes content headers and HSTS:
 * HSTS belongs on the TLS-terminating proxy (Q-05), not the app.
 */
export function apiSecurityHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

/**
 * Parses the CORS allow-list from env (comma-separated origins). Only
 * http(s) origins survive; anything else is dropped. Falls back to the
 * configured app URL so CORS is never accidentally wide open.
 */
export function parseCorsOrigins(raw: string | undefined, fallback: string): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const o = part.trim().replace(/\/$/, '');
    if (/^https?:\/\/[^/]+$/.test(o) && !out.includes(o)) out.push(o);
  }
  return out.length > 0 ? out : [fallback];
}
