/** @type {import('next').NextConfig} */

// Runtime origin of the backend API, used as the target of the same-origin
// /api proxy below. next.config.js is loaded by the standalone server at
// boot, so this is read from the *runtime* environment — the image never
// needs rebuilding to point at a different API. Falls back to the backend's
// default local port for `next dev`.
const API_URL = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/+$/, '');

const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // The browser always calls same-origin /api/* (lib/api.ts defaults to
  // relative URLs). The Next.js server proxies those requests to the API
  // origin, so the API URL is never baked into the client bundle.
  // Set NEXT_PUBLIC_API_URL as a *build arg* only for non-proxied deploys
  // where the browser must reach the API directly.
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${API_URL}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
