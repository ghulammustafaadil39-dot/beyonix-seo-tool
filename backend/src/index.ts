import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { runMigrations } from './db.js';
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

  await app.register(cookie);
  await app.register(cors, {
    origin: [config.appUrl],
    credentials: true,
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

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

  app.get('/healthz', async () => ({ ok: true, time: new Date().toISOString() }));

  await app.register(
    async (v1) => {
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
