// A3-H1 — server-side impersonation handoff.
//
// The admin back-office used to take the short-lived impersonation JWT from
// POST /api/v1/admin/impersonate and write it with `document.cookie` — a
// JS-readable, non-Secure cookie that defeated the httpOnly session design
// (S-06): any XSS during the 5-minute impersonation window could steal the
// tenant session, and it conflicted with the real httpOnly bseo_token.
//
// This route keeps the token off the client entirely. The browser POSTs
// { tenantId } here (same-origin); the handler forwards the admin's session
// cookies to the API — so requirePlatformAdmin, the audit log, and the
// CSRF double-submit guard all still apply — and the impersonation JWT is
// returned to the browser ONLY as an httpOnly Set-Cookie whose flags mirror
// the API's own cookie policy (Secure in production or SameSite=None;
// SameSite per COOKIE_SAMESITE). The response body never contains the token.
//
// Design choice (Wave 4): the backend route only returns JSON { token }
// (backend/src/routes/admin.ts), and backend/ is owned by another agent, so
// a backend Set-Cookie step was not available. Alternatives considered:
//  - navigating to a backend endpoint that sets the cookie — no such
//    endpoint exists, and a token-in-URL GET would leak via logs/history;
//  - keeping the token in memory + Authorization: Bearer — a full-page
//    navigation to /dashboard loses in-memory state, persisting it in
//    sessionStorage is equally JS-readable (no security gain), and it
//    diverges from the cookie-based auth design. Rejected.
// The existing readable bseo_csrf cookie is deliberately untouched: it stays
// valid across impersonation because the CSRF guard only compares
// cookie-vs-header, not session binding.

export const dynamic = 'force-dynamic';

function apiOrigin(): string {
  return (
    process.env.API_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    'http://localhost:4000'
  ).replace(/\/+$/, '');
}

/** Mirrors backend securityHeaders cookieSecure()/cookieSameSite(). */
function cookieFlags(maxAgeSec: number): string {
  const raw = (process.env.COOKIE_SAMESITE || 'lax').trim().toLowerCase();
  const sameSite = raw === 'strict' ? 'Strict' : raw === 'none' ? 'None' : 'Lax';
  const secure =
    process.env.NODE_ENV === 'production' || sameSite === 'None' ? '; Secure' : '';
  // NOTE: maxAgeSec comes from the API's expiresInSec (300 for impersonation).
  return `Path=/; Max-Age=${maxAgeSec}; HttpOnly; SameSite=${sameSite}${secure}`;
}

interface ImpersonateOk {
  token: string;
  tenantId: string;
  expiresInSec: number;
}

export async function POST(req: Request): Promise<Response> {
  let tenantId: unknown;
  try {
    tenantId = (await req.json())?.tenantId;
  } catch {
    tenantId = undefined;
  }
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    return Response.json(
      { error: { code: 'VALIDATION_ERROR', message: 'tenantId is required' } },
      { status: 400 },
    );
  }

  // Forward the admin's ambient credentials so the API's own guards apply:
  // requirePlatformAdmin (auth) + csrfGuard (double-submit on this POST).
  const upstreamHeaders = new Headers();
  const cookie = req.headers.get('cookie');
  if (cookie) upstreamHeaders.set('cookie', cookie);
  const csrf = req.headers.get('x-csrf-token');
  if (csrf) upstreamHeaders.set('x-csrf-token', csrf);
  upstreamHeaders.set('content-type', 'application/json');

  let upstream: Response;
  try {
    upstream = await fetch(`${apiOrigin()}/api/v1/admin/impersonate`, {
      method: 'POST',
      headers: upstreamHeaders,
      body: JSON.stringify({ tenantId }),
      redirect: 'manual',
    });
  } catch {
    return Response.json(
      {
        error: {
          code: 'NETWORK_ERROR',
          message: "We couldn't reach the server. Check your connection and try again.",
        },
      },
      { status: 502 },
    );
  }

  const body = (await upstream.json().catch(() => null)) as (Partial<ImpersonateOk> & {
    error?: { code?: string; message?: string };
  }) | null;

  if (!upstream.ok || !body || typeof body.token !== 'string' || body.token.length === 0) {
    // Never echo the upstream body (it carries the token on success paths);
    // surface the API's error envelope when present.
    return Response.json(
      {
        error: {
          code: body?.error?.code ?? 'UPSTREAM_ERROR',
          message: body?.error?.message ?? 'Impersonation failed.',
        },
      },
      { status: upstream.status || 500 },
    );
  }

  const maxAge =
    Number.isFinite(body.expiresInSec) && (body.expiresInSec as number) > 0
      ? Math.floor(body.expiresInSec as number)
      : 300;
  // JWTs are base64url — no cookie-separator characters; safe unencoded.
  const setCookie = `bseo_token=${body.token}; ${cookieFlags(maxAge)}`;

  return new Response(JSON.stringify({ ok: true, tenantId: body.tenantId ?? tenantId }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': setCookie,
    },
  });
}
