// W-05 backend: server-sent events for long jobs.
// Contract (proposed; additive to the frozen API):
//   GET /api/v1/sites/:id/jobs/stream
// One coherent stream per site (not per resource): it carries an audit
// section, a report section, and a rank-run section in every snapshot.
// Auth: httpOnly cookie `bseo_token` (EventSource cannot send headers;
// Bearer <redacted> also works for programmatic clients).
// Behavior: a `snapshot` event every poll interval (default 2s, env
// SSE_POLL_MS), a `heartbeat` comment when nothing changed, and a terminal
// `done` event followed by stream close as soon as the snapshot is settled
// (no audit queued/running) — including immediately when there is nothing
// running. Scope: 'audits:read' (API keys must hold it); team sessions pass.
import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../middleware/auth.js';
import { requireScope } from '../middleware/access.js';
import { requireSite } from '../services/sites.js';
import { collectJobsSnapshot, snapshotHash } from '../services/jobStream.js';

export function ssePollIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.SSE_POLL_MS ?? 2000);
  return Number.isFinite(v) && v >= 250 && v <= 30_000 ? v : 2000;
}

export function sseMaxDurationMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.SSE_MAX_DURATION_MS ?? 120_000);
  return Number.isFinite(v) && v > 0 ? v : 120_000;
}

export async function registerJobEventRoutes(fastify: FastifyInstance) {
  fastify.register(async (app) => {
    await authPlugin(app);
    app.get<{ Params: { id: string } }>(
      '/sites/:id/jobs/stream',
      { preHandler: requireScope('audits:read'), schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] } } },
      async (req, reply) => {
        const siteId = (req.params as { id: string }).id;
        const { tenantId } = req.tenant;
        await requireSite(tenantId, siteId);

        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        reply.raw.flushHeaders?.();
        reply.hijack();

        const pollMs = ssePollIntervalMs();
        const deadline = Date.now() + sseMaxDurationMs();
        let lastHash = '';
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          try { reply.raw.end(); } catch { /* already gone */ }
        };
        req.raw.on('close', close);

        const emit = async () => {
          if (closed) return;
          try {
            const snap = await collectJobsSnapshot(tenantId, siteId);
            const hash = snapshotHash(snap);
            if (hash !== lastHash) {
              lastHash = hash;
              reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
            } else {
              reply.raw.write(`: heartbeat ${new Date().toISOString()}\n\n`);
            }
            if (snap.settled || Date.now() >= deadline) {
              reply.raw.write(`event: done\ndata: ${JSON.stringify({ settled: snap.settled, at: new Date().toISOString() })}\n\n`);
              close();
            }
          } catch (err) {
            reply.raw.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
            close();
          }
        };
        const timer = setInterval(emit, pollMs);
        await emit();
      },
    );
  });
}
