// Same-origin API proxy.
//
// The browser always calls relative /api/* URLs (see lib/api.ts) and this
// route forwards them to the backend API. The API origin is read from the
// runtime environment on EVERY request, so the image never needs rebuilding
// to point at a different API.
//
// Why a route and not a next.config.js rewrite: rewrites are evaluated at
// build time and baked into the standalone server (see server.js), so a
// rewrite destination can never be changed at runtime. Do NOT add an
// /api/* rewrite — it would shadow this route and reintroduce the
// build-time-baked URL problem.
//
// Auth: the API sets a host-only httpOnly cookie (bseo_token, no Domain
// attribute), so Set-Cookie from this same-origin route scopes the cookie
// to the web origin and the Cookie header is forwarded back on each call.

export const dynamic = 'force-dynamic';

function apiOrigin(): string {
  return (
    process.env.API_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    'http://localhost:4000'
  ).replace(/\/+$/, '');
}

// Hop-by-hop / framing headers must not be forwarded in either direction.
const SKIP_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
]);
const SKIP_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
]);

type Ctx = { params: { path: string[] } };

async function proxy(req: Request, ctx: Ctx): Promise<Response> {
  const target = `${apiOrigin()}/api/${ctx.params.path.map(encodeURIComponent).join('/')}${
    new URL(req.url).search
  }`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!SKIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });

  let res: Response;
  try {
    res = await fetch(target, {
      method: req.method,
      headers,
      body:
        req.method === 'GET' || req.method === 'HEAD'
          ? undefined
          : await req.arrayBuffer(),
      // The API never issues browser-navigation redirects; surface API
      // redirects as-is instead of following them server-side.
      redirect: 'manual',
    });
  } catch {
    return Response.json(
      {
        error: {
          code: 'NETWORK_ERROR',
          message:
            "We couldn't reach the server. Check your connection and try again.",
        },
      },
      { status: 502 },
    );
  }

  const outHeaders = new Headers();
  res.headers.forEach((value, key) => {
    if (!SKIP_RESPONSE_HEADERS.has(key.toLowerCase()))
      outHeaders.append(key, value);
  });
  // getSetCookie() keeps multiple Set-Cookie headers separate; the plain
  // iteration above would merge them with ", " and corrupt cookies.
  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] })
    .getSetCookie;
  if (typeof getSetCookie === 'function') {
    const cookies = getSetCookie.call(res.headers);
    if (cookies.length > 0) {
      outHeaders.delete('set-cookie');
      for (const c of cookies) outHeaders.append('set-cookie', c);
    }
  }

  return new Response(res.body, { status: res.status, headers: outHeaders });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
