import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { pool, runMigrations } from './db.js';
import { Redis } from 'ioredis';
import { getRedis } from './redis.js';
import { createRateLimitStore } from './services/redisRateLimitStore.js';
import { apiSecurityHeaders, parseCorsOrigins } from './services/securityHeaders.js';
import { csrfGuard } from './middleware/csrf.js';
import { errorEnvelope } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerBillingRoutes } from './routes/billing.js';
import { registerSitesRoutes } from './routes/sites.js';
import { registerGscRoutes } from './routes/gsc.js';
import { registerGa4Routes } from './routes/ga4.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerKeywordRoutes } from './routes/keywords.js';
import { registerRankRoutes } from './routes/ranks.js';
import { registerContentRoutes } from './routes/content.js';
import { registerOnpageRoutes } from './routes/onpage.js';
import { registerBacklinkRoutes } from './routes/backlinks.js';
import { registerGeoRoutes } from './routes/geo.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerSettingsRoutes } from './routes/settings.js';

export async function buildApp() {
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
    // S-03: TRUST_PROXY from env. Default false (fail closed) — req.ip comes
    // from the socket unless the operator explicitly trusts their proxy.
    // (Fastify's types omit `number`, but proxy-addr underneath accepts a
    // hop count — the cast is runtime-safe.)
    trustProxy: config.trustProxy as unknown as boolean | string,
    // N-A1-2: every request gets an id (honors a client-supplied
    // x-request-id); it is echoed on responses and included in every error
    // body via errorEnvelope, and fastify logs carry it as `requestId`.
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    genReqId: () => randomUUID(),
  });

  // Echo the request id on every response.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // S-06: helmet-style hardening headers on every API response.
  const HARDENING_HEADERS = apiSecurityHeaders();
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(HARDENING_HEADERS)) {
      if (!reply.hasHeader(k)) reply.header(k, v);
    }
    return payload;
  });

  await app.register(cookie);
  // S-06: CORS allow-list comes from CORS_ORIGINS env ONLY (comma-separated);
  // falls back to the configured app URL. Never '*'.
  await app.register(cors, {
    origin: parseCorsOrigins(config.corsOrigins, config.appUrl),
    credentials: true,
  });
  // S-03: per-IP limits are Redis-backed (shared across API instances) —
  // the old in-memory store let an attacker get N x limit by hitting each
  // instance. Keyed on req.ip, which respects trustProxy above.
  await app.register(rateLimit, {
    max: config.globalRateLimitPerMin,
    timeWindow: '1 minute',
    store: createRateLimitStore(getRedis()),
  });

  app.setErrorHandler((err, req, reply) => {
    const { status, body } = errorEnvelope(err, req.id);
    reply.status(status).send(body);
  });

  // Unknown routes also get the contract envelope (with requestId), not
  // fastify's default 404 shape.
  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Not found', ...(req.id ? { requestId: req.id } : {}) },
    });
  });

  // Liveness: dependency-free, answers even when DB/Redis are down.
  app.get('/healthz', async () => ({ ok: true, time: new Date().toISOString() }));

  // Readiness (P0-02): 200 only when Postgres AND Redis answer. Orchestrators
  // and compose healthchecks use /healthz for liveness, /readyz for readiness.
  const readinessRedis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  app.get('/readyz', async (_req, reply) => {
    let db = false;
    let redis = false;
    try {
      await pool.query('SELECT 1');
      db = true;
    } catch {
      /* stays false */
    }
    try {
      await readinessRedis.ping();
      redis = true;
    } catch {
      /* stays false */
    }
    const ok = db && redis;
    return reply.status(ok ? 200 : 503).send({ ok, db, redis, time: new Date().toISOString() });
  });

  await app.register(
    async (v1) => {
      // S-06: CSRF double-submit guard, scoped to /api/v1 (encapsulated —
      // never lifted to the app root). Only cookie-authenticated mutations
      // are checked; Bearer clients and safe methods are exempt.
      v1.addHook('preHandler', csrfGuard);
      // NOTE: every inner register MUST be awaited. Fire-and-forget here
      // deadlocks avvio: the outer `await app.register(...)` never resolves
      // and the API server never finishes booting (found by audit smoke test).
      await registerAuthRoutes(v1);
      await registerBillingRoutes(v1);
      await registerSitesRoutes(v1);
      await registerGscRoutes(v1);
      await registerGa4Routes(v1);
      await registerAuditRoutes(v1);
      await registerKeywordRoutes(v1);
      await registerRankRoutes(v1);
      await registerContentRoutes(v1);
      await registerOnpageRoutes(v1);
      await registerBacklinkRoutes(v1);
      await registerGeoRoutes(v1);
      await registerReportRoutes(v1);
      await registerSettingsRoutes(v1);
    },
    { prefix: '/api/v1' },
  );

  return app;
}

async function main() {
  await runMigrations();
  const app = await buildApp();
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`[api] listening on :${config.port}`);
}

if (process.argv[1]?.endsWith('index.js')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
