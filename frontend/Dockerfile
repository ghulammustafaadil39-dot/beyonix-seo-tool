# Multi-stage build for the Next.js frontend (standalone output).
# The runtime image contains only the standalone server — no source tree,
# no devDependencies, no build tools.

# ---- deps: install once, reused by the builder stage ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: produce the standalone server ----
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time API URL override for NON-PROXIED deploys only (browser calls
# the API directly). Leave unset (default): the browser uses same-origin
# relative URLs and app/api/[...path]/route.ts proxies /api/* to the runtime
# API_INTERNAL_URL — no rebuild needed to change the API target.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner: the standalone server (matches output: 'standalone') ----
FROM node:24-alpine AS runner
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
CMD ["node", "server.js"]
