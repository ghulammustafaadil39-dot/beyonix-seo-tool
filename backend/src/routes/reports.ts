import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../middleware/auth.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { query } from '../db.js';
import { notFound } from '../errors.js';
import { requireSite } from '../services/sites.js';
import { weekStart } from '../services/reportJobs.js';
import { enqueue, QUEUES, Jobs } from '../queues.js';

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

export async function registerReportRoutes(fastify: FastifyInstance) {
  // Encapsulated child: the auth hook below must cover only this
  // file's routes. Calling fastify.register(authPlugin) directly on the
  // /api/v1 instance would put the preHandler hook on the whole API
  // scope (incl. public /auth/* and /billing/webhook) — see P0-01.
  await fastify.register(async (app) => {
    await authPlugin(app);

    app.get('/sites/:id/reports', {
      schema: { params: idParams },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const totalR = await query(
        `SELECT COUNT(*)::int AS c FROM reports WHERE site_id = $1 AND tenant_id = $2`,
        [site.id, site.tenant_id],
      );
      const r = await query(
        `SELECT id, site_id, period_start, period_end, summary, highlights, created_at
         FROM reports
         WHERE site_id = $1 AND tenant_id = $2
         ORDER BY created_at DESC LIMIT 20`,
        [site.id, site.tenant_id],
      );
      return { data: r.rows, page: 1, limit: 20, total: Number(totalR.rows[0].c) };
    });

    app.get('/reports/:id', {
      schema: { params: idParams },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const r = await query(
        `SELECT id, site_id, period_start, period_end, summary, highlights, created_at
         FROM reports
         WHERE id = $1 AND tenant_id = $2`,
        [id, req.tenant.tenantId],
      );
      if (r.rows.length === 0) throw notFound('Report');
      return r.rows[0];
    });

    app.post('/sites/:id/reports/generate', {
      schema: { params: idParams },
      preHandler: requireVerifiedEmail, // S-01: report generation spend
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      await enqueue(
        QUEUES.report,
        Jobs.WEEKLY_REPORT,
        { siteId: site.id, tenantId: site.tenant_id },
        { idempotencyKey: `report:${site.id}:${weekStart()}` },
      );
      return { ok: true, queued: true };
    });
  });
}