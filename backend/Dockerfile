# S-10: hardened backend image.
# - Base image digest-pinned (multi-arch manifest list; refresh deliberately).
# - No `|| npm install` fallback: a lockfile drift must fail loudly, never
#   silently install unpinned dependencies.
# - Runs as the non-root `node` user (the API/worker never need root).
# Pinned 2026-10-11: node:24-alpine
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
WORKDIR /app
COPY package.json package-lock.json ./
# B2-H1: `npm ci` FULL here — typescript is a devDependency and `npm run
# build` needs `tsc`. devDependencies are pruned AFTER the build instead.
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build && npm prune --omit=dev
# A2-H2: build-smoke — tsc never emits .txt assets; `npm run build` copies
# src/prompts into dist/prompts (see package.json). Fail the image build if
# the templates didn't land, so a future build-script regression is caught
# here instead of as ENOENTs in production.
RUN test -f ./dist/prompts/geo-answer.txt && \
    test "$(ls ./dist/prompts/*.txt | wc -l)" = "$(ls ./src/prompts/*.txt | wc -l)"
USER node
# B2-L9: liveness probe so orchestrators can tell a wedged API from a
# healthy one (busybox wget ships with alpine).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-4000}/healthz || exit 1
CMD ["node", "dist/index.js"]
