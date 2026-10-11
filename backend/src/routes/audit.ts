// Audit routes (P2): trigger/list audits, read issues, triage issues.
// All routes are tenant-scoped via authPlugin + requireSite/tenant_id filters.

import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../middleware/auth.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { requireSite } from '../services/sites.js';
import { enqueue, QUEUES, Jobs } from '../queues.js';
import { query } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { ApiError } from '../errors.js';
import { checkLimit } from '../metering.js';
import { getPlan } from '../plans.js';

/** ISO week key used for crawl idempotency: `YYYY-Www` (e.g. `2026-W41`). */
export function isoWeekKey(d: Date = new Date()): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // shift to Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / 604800000);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const uuidParams = (name: string) => ({
  type: 'object',
  properties: { [name]: { type: 'string', format: 'uuid' } },
  required: [name],
});

export function registerAuditRoutes(fastify: FastifyInstance) {
  return fastify.register(async function auditScoped(app: FastifyInstance) {
    await authPlugin(app);

    // Trigger a new full-site audit (enqueues a crawl job). 409 if one is active.
    app.post('/sites/:id/audits', {
      schema: { params: uuidParams('id'), body: { type: 'object', properties: {} } },
      preHandler: requireVerifiedEmail, // S-01: crawls cost provider budget
    }, async (req, reply) => {
      const { tenantId, plan } = req.tenant;
      const siteId = (req.params as { id: string }).id;
      await requireSite(tenantId, siteId);

      // Monthly crawl-page budget pre-flight (the worker re-checks at runtime).
      const crawlLim = await checkLimit(tenantId, plan, 'crawl_pages');
      const crawlEstimate = getPlan(plan).crawl_pages;
      if (crawlLim.used + crawlEstimate > crawlLim.limit) {
        throw new ApiError(
          402,
          'LIMIT_EXCEEDED',
          `Monthly crawl budget reached: ${crawlLim.used}/${crawlLim.limit} pages used. Upgrade to continue.`,
          { used: crawlLim.used, limit: crawlLim.limit, kind: 'crawl_pages', upgrade: true },
        );
      }

      const existing = await query(
        `SELECT id FROM audits
         WHERE site_id = $1 AND tenant_id = $2 AND status IN ('queued','running')
         LIMIT 1`,
        [siteId, tenantId],
      );
      if (existing.rows.length > 0) {
        throw conflict('AUDIT_RUNNING', 'An audit is already queued or running for this site.');
      }

      const ins = await query(
        `INSERT INTO audits (id, tenant_id, site_id, status, started_at)
         VALUES (gen_random_uuid(), $1, $2, 'queued', now())
         RETURNING *`,
        [tenantId, siteId],
      );
      const audit = ins.rows[0];

      await enqueue(
        QUEUES.crawl,
        Jobs.CRAWL_SITE,
        { siteId, tenantId, auditId: audit.id },
        { idempotencyKey: `crawl:${siteId}:${isoWeekKey()}` },
      );

      return reply.code(201).send({ audit });
    });

    // List audits for a site, newest first.
    app.get('/sites/:id/audits', {
      schema: { params: uuidParams('id') },
    }, async (req) => {
      const { tenantId } = req.tenant;
      const siteId = (req.params as { id: string }).id;
      await requireSite(tenantId, siteId);

      const rows = await query(
        `SELECT id, tenant_id, site_id, status, started_at, finished_at, score,
                issues_count, pages_crawled, LEFT(error, 300) AS error
         FROM audits
         WHERE site_id = $1 AND tenant_id = $2
         ORDER BY started_at DESC NULLS LAST
         LIMIT 20`,
        [siteId, tenantId],
      );
      const total = await query(
        `SELECT COUNT(*)::int AS c FROM audits WHERE site_id = $1 AND tenant_id = $2`,
        [siteId, tenantId],
      );
      return { data: rows.rows, page: 1, limit: 20, total: Number(total.rows[0].c) };
    });

    // Get one audit (tenant-scoped). The raw worker error is truncated to
    // avoid leaking provider internals; full text stays in server logs.
    app.get('/audits/:auditId', {
      schema: { params: uuidParams('auditId') },
    }, async (req) => {
      const { tenantId } = req.tenant;
      const auditId = (req.params as { auditId: string }).auditId;
      const r = await query(
        `SELECT id, tenant_id, site_id, status, started_at, finished_at, score,
                issues_count, pages_crawled,
                LEFT(error, 300) AS error
         FROM audits WHERE id = $1 AND tenant_id = $2`,
        [auditId, tenantId],
      );
      if (r.rows.length === 0) throw notFound('Audit');
      return { audit: r.rows[0] };
    });

    // Paginated issues for an audit, with severity/status filters.
    app.get('/audits/:auditId/issues', {
      schema: {
        params: uuidParams('auditId'),
        querystring: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['info', 'warning', 'error'] },
            status: { type: 'string', enum: ['open', 'fixed', 'ignored'] },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
        },
      },
    }, async (req) => {
      const { tenantId } = req.tenant;
      const auditId = (req.params as { auditId: string }).auditId;
      const own = await query(`SELECT id FROM audits WHERE id = $1 AND tenant_id = $2`, [auditId, tenantId]);
      if (own.rows.length === 0) throw notFound('Audit');

      const qs = req.query as {
        severity?: 'info' | 'warning' | 'error';
        status?: 'open' | 'fixed' | 'ignored';
        page?: number;
        limit?: number;
      };
      const page = qs.page ?? 1;
      const limit = qs.limit ?? 50;

      const filters = ['audit_id = $1', 'tenant_id = $2'];
      const params: unknown[] = [auditId, tenantId];
      if (qs.severity) {
        params.push(qs.severity);
        filters.push(`severity = $${params.length}`);
      }
      if (qs.status) {
        params.push(qs.status);
        filters.push(`status = $${params.length}`);
      }
      const where = `WHERE ${filters.join(' AND ')}`;

      const total = await query(`SELECT COUNT(*)::int AS c FROM audit_issues ${where}`, params);
      const data = await query(
        `SELECT * FROM audit_issues ${where}
         ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, type
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, (page - 1) * limit],
      );
      return { data: data.rows, page, limit, total: Number(total.rows[0].c) };
    });

    // Triage an issue: open | fixed | ignored.
    app.patch('/issues/:issueId', {
      schema: {
        params: uuidParams('issueId'),
        body: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['open', 'fixed', 'ignored'] } },
          required: ['status'],
          additionalProperties: false,
        },
      },
    }, async (req) => {
      const { tenantId } = req.tenant;
      const issueId = (req.params as { issueId: string }).issueId;
      const status = (req.body as { status: 'open' | 'fixed' | 'ignored' }).status;
      const upd = await query(
        `UPDATE audit_issues SET status = $3 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [issueId, tenantId, status],
      );
      if (upd.rows.length === 0) throw notFound('Issue');
      return { issue: upd.rows[0] };
    });
  });
}
