/**
 * Q-03: GET /metrics (Prometheus text) + GET /status (JSON status data).
 *
 * Both live OUTSIDE /api/v1 (scrapers and status pages carry no session),
 * mirroring /healthz and /readyz. /metrics never leaks tenant ids, emails
 * or payload data — only method/route/status series, queue counts, job
 * outcomes and aggregate provider spend. Route labels use the matched
 * route pattern (req.routeOptions.url) so cardinality stays bounded.
 */
import type { FastifyInstance } from 'fastify';
import { pool, query } from '../db.js';
import { getRedis } from '../redis.js';
import { getQueue, QUEUES } from '../queues.js';
import {
  observabilityHooksEnabled,
  recordHttp,
  renderPrometheus,
  type LiveMetrics,
} from '../services/metrics.js';

async function liveMetrics(): Promise<LiveMetrics> {
  const queueDepth: LiveMetrics['queueDepth'] = {};
  for (const name of Object.values(QUEUES)) {
    try {
      const counts = await getQueue(name).getJobCounts('waiting', 'active', 'delayed', 'failed');
      queueDepth[name] = {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
      };
    } catch {
      queueDepth[name] = { waiting: 0, active: 0, delayed: 0, failed: 0 };
    }
  }
  let providerSpendCents30d: Record<string, number> = {};
  let deadLettersPending = 0;
  try {
    const spend = await query(
      `SELECT provider, COALESCE(SUM(cost_cents),0)::int AS cents
       FROM provider_spend WHERE created_at > now() - interval '30 days'
       GROUP BY provider`,
    );
    providerSpendCents30d = Object.fromEntries(
      spend.rows.map((r: any) => [String(r.provider), Number(r.cents)]),
    );
    const dl = await query(
      `SELECT COUNT(*)::int AS c FROM dead_letter_jobs WHERE status = 'pending'`,
    );
    deadLettersPending = Number(dl.rows[0]?.c ?? 0);
  } catch {
    /* tables may be absent on a pre-migration boot — report zeros */
  }
  return { queueDepth, providerSpendCents30d, deadLettersPending };
}

export async function registerMetricsRoutes(app: FastifyInstance): Promise<void> {
  // HTTP latency/count instrumentation: one hook for the whole app.
  app.addHook('onResponse', async (req, reply) => {
    try {
      recordHttp({
        method: req.method,
        route: (req as any).routeOptions?.url ?? req.url.split('?')[0],
        status: reply.statusCode,
        durationMs: Math.max(0, reply.elapsedTime ?? 0),
      });
    } catch {
      /* metrics must never break a response */
    }
  });

  app.get('/metrics', async (_req, reply) => {
    const live = await liveMetrics();
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(renderPrometheus(live));
  });

  app.get('/status', async (_req, reply) => {
    let db = false;
    let redis = false;
    try {
      await pool.query('SELECT 1');
      db = true;
    } catch { /* stays false */ }
    try {
      await getRedis().ping();
      redis = true;
    } catch { /* stays false */ }
    const live = await liveMetrics().catch(
      (): LiveMetrics => ({ queueDepth: {}, providerSpendCents30d: {}, deadLettersPending: 0 }),
    );
    const ok = db && redis;
    return reply.status(ok ? 200 : 503).send({
      ok,
      time: new Date().toISOString(),
      services: { db, redis },
      queues: live.queueDepth,
      deadLettersPending: live.deadLettersPending,
      providerSpendCents30d: live.providerSpendCents30d,
      hooks: observabilityHooksEnabled(),
    });
  });
}
