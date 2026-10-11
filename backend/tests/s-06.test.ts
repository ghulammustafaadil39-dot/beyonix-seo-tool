// S-06 — Cookies/CSRF/helmet/CSP/CORS allow-list.
// Pure-function tests (no DB/Redis): header maps, cookie options, CSRF logic,
// CORS parsing, and the Next.js headers() config.
import { describe, expect, it } from 'vitest';
import {
  apiSecurityHeaders,
  authCookieOptions,
  csrfCookieOptions,
  parseCorsOrigins,
} from '../src/services/securityHeaders.js';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  csrfTokenValid,
  issueCsrfToken,
  requiresCsrfCheck,
} from '../src/middleware/csrf.js';

describe('S-06 API security headers (helmet-style)', () => {
  it('sets the expected hardening headers', () => {
    const h = apiSecurityHeaders();
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['Permissions-Policy']).toContain('camera=()');
    expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin');
    // Never overrides content headers.
    expect(h['Content-Type']).toBeUndefined();
    expect(h['Content-Length']).toBeUndefined();
  });
});

describe('S-06 cookie flags', () => {
  it('auth cookie is httpOnly + lax by default, secure in production', () => {
    delete process.env.COOKIE_SAMESITE;
    const o = authCookieOptions();
    expect(o.httpOnly).toBe(true);
    expect(o.sameSite).toBe('lax');
    expect(o.path).toBe('/');
    // NODE_ENV=test here -> not secure; production flips it on.
    expect(o.secure).toBe(false);
  });

  it('SameSite=none forces Secure (fail-safe for split domains)', () => {
    process.env.COOKIE_SAMESITE = 'none';
    try {
      const o = authCookieOptions();
      expect(o.sameSite).toBe('none');
      expect(o.secure).toBe(true);
    } finally {
      delete process.env.COOKIE_SAMESITE;
    }
  });

  it('rejects invalid SameSite values (falls back to lax)', () => {
    process.env.COOKIE_SAMESITE = 'evil';
    try {
      expect(authCookieOptions().sameSite).toBe('lax');
    } finally {
      delete process.env.COOKIE_SAMESITE;
    }
  });

  it('CSRF cookie is readable by JS (double-submit) with the same site policy', () => {
    const o = csrfCookieOptions();
    expect(o.httpOnly).toBe(false);
    expect(o.sameSite).toBe('lax');
    expect(o.path).toBe('/');
  });
});

describe('S-06 CSRF double-submit', () => {
  it('issues unpredictable tokens', () => {
    const a = issueCsrfToken();
    const b = issueCsrfToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('validates the double-submit (timing-safe)', () => {
    const tok = issueCsrfToken();
    expect(csrfTokenValid(tok, tok)).toBe(true);
    expect(csrfTokenValid(tok, issueCsrfToken())).toBe(false);
    expect(csrfTokenValid(tok, undefined)).toBe(false);
    expect(csrfTokenValid(undefined, tok)).toBe(false);
    expect(csrfTokenValid('', '')).toBe(false);
  });

  it('only cookie-authenticated mutations require the check', () => {
    // Cookie session, no bearer -> check.
    expect(requiresCsrfCheck('POST', true, false)).toBe(true);
    expect(requiresCsrfCheck('DELETE', true, false)).toBe(true);
    expect(requiresCsrfCheck('PUT', true, false)).toBe(true);
    expect(requiresCsrfCheck('PATCH', true, false)).toBe(true);
    // Safe methods never.
    expect(requiresCsrfCheck('GET', true, false)).toBe(false);
    // Bearer clients are not browsers -> exempt.
    expect(requiresCsrfCheck('POST', true, true)).toBe(false);
    expect(requiresCsrfCheck('POST', false, true)).toBe(false);
    // No session cookie at all -> nothing to forge.
    expect(requiresCsrfCheck('POST', false, false)).toBe(false);
  });

  it('uses the agreed cookie/header names', () => {
    expect(CSRF_COOKIE).toBe('bseo_csrf');
    expect(CSRF_HEADER).toBe('x-csrf-token');
  });
});

describe('S-06 CORS allow-list', () => {
  it('parses a comma-separated env allow-list, dropping junk', () => {
    expect(parseCorsOrigins('https://app.example.com, https://admin.example.com', 'https://dflt.example.com')).toEqual([
      'https://app.example.com',
      'https://admin.example.com',
    ]);
    // Junk (non-URL, wrong scheme) is dropped, never passed to the cors plugin.
    expect(parseCorsOrigins('https://ok.example.com, javascript:alert(1), not-a-url', 'https://dflt.example.com')).toEqual([
      'https://ok.example.com',
    ]);
  });

  it('falls back to the app URL when unset or fully invalid', () => {
    expect(parseCorsOrigins('', 'https://dflt.example.com')).toEqual(['https://dflt.example.com']);
    expect(parseCorsOrigins('junk', 'https://dflt.example.com')).toEqual(['https://dflt.example.com']);
  });
});

describe('S-06 Next.js security headers', () => {
  it('next.config.js serves strict headers incl. CSP', async () => {
    const mod: any = await import('../../frontend/next.config.js');
    const cfg = mod.default ?? mod;
    expect(cfg.poweredByHeader ?? true).toBe(false);
    expect(typeof cfg.headers).toBe('function');
    const headers = await cfg.headers();
    expect(headers.length).toBeGreaterThan(0);
    const all = headers.flatMap((h: any) => h.headers);
    const byKey = (k: string) => all.find((h: any) => h.key.toLowerCase() === k.toLowerCase())?.value as string;
    expect(byKey('X-Content-Type-Options')).toBe('nosniff');
    expect(byKey('X-Frame-Options')).toBe('DENY');
    expect(byKey('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    const csp = byKey('Content-Security-Policy');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('https://fonts.googleapis.com');
    expect(csp).toContain('https://fonts.gstatic.com');
    expect(byKey('Permissions-Policy')).toContain('camera=()');
  });
});
