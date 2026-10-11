# Multi-stage build for the Next.js frontend (standalone output).
# The runtime image contains only the standalone server — no source tree,
# no devDependencies, no build tools.
# S-10: all base images digest-pinned (multi-arch manifest lists, 2026-10-11);
# the runner drops privileges to the non-root `node` user.

# ---- deps: install once, reused by the builder stage ----
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: produce the standalone server ----
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time API URL override for NON-PROXIED deploys only (browser calls
# the API directly). Leave unset (default): the browser uses same-origin
# relative URLs and app/api/[...path]/route.ts proxies /api/* to the runtime
# API_INTERNAL_URL — no rebuild needed to change the API target.
ARG NEXT_PUBLIC_API_URL
# G-2 (Final Gate): the compose file passes NEXT_PUBLIC_SITE_URL as a build
# arg — it must be declared here or Docker silently ignores it and the
# frontend falls back to the hardcoded site URL in layout/robots/sitemap.
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner: the standalone server (matches output: 'standalone') ----
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME="0.0.0.0"
# next.config.js is NOT reloaded by the standalone server (config is
# serialized at build time), so the /api proxy target is a runtime-only env
# var read per request by app/api/[...path]/route.ts — never baked in.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
# S-10: drop privileges — the standalone server binds an unprivileged port.
USER node
CMD ["node", "server.js"]
