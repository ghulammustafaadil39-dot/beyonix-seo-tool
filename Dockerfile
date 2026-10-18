# Root Dockerfile for Railway - builds the backend from backend/ subdirectory
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/tsconfig.json ./
COPY backend/src ./src
COPY backend/migrations ./migrations
COPY start.sh ./
RUN npm run build && npm prune --omit=dev
RUN test -f ./dist/prompts/geo-answer.txt
RUN chmod +x ./start.sh
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-4000}/healthz || exit 1
CMD ["./start.sh"]
