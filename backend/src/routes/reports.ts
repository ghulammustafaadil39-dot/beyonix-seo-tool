import type { FastifyInstance } from 'fastify';
import { requireRoleOrScope, requireScope } from '../middleware/access.js';
import { authPlugin } from '../middleware/auth.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { requireActiveSubscriptionOrTrial } from '../middleware/requireSubscription.js';
import { query } from '../db.js';
import { notFound } from '../errors.js';
import { requireSite } from '../services/sites.js';
import { weekStart } from '../services/reportJobs.js';
import { enqueue, enqueueDeduped, QUEUES, Jobs } from '../queues.js';
import { config } from '../config.js';
import { checkLimit } from '../metering.js';
import { generateReport, collectReportData } from '../services/reporter.js';
import {
  getBranding, renderReportHtml, renderReportPdf, compareWithPrevious,
  REPORT_SECTIONS,
} from '../services/reportBranding.js';
import {
  createShareToken, hashShareToken, verifyShareTokenFormat, deriveShareTokenKey, DEFAULT_SHARE_TTL_MS,
} from '../services/shareTokens.js';

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

    app.get('/sites/:id/reports', { preHandler: requireScope('reports:read'),
      schema: { params: idParams },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const totalR = await query(
        `SELECT COUNT(*)::int AS c FROM reports WHERE site_id = $1 AND tenant_id = $2`,
        [site.id, site.tenant_id],
      );
      const r = await query(
        `SELECT id, site_id, period_start, period_end, summary, highlights, sections, branding, created_at
         FROM reports
         WHERE site_id = $1 AND tenant_id = $2
         ORDER BY created_at DESC LIMIT 20`,
        [site.id, site.tenant_id],
      );
      return { data: r.rows, page: 1, limit: 20, total: Number(totalR.rows[0].c) };
    });

    app.get('/reports/:id', { preHandler: requireScope('reports:read'),
      schema: { params: idParams },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const r = await query(
        `SELECT id, site_id, period_start, period_end, summary, highlights, sections, branding, created_at
         FROM reports
         WHERE id = $1 AND tenant_id = $2`,
        [id, req.tenant.tenantId],
      );
      if (r.rows.length === 0) throw notFound('Report');
      return r.rows[0];
    });

    app.post('/sites/:id/reports/generate', {
      schema: { params: idParams },
      preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'reports:write')], // S-01: report generation spend
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      // B1-M3: report dedupe honestly — a repeat click in the same week
      // must not get a fake `{queued:true}`.
      const { deduplicated } = await enqueueDeduped(
        QUEUES.report,
        Jobs.WEEKLY_REPORT,
        { siteId: site.id, tenantId: site.tenant_id },
        `report:${site.id}:${weekStart()}`,
        7 * 86400,
      );
      return deduplicated ? { ok: true, queued: false, deduplicated: true } : { ok: true, queued: true };
    });

    // ---- F-08: white-label reports ----

    // Tenant branding (white-label logo + colors).
    app.get('/branding', { preHandler: requireScope('reports:read'), schema: {} }, async (req) => {
      return getBranding(req.tenant.tenantId, query);
    });

    app.put<{ Body: { company_name?: string; logo_url?: string; primary_color?: string; accent_color?: string } }>(
      '/branding',
      {
        schema: {
          body: {
            type: 'object', minProperties: 1,
            properties: {
              company_name: { type: 'string', maxLength: 120 },
              logo_url: { type: 'string', maxLength: 2000 },
              primary_color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
              accent_color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
            },
          },
        },
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'reports:write')],
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const b = req.body;
        if (b.logo_url && !/^https:\/\//.test(b.logo_url)) {
          const { badRequest } = await import('../errors.js');
          throw badRequest('logo_url must be an https URL.');
        }
        const r = await query(
          `INSERT INTO tenant_branding (tenant_id, company_name, logo_url, primary_color, accent_color, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (tenant_id) DO UPDATE SET
             company_name = COALESCE(EXCLUDED.company_name, tenant_branding.company_name),
             logo_url = COALESCE(EXCLUDED.logo_url, tenant_branding.logo_url),
             primary_color = COALESCE(EXCLUDED.primary_color, tenant_branding.primary_color),
             accent_color = COALESCE(EXCLUDED.accent_color, tenant_branding.accent_color),
             updated_at = now()
           RETURNING company_name, logo_url, primary_color, accent_color`,
          [tenantId, b.company_name ?? null, b.logo_url ?? null, b.primary_color ?? null, b.accent_color ?? null],
        );
        return r.rows[0];
      },
    );

    // Build a report synchronously with section selection (LLM summary, cost-capped).
    app.post<{ Body: { sections?: string[]; periodDays?: number } }>(
      '/sites/:id/reports/build',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            properties: {
              sections: { type: 'array', items: { type: 'string', enum: [...REPORT_SECTIONS] }, minItems: 1 },
              periodDays: { type: 'integer', minimum: 1, maximum: 90, default: 7 },
            },
          },
        },
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'reports:write')],
      },
      async (req) => {
        const { tenantId, plan } = req.tenant;
        const { id } = req.params as { id: string };
        const site = await requireSite(tenantId, id);
        const lim = await checkLimit(tenantId, plan, 'ai_words');
        if (lim.used + 400 > lim.limit) {
          const { ApiError } = await import('../errors.js');
          throw new ApiError(402, 'LIMIT_EXCEEDED',
            `AI words limit reached: ${lim.used}/${lim.limit} used this month. Upgrade to continue.`,
            { used: lim.used, limit: lim.limit, kind: 'ai_words', upgrade: true });
        }
        const sections = req.body.sections && req.body.sections.length > 0 ? req.body.sections : [...REPORT_SECTIONS];
        const periodDays = req.body.periodDays ?? 7;
        const { summary, highlights } = await generateReport(tenantId, site.id, query, { sections, periodDays });
        const branding = await getBranding(tenantId, query);
        // Idempotent per (site, period): rebuilding the same window updates the row.
        const r = await query(
          `INSERT INTO reports (id, tenant_id, site_id, period_start, period_end, summary, highlights, sections, branding)
           VALUES (gen_random_uuid(), $1, $2, CURRENT_DATE - ($3 || ' days')::interval, CURRENT_DATE, $4, $5, $6, $7)
           ON CONFLICT (site_id, period_start)
           DO UPDATE SET summary = EXCLUDED.summary, highlights = EXCLUDED.highlights,
                         sections = EXCLUDED.sections, branding = EXCLUDED.branding
           RETURNING id, site_id, period_start, period_end, summary, highlights, sections, branding, created_at`,
          [tenantId, site.id, String(periodDays), summary, JSON.stringify(highlights), sections, JSON.stringify(branding)],
        );
        return r.rows[0];
      },
    );

    async function loadReportForExport(tenantId: string, reportId: string) {
      const r = await query(
        `SELECT r.*, s.domain FROM reports r JOIN sites s ON s.id = r.site_id
         WHERE r.id = $1 AND r.tenant_id = $2`,
        [reportId, tenantId],
      );
      if (r.rows.length === 0) throw notFound('Report');
      return r.rows[0] as {
        id: string; summary: string; period_start: string; period_end: string; created_at: string;
        highlights: import('../services/reporter.js').ReportData;
        sections: string[]; branding: { company_name: string | null; logo_url: string | null; primary_color: string | null; accent_color: string | null };
        domain: string;
      };
    }

    // Branded PDF download.
    app.get('/reports/:id/pdf', { preHandler: requireScope('reports:read'), schema: { params: idParams } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const rep = await loadReportForExport(req.tenant.tenantId, id);
      const buf = await renderReportPdf({
        report: rep, siteDomain: rep.domain, highlights: rep.highlights,
        branding: rep.branding, sections: rep.sections?.length ? rep.sections : [...REPORT_SECTIONS],
      });
      return reply
        .type('application/pdf')
        .header('Content-Disposition', `attachment; filename="report-${rep.domain}.pdf"`)
        .send(buf);
    });

    // Branded HTML view.
    app.get('/reports/:id/html', { preHandler: requireScope('reports:read'), schema: { params: idParams } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const rep = await loadReportForExport(req.tenant.tenantId, id);
      const html = renderReportHtml({
        report: rep, siteDomain: rep.domain, highlights: rep.highlights,
        branding: rep.branding, sections: rep.sections?.length ? rep.sections : [...REPORT_SECTIONS],
      });
      return reply.type('text/html; charset=utf-8').send(html);
    });

    // Previous-period comparison.
    app.get('/reports/:id/compare', { preHandler: requireScope('reports:read'), schema: { params: idParams } }, async (req) => {
      const { id } = req.params as { id: string };
      const cmp = await compareWithPrevious(req.tenant.tenantId, id, query);
      if (!cmp) throw notFound('Report');
      return cmp;
    });

    // Signed share link for a report (SECURITY-SENSITIVE pattern, same as audits).
    app.post<{ Body: { expiresInDays?: number } }>(
      '/reports/:id/share',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object',
            properties: { expiresInDays: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
          },
        },
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'reports:write')],
      },
      async (req, reply) => {
        const { tenantId } = req.tenant;
        const { id } = req.params as { id: string };
        await loadReportForExport(tenantId, id);
        const days = req.body.expiresInDays ?? 30;
        const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
        const { token, tokenHash } = createShareToken(deriveShareTokenKey(config.jwtSecret));
        await query(
          `INSERT INTO share_tokens (id, tenant_id, resource_type, resource_id, token_hash, expires_at)
           VALUES (gen_random_uuid(), $1, 'report', $2, $3, to_timestamp($4))`,
          [tenantId, id, tokenHash, Math.floor(expiresAt / 1000)],
        );
        const url = `${config.appUrl}/shared/reports/${token}`;
        return reply.code(201).send({ url, token, expires_at: new Date(expiresAt).toISOString() });
      },
    );

    // List ACTIVE share links for a report (F-08 revocation support).
    // SECURITY: id/resource/timestamps ONLY — never the token or its hash.
    app.get(
      '/reports/:id/shares',
      // Keep reads open to viewer (sessions); API keys keep the pre-existing
      // reports:write scope requirement.
      { schema: { params: idParams }, preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor', 'viewer'], 'reports:write')] },
      async (req) => {
        const { tenantId } = req.tenant;
        const { id } = req.params as { id: string };
        const own = await query(`SELECT id FROM reports WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
        if (own.rows.length === 0) throw notFound('Report');
        const r = await query(
          `SELECT id, resource_type, resource_id, created_at, expires_at FROM share_tokens
           WHERE tenant_id = $1 AND resource_type = 'report' AND resource_id = $2 AND expires_at > now()
           ORDER BY created_at DESC`,
          [tenantId, id],
        );
        return { data: r.rows };
      },
    );

    // Revoke one report share link (row delete — the documented revocation
    // model; the public link 404s immediately). Tenant-scoped: another
    // tenant's token id 404s, nothing is deleted.
    app.delete(
      '/reports/:id/shares/:tokenId',
      {
        schema: {
          params: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              tokenId: { type: 'string', format: 'uuid' },
            },
            required: ['id', 'tokenId'],
          },
        },
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'reports:write')],
      },
      async (req, reply) => {
        const { tenantId } = req.tenant;
        const { id, tokenId } = req.params as { id: string; tokenId: string };
        const own = await query(`SELECT id FROM reports WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
        if (own.rows.length === 0) throw notFound('Report');
        const r = await query(
          `DELETE FROM share_tokens
           WHERE id = $1 AND tenant_id = $2 AND resource_type = 'report' AND resource_id = $3`,
          [tokenId, tenantId, id],
        );
        if ((r.rowCount ?? 0) === 0) throw notFound('Share link');
        return reply.code(204).send();
      },
    );

    // Scheduled email delivery (rows consumed by the scheduler; Backend-A owns delivery).
    app.get('/sites/:id/reports/schedule', { preHandler: requireScope('reports:read'), schema: { params: idParams } }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const r = await query(`SELECT * FROM report_schedules WHERE site_id = $1 AND tenant_id = $2`, [
        site.id, site.tenant_id,
      ]);
      return { schedule: r.rows[0] ?? null };
    });

    app.put<{ Body: { frequency?: string; recipients?: string[]; sections?: string[]; enabled?: boolean } }>(
      '/sites/:id/reports/schedule',
      {
        schema: {
          params: idParams,
          body: {
            type: 'object', minProperties: 1,
            properties: {
              frequency: { type: 'string', enum: ['weekly', 'monthly'] },
              recipients: { type: 'array', items: { type: 'string', format: 'email' }, minItems: 1, maxItems: 10 },
              sections: { type: 'array', items: { type: 'string', enum: [...REPORT_SECTIONS] } },
              enabled: { type: 'boolean' },
            },
          },
        },
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'reports:write')],
      },
      async (req) => {
        const { id } = req.params as { id: string };
        const site = await requireSite(req.tenant.tenantId, id);
        const b = req.body;
        const r = await query(
          `INSERT INTO report_schedules (id, tenant_id, site_id, frequency, recipients, sections, enabled)
           VALUES (gen_random_uuid(), $1, $2, COALESCE($3, 'weekly'), COALESCE($4::text[], '{}'), COALESCE($5::text[], '{}'), COALESCE($6, TRUE))
           ON CONFLICT (site_id) DO UPDATE SET
             frequency = COALESCE($3, report_schedules.frequency),
             recipients = CASE WHEN $4 IS NULL THEN report_schedules.recipients ELSE $4::text[] END,
             sections = CASE WHEN $5 IS NULL THEN report_schedules.sections ELSE $5::text[] END,
             enabled = COALESCE($6, report_schedules.enabled)
           RETURNING *`,
          [site.tenant_id, site.id, b.frequency ?? null, b.recipients ?? null, b.sections ?? null, b.enabled ?? null],
        );
        return { schedule: r.rows[0] };
      },
    );

    app.delete('/sites/:id/reports/schedule', {
      schema: { params: idParams },
      preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'reports:write')],
    }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      await query(`DELETE FROM report_schedules WHERE site_id = $1 AND tenant_id = $2`, [site.id, site.tenant_id]);
      return reply.code(204).send();
    });
  });

  // Public share-link resolution (NO auth — token is the credential).
  // SECURITY-SENSITIVE: HMAC-verified, same pattern as audit share links.
  await fastify.register(async (app) => {
    app.get('/shared/reports/:token', {
      schema: {
        params: { type: 'object', properties: { token: { type: 'string', minLength: 10, maxLength: 2000 } }, required: ['token'] },
      },
    }, async (req, reply) => {
      const token = (req.params as { token: string }).token;
      const tokenId = verifyShareTokenFormat(deriveShareTokenKey(config.jwtSecret), token);
      if (!tokenId) throw notFound('Share link');
      const sr = await query(
        `SELECT tenant_id, resource_id FROM share_tokens
         WHERE token_hash = $1 AND resource_type = 'report' AND expires_at > now()`,
        [hashShareToken(token)],
      );
      if (sr.rows.length === 0) throw notFound('Share link');
      const rep = await query(
        `SELECT r.summary, r.period_start, r.period_end, r.highlights, r.sections, r.branding, s.domain
         FROM reports r JOIN sites s ON s.id = r.site_id
         WHERE r.id = $1 AND r.tenant_id = $2`,
        [sr.rows[0].resource_id, sr.rows[0].tenant_id],
      );
      if (rep.rows.length === 0) throw notFound('Share link');
      const row = rep.rows[0];
      const html = renderReportHtml({
        report: row, siteDomain: row.domain, highlights: row.highlights,
        branding: row.branding ?? { company_name: null, logo_url: null, primary_color: null, accent_color: null },
        sections: row.sections?.length ? row.sections : [...REPORT_SECTIONS],
      });
      return reply.type('text/html; charset=utf-8').send(html);
    });
  });
}