// Audit routes (P2): trigger/list audits, read issues, triage issues.
// All routes are tenant-scoped via authPlugin + requireSite/tenant_id filters.

import type { FastifyInstance } from 'fastify';
import { requireRoleOrScope, requireScope } from '../middleware/access.js';
import { authPlugin } from '../middleware/auth.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { requireActiveSubscriptionOrTrial } from '../middleware/requireSubscription.js';
import { requireSite } from '../services/sites.js';
import { enqueue, QUEUES, Jobs } from '../queues.js';
import { pool, query } from '../db.js';
import { conflict, notFound } from '../errors.js';
import { ApiError } from '../errors.js';
import { checkLimit } from '../metering.js';
import { getPlan } from '../plans.js';
import { config } from '../config.js';
import { createShareToken, hashShareToken, verifyShareTokenFormat, deriveShareTokenKey } from '../services/shareTokens.js';
import { createPdf, drawCover, drawSectionTitle, drawKeyValues, drawIssues } from '../services/pdf.js';
import { getBranding } from '../services/branding.js';
// B1-8: the local isoWeekKey copy mixed local date getters into Date.UTC()
// (the N-A2-2 bug class); the canonical UTC-only implementation lives in
// weekKey.ts — one copy, shared with the scheduler.
import { isoWeek } from '../weekKey.js';
/** Backwards-compatible alias for the old local name (used by p2 tests). */
export const isoWeekKey = isoWeek;

const uuidParams = (name: string) => ({
  type: 'object',
  properties: { [name]: { type: 'string', format: 'uuid' } },
  required: [name],
});

interface ExportIssue {
  type: string;
  severity: string;
  url: string;
  detail: string;
  fix_suggestion: string;
  impact: number;
  status: string;
}

/** CSV export of audit issues (F-02). */
export function issuesToCsv(issues: ExportIssue[]): string {
  const esc = (v: string | number): string => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = ['type,severity,impact,status,url,detail,fix_suggestion'];
  for (const i of issues) {
    lines.push(
      [esc(i.type), esc(i.severity), esc(i.impact), esc(i.status), esc(i.url), esc(i.detail), esc(i.fix_suggestion)].join(','),
    );
  }
  return lines.join('\n');
}

export async function registerAuditRoutes(fastify: FastifyInstance) {
  await fastify.register(async function auditScoped(app: FastifyInstance) {
    await authPlugin(app);

    // Trigger a new full-site audit (enqueues a crawl job). 409 if one is active.
    app.post('/sites/:id/audits', {
      schema: { params: uuidParams('id'), body: { type: 'object', properties: {} } },
      // A1-H2: audit triggers are a mutation — editor+ roles for sessions,
      // 'audits:write' scope for API keys. S-01: crawls cost provider budget.
      preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'audits:write')],
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

      // A1-H1: the active-audit check + INSERT run in ONE transaction. The
      // site row is locked FOR UPDATE so concurrent double-submits
      // serialize, and the partial unique index audits_one_active_per_site
      // (migration 041) makes the INSERT the final arbiter — a loser that
      // raced past the SELECT still gets 23505, translated to 409 below,
      // instead of leaving a permanent orphan 'queued' row.
      const client = await pool.connect();
      let audit: any;
      try {
        await client.query('BEGIN');
        try {
          await client.query('SELECT id FROM sites WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [
            siteId,
            tenantId,
          ]);
          const existing = await client.query(
            `SELECT id FROM audits
             WHERE site_id = $1 AND tenant_id = $2 AND status IN ('queued','running')
             LIMIT 1`,
            [siteId, tenantId],
          );
          if (existing.rows.length > 0) {
            throw conflict('AUDIT_RUNNING', 'An audit is already queued or running for this site.');
          }
          const ins = await client.query(
            `INSERT INTO audits (id, tenant_id, site_id, status, started_at)
             VALUES (gen_random_uuid(), $1, $2, 'queued', now())
             RETURNING *`,
            [tenantId, siteId],
          );
          audit = ins.rows[0];
          await client.query('COMMIT');
        } catch (err) {
          try {
            await client.query('ROLLBACK');
          } catch {
            /* already rolled back */
          }
          throw err;
        }
      } catch (err: any) {
        // Lost the race past the SELECT: the partial unique index fired.
        // Same outcome as the fast-path check above — 409, not 500.
        if (err?.code === '23505') {
          throw conflict('AUDIT_RUNNING', 'An audit is already queued or running for this site.');
        }
        throw err;
      } finally {
        client.release();
      }

      // A1-H1: enqueue() can throw AFTER the row exists (Redis down, tenant
      // enqueue rate limit) — mark the row 'failed' instead of leaving a
      // permanent orphan 'queued' row that would 409 all future audits.
      // SEC-REVIEW (Wave-4): the jobId MUST be unique per audit row. BullMQ
      // silently dedupes on duplicate jobId (returns the existing job, no
      // error), so a week-scoped key like crawl:<site>:<week> would orphan
      // any second audit created in the same week: the new 'queued' row
      // would never be processed and all future audits would 409 forever.
      // Uniqueness per audit row closes that window; the active-audit
      // rule itself is enforced by the route + partial unique index above.
      // NOTE: BullMQ rejects a colon-containing custom jobId unless it
      // splits into exactly 3 parts — hence the crawl:<auditId>:<week>
      // shape (unique per audit, still 3 parts).
      try {
        await enqueue(
          QUEUES.crawl,
          Jobs.CRAWL_SITE,
          { siteId, tenantId, auditId: audit.id },
          { idempotencyKey: `crawl:${audit.id}:${isoWeekKey()}` },
        );
      } catch (err: any) {
        const message = `enqueue failed: ${err?.message ?? String(err)}`.slice(0, 1000);
        await query(
          `UPDATE audits SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`,
          [audit.id, message],
        );
        throw err;
      }

      return reply.code(201).send({ audit });
    });

    // List audits for a site, newest first.
    app.get('/sites/:id/audits', { preHandler: requireScope('audits:read'),
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
    app.get('/audits/:auditId', { preHandler: requireScope('audits:read'),
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
    // F-02: sort=impact (default, impact-based prioritization) or severity.
    app.get('/audits/:auditId/issues', { preHandler: requireScope('audits:read'),
      schema: {
        params: uuidParams('auditId'),
        querystring: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['info', 'warning', 'error'] },
            status: { type: 'string', enum: ['open', 'ignored', 'resolved', 'wont-fix'] },
            sort: { type: 'string', enum: ['impact', 'severity'], default: 'impact' },
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
        status?: 'open' | 'ignored' | 'resolved' | 'wont-fix';
        sort?: 'impact' | 'severity';
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
      const order =
        (qs.sort ?? 'impact') === 'impact'
          ? 'ORDER BY impact DESC, CASE severity WHEN \'error\' THEN 0 WHEN \'warning\' THEN 1 ELSE 2 END, type'
          : 'ORDER BY CASE severity WHEN \'error\' THEN 0 WHEN \'warning\' THEN 1 ELSE 2 END, impact DESC, type';

      const total = await query(`SELECT COUNT(*)::int AS c FROM audit_issues ${where}`, params);
      const data = await query(
        `SELECT * FROM audit_issues ${where}
         ${order}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, (page - 1) * limit],
      );
      return { data: data.rows, page, limit, total: Number(total.rows[0].c) };
    });

    // Triage an issue: open | fixed | ignored.
    app.patch('/issues/:issueId', { preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'audits:write'),
      schema: {
        params: uuidParams('issueId'),
        body: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['open', 'ignored', 'resolved', 'wont-fix'] } },
          required: ['status'],
          additionalProperties: false,
        },
      },
    }, async (req) => {
      const { tenantId } = req.tenant;
      const issueId = (req.params as { issueId: string }).issueId;
      const status = (req.body as { status: 'open' | 'ignored' | 'resolved' | 'wont-fix' }).status;
      const upd = await query(
        `UPDATE audit_issues SET status = $3 WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [issueId, tenantId, status],
      );
      if (upd.rows.length === 0) throw notFound('Issue');
      return { issue: upd.rows[0] };
    });

    // ---- F-02: audit v2 engine ----

    // Grouped fixes: issues rolled up by type, highest impact first.
    app.get('/audits/:auditId/groups', { preHandler: requireScope('audits:read'),
      schema: {
        params: uuidParams('auditId'),
        querystring: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['open', 'ignored', 'resolved', 'wont-fix'] } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string' },
                    severity: { type: 'string' },
                    count: { type: 'integer' },
                    total_impact: { type: 'integer' },
                    fix_suggestion: { type: 'string' },
                    urls: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    }, async (req) => {
      const { tenantId } = req.tenant;
      const auditId = (req.params as { auditId: string }).auditId;
      const own = await query(`SELECT id FROM audits WHERE id = $1 AND tenant_id = $2`, [auditId, tenantId]);
      if (own.rows.length === 0) throw notFound('Audit');
      const qs = req.query as { status?: string };
      const params: unknown[] = [auditId, tenantId];
      let where = `WHERE audit_id = $1 AND tenant_id = $2`;
      if (qs.status) {
        params.push(qs.status);
        where += ` AND status = $3`;
      }
      const r = await query(
        `SELECT type,
                (array_agg(severity ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END))[1] AS severity,
                COUNT(*)::int AS count,
                COALESCE(SUM(impact), 0)::int AS total_impact,
                (array_agg(fix_suggestion))[1] AS fix_suggestion,
                array_agg(url) AS urls
         FROM audit_issues ${where}
         GROUP BY type
         ORDER BY total_impact DESC, count DESC`,
        params,
      );
      return { data: r.rows.map((g: any) => ({ ...g, urls: (g.urls ?? []).slice(0, 20) })) };
    });

    // Change history between this crawl and the previous one.
    app.get('/audits/:auditId/diff', { preHandler: requireScope('audits:read'),
      schema: {
        params: uuidParams('auditId'),
        response: {
          200: {
            type: 'object',
            properties: {
              diff: {
                type: ['object', 'null'],
                properties: {
                  prev_audit_id: { type: ['string', 'null'] },
                  new_issues: { type: 'integer' },
                  resolved_issues: { type: 'integer' },
                  new_errors: { type: 'integer' },
                  by_type: { type: 'object' },
                  created_at: { type: 'string' },
                },
              },
            },
          },
        },
      },
    }, async (req) => {
      const { tenantId } = req.tenant;
      const auditId = (req.params as { auditId: string }).auditId;
      const own = await query(`SELECT id FROM audits WHERE id = $1 AND tenant_id = $2`, [auditId, tenantId]);
      if (own.rows.length === 0) throw notFound('Audit');
      const r = await query(
        `SELECT prev_audit_id, new_issues, resolved_issues, new_errors, by_type, created_at
         FROM audit_diffs WHERE audit_id = $1 AND tenant_id = $2`,
        [auditId, tenantId],
      );
      return { diff: r.rows[0] ?? null };
    });

    // Per-page detail: the crawled page record + its issues.
    app.get('/audits/:auditId/pages', { preHandler: requireScope('audits:read'),
      schema: {
        params: uuidParams('auditId'),
        querystring: {
          type: 'object',
          properties: {
            url: { type: 'string', maxLength: 2000 },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    }, async (req) => {
      const { tenantId } = req.tenant;
      const auditId = (req.params as { auditId: string }).auditId;
      const own = await query(`SELECT id FROM audits WHERE id = $1 AND tenant_id = $2`, [auditId, tenantId]);
      if (own.rows.length === 0) throw notFound('Audit');
      const qs = req.query as { url?: string; page?: number; limit?: number };
      if (qs.url) {
        const pr = await query(
          `SELECT * FROM audit_pages WHERE audit_id = $1 AND tenant_id = $2 AND url = $3`,
          [auditId, tenantId, qs.url],
        );
        if (pr.rows.length === 0) throw notFound('Page');
        const ir = await query(
          `SELECT * FROM audit_issues WHERE audit_id = $1 AND tenant_id = $2 AND url = $3
           ORDER BY impact DESC`,
          [auditId, tenantId, qs.url],
        );
        return { page: pr.rows[0], issues: ir.rows };
      }
      const page = qs.page ?? 1;
      const limit = qs.limit ?? 20;
      const total = await query(
        `SELECT COUNT(*)::int AS c FROM audit_pages WHERE audit_id = $1 AND tenant_id = $2`,
        [auditId, tenantId],
      );
      const pr = await query(
        `SELECT * FROM audit_pages WHERE audit_id = $1 AND tenant_id = $2
         ORDER BY inlinks DESC, url LIMIT $3 OFFSET $4`,
        [auditId, tenantId, limit, (page - 1) * limit],
      );
      return { data: pr.rows, page, limit, total: Number(total.rows[0].c) };
    });

    // Create a signed share link for an audit (SECURITY-SENSITIVE: HMAC token).
    app.post('/audits/:auditId/share', { preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'audits:write'),
      schema: {
        params: uuidParams('auditId'),
        body: {
          type: 'object',
          properties: { expiresInDays: { type: 'integer', minimum: 1, maximum: 365, default: 30 } },
        },
        response: {
          201: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              token: { type: 'string' },
              expires_at: { type: 'string' },
            },
          },
        },
      },
    }, async (req, reply) => {
      const { tenantId } = req.tenant;
      const auditId = (req.params as { auditId: string }).auditId;
      const own = await query(`SELECT id, site_id FROM audits WHERE id = $1 AND tenant_id = $2`, [auditId, tenantId]);
      if (own.rows.length === 0) throw notFound('Audit');
      const days = (req.body as { expiresInDays?: number }).expiresInDays ?? 30;
      const expiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
      const { token, tokenHash } = createShareToken(deriveShareTokenKey(config.jwtSecret));
      await query(
        `INSERT INTO share_tokens (id, tenant_id, resource_type, resource_id, token_hash, expires_at)
         VALUES (gen_random_uuid(), $1, 'audit', $2, $3, to_timestamp($4))`,
        [tenantId, auditId, tokenHash, Math.floor(expiresAt / 1000)],
      );
      const url = `${config.appUrl}/shared/audits/${token}`;
      return reply.code(201).send({ url, token, expires_at: new Date(expiresAt).toISOString() });
    });

    // List ACTIVE share links for an audit (F-02 revocation support).
    // SECURITY: returns id/resource/timestamps ONLY — never the token or
    // its hash (the hash is a bearer-equivalent lookup key).
    // Keep reads open to viewer: sessions need only the viewer role, but API
    // keys still require the audits:write scope (pre-existing contract).
    app.get('/audits/:auditId/shares', { preHandler: requireRoleOrScope(['owner', 'admin', 'editor', 'viewer'], 'audits:write'),
      schema: { params: uuidParams('auditId') },
    }, async (req) => {
      const { tenantId } = req.tenant;
      const auditId = (req.params as { auditId: string }).auditId;
      const own = await query(`SELECT id FROM audits WHERE id = $1 AND tenant_id = $2`, [auditId, tenantId]);
      if (own.rows.length === 0) throw notFound('Audit');
      const r = await query(
        `SELECT id, resource_type, resource_id, created_at, expires_at FROM share_tokens
         WHERE tenant_id = $1 AND resource_type = 'audit' AND resource_id = $2 AND expires_at > now()
         ORDER BY created_at DESC`,
        [tenantId, auditId],
      );
      return { data: r.rows };
    });

    // Revoke one share link (deletes the share_tokens row — the documented
    // revocation model; the public link 404s immediately afterwards).
    // Tenant-scoped: another tenant's token id 404s, nothing is deleted.
    app.delete('/audits/:auditId/shares/:tokenId', { preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'audits:write'),
      schema: {
        params: {
          type: 'object',
          properties: {
            auditId: { type: 'string', format: 'uuid' },
            tokenId: { type: 'string', format: 'uuid' },
          },
          required: ['auditId', 'tokenId'],
        },
      },
    }, async (req, reply) => {
      const { tenantId } = req.tenant;
      const { auditId, tokenId } = req.params as { auditId: string; tokenId: string };
      const own = await query(`SELECT id FROM audits WHERE id = $1 AND tenant_id = $2`, [auditId, tenantId]);
      if (own.rows.length === 0) throw notFound('Audit');
      const r = await query(
        `DELETE FROM share_tokens
         WHERE id = $1 AND tenant_id = $2 AND resource_type = 'audit' AND resource_id = $3`,
        [tokenId, tenantId, auditId],
      );
      if ((r.rowCount ?? 0) === 0) throw notFound('Share link');
      return reply.code(204).send();
    });

    // Export an audit as PDF (pdfkit) or CSV (download).
    app.get('/audits/:auditId/export', { preHandler: requireScope('audits:read'),
      schema: {
        params: uuidParams('auditId'),
        querystring: {
          type: 'object',
          properties: { format: { type: 'string', enum: ['pdf', 'csv'], default: 'pdf' } },
        },
      },
    }, async (req, reply) => {
      const { tenantId } = req.tenant;
      const auditId = (req.params as { auditId: string }).auditId;
      const ar = await query(
        `SELECT a.*, s.domain FROM audits a JOIN sites s ON s.id = a.site_id
         WHERE a.id = $1 AND a.tenant_id = $2`,
        [auditId, tenantId],
      );
      if (ar.rows.length === 0) throw notFound('Audit');
      const audit = ar.rows[0];
      const ir = await query(
        `SELECT type, severity, url, detail, fix_suggestion, impact, status
         FROM audit_issues WHERE audit_id = $1 AND tenant_id = $2
         ORDER BY impact DESC, CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`,
        [auditId, tenantId],
      );
      const issues = ir.rows as Array<{
        type: string; severity: string; url: string; detail: string;
        fix_suggestion: string; impact: number; status: string;
      }>;
      const format = (req.query as { format?: string }).format ?? 'pdf';
      const brand = await getBranding(tenantId);

      if (format === 'csv') {
        const csv = issuesToCsv(issues);
        return reply
          .type('text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="audit-${auditId.slice(0, 8)}.csv"`)
          .send(csv);
      }

      const doc = createPdf(`SEO Audit — ${audit.domain}`, brand);
      drawCover(doc, {
        title: `SEO Audit — ${audit.domain}`,
        subtitle: `Score ${audit.score ?? 'n/a'}/100 · ${audit.pages_crawled ?? 0} pages crawled · ${new Date(audit.finished_at ?? audit.started_at).toLocaleDateString()}`,
        branding: brand,
      });
      drawSectionTitle(doc, 'Summary', brand);
      const bySev = { error: 0, warning: 0, info: 0 };
      for (const i of issues) bySev[i.severity as keyof typeof bySev] = (bySev[i.severity as keyof typeof bySev] ?? 0) + 1;
      drawKeyValues(doc, [
        ['Health score', `${audit.score ?? 'n/a'} / 100`],
        ['Pages crawled', String(audit.pages_crawled ?? 0)],
        ['Errors', String(bySev.error)],
        ['Warnings', String(bySev.warning)],
        ['Info', String(bySev.info)],
      ]);
      drawSectionTitle(doc, 'Issues by impact', brand);
      drawIssues(doc, issues.slice(0, 200).map((i) => ({ ...i })), brand);
      doc.end();
      return reply
        .type('application/pdf')
        .header('Content-Disposition', `attachment; filename="audit-${auditId.slice(0, 8)}.pdf"`)
        .send(doc);
    });

    // Scheduled crawls per plan (scheduler hook reads sites.crawl_schedule).
    app.patch('/sites/:id/crawl-schedule', { preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'audits:write'),
      schema: {
        params: uuidParams('id'),
        body: {
          type: 'object',
          required: ['frequency'],
          properties: { frequency: { type: 'string', enum: ['weekly', 'biweekly', 'monthly', 'manual'] } },
          additionalProperties: false,
        },
      },
    }, async (req) => {
      const { tenantId } = req.tenant;
      const siteId = (req.params as { id: string }).id;
      const site = await requireSite(tenantId, siteId);
      const frequency = (req.body as { frequency: string }).frequency;
      await query(`UPDATE sites SET crawl_schedule = $3 WHERE id = $1 AND tenant_id = $2`, [
        site.id, tenantId, frequency,
      ]);
      return { ok: true, crawl_schedule: frequency };
    });
  });

  // Public share-link resolution (NO auth — token is the credential).
  // SECURITY-SENSITIVE: HMAC-verified; Security Lead review requested via LA.
  await fastify.register(async (app) => {
    app.get('/shared/audits/:token', {
      schema: {
        params: { type: 'object', properties: { token: { type: 'string', minLength: 10, maxLength: 2000 } }, required: ['token'] },
      },
    }, async (req) => {
      const token = (req.params as { token: string }).token;
      const tokenId = verifyShareTokenFormat(deriveShareTokenKey(config.jwtSecret), token);
      if (!tokenId) throw notFound('Share link');
      // Look up the share row: unguessable hash, expiry + type enforced here.
      const sr = await query(
        `SELECT tenant_id, resource_id FROM share_tokens
         WHERE token_hash = $1 AND resource_type = 'audit' AND expires_at > now()`,
        [hashShareToken(token)],
      );
      if (sr.rows.length === 0) throw notFound('Share link');
      const { tenant_id: shareTenantId, resource_id: resourceId } = sr.rows[0];
      const ar = await query(
        `SELECT a.id, a.score, a.issues_count, a.pages_crawled, a.status, a.finished_at, s.domain
         FROM audits a JOIN sites s ON s.id = a.site_id
         WHERE a.id = $1 AND a.tenant_id = $2`,
        [resourceId, shareTenantId],
      );
      if (ar.rows.length === 0) throw notFound('Share link');
      const ir = await query(
        `SELECT type, severity, url, detail, fix_suggestion, impact
         FROM audit_issues WHERE audit_id = $1 AND tenant_id = $2 AND status = 'open'
         ORDER BY impact DESC LIMIT 200`,
        [resourceId, shareTenantId],
      );
      return { audit: ar.rows[0], issues: ir.rows };
    });
  });
}
