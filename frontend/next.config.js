/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // NOTE: the same-origin /api proxy lives in app/api/[...path]/route.ts,
  // NOT in rewrites() here. Rewrites are evaluated at build time and baked
  // into the standalone server, so a rewrite destination could never be
  // changed at runtime — and it would shadow the proxy route above.
};

module.exports = nextConfig;
