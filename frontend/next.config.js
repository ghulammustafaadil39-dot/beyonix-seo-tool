/**
 * S-06: strict security headers for the Next.js frontend.
 *
 * CSP notes:
 * - script-src keeps 'unsafe-inline': Next.js App Router emits inline
 *   <script> tags for React Flight data; without it the app breaks. External
 *   scripts are still restricted to 'self', and frame-ancestors/object-src/
 *   base-uri/form-action stay locked down.
 * - style-src allows fonts.googleapis.com (Inter/JetBrains Mono in
 *   app/layout.tsx) + 'unsafe-inline' (styled-jsx/Tailwind runtime styles).
 * - img-src allows https: (user site screenshots/favicons may be remote).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https:",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  'upgrade-insecure-requests',
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // S-06: don't advertise the framework version.
  poweredByHeader: false,
  // S-06: security headers on every route (incl. the /api proxy route).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
          { key: 'Content-Security-Policy', value: CSP },
        ],
      },
    ];
  },
  // NOTE: the same-origin /api proxy lives in app/api/[...path]/route.ts,
  // NOT in rewrites() here. Rewrites are evaluated at build time and baked
  // into the standalone server, so a rewrite destination could never be
  // changed at runtime — and it would shadow the proxy route above.
};

module.exports = nextConfig;
