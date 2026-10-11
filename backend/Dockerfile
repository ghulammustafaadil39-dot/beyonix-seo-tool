# S-10: hardened backend image.
# - Base image digest-pinned (multi-arch manifest list; refresh deliberately).
# - No `|| npm install` fallback: a lockfile drift must fail loudly, never
#   silently install unpinned dependencies.
# - Runs as the non-root `node` user (the API/worker never need root).
# Pinned 2026-10-11: node:24-alpine
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build && npm prune --omit=dev
USER node
CMD ["node", "dist/index.js"]
