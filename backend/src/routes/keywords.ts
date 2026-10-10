import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../middleware/auth.js';
import { query as defaultQuery } from '../db.js';
import { notFound } from '../errors.js';
import { requireSite } from '../services/sites.js';
import { researchKeywords, seedFromGsc } from '../services/keywordService.js';
import { checkLimit, assertLimit } from '../metering.js';

const siteParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

const kwParams = {
  type: 'object',
  properties: { kwId: { type: 'string', format: 'uuid' } },
  required: ['kwId'],
} as const;

export function registerKeywordRoutes(fastify: FastifyInstance) {
  fastify.register(async (app) => {
    await app.register(authPlugin);

    // Seed keywords: GSC queries (when connected) + metric research.
    app.post<{ Params: { id: string }; Body: { seeds: string[] } }>(
      '/sites/:id/keywords/research',
      {
        schema: {
          params: siteParams,
          body: {
            type: 'object',
            properties: {
              seeds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
            },
            required: ['seeds'],
          },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const siteId = req.params.id;
        const site = await requireSite(tenantId, siteId);
        if (site.gsc_connected) {
          try {
            await seedFromGsc(tenantId, siteId);
          } catch (err) {
            req.log.warn({ err }, 'GSC keyword seeding failed; continuing with research');
          }
        }
        const rows = await researchKeywords(tenantId, siteId, req.body.seeds);
        return { data: rows, total: rows.length };
      },
    );

    // List keywords, highest priority first. ?tracked=true|false filters.
    app.get<{ Params: { id: string }; Querystring: { tracked?: string; page?: number; limit?: number } }>(
      '/sites/:id/keywords',
      {
        schema: {
          params: siteParams,
          querystring: {
            type: 'object',
            properties: {
              tracked: { type: 'string', enum: ['true', 'false'] },
              page: { type: 'integer', minimum: 1, default: 1 },
              limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            },
          },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const siteId = req.params.id;
        await requireSite(tenantId, siteId);
        const tracked = req.query.tracked;
        const page = req.query.page ?? 1;
        const limit = req.query.limit ?? 50;
        const trackedSql =
          tracked === 'true' ? ' AND tracked = TRUE' : tracked === 'false' ? ' AND tracked = FALSE' : '';
        const where = `WHERE site_id = $1 AND tenant_id = $2${trackedSql}`;
        const totalR = await defaultQuery(`SELECT COUNT(*)::int AS c FROM keywords ${where}`, [siteId, tenantId]);
        const r = await defaultQuery(
          `SELECT * FROM keywords ${where}
           ORDER BY priority_score DESC NULLS LAST
           LIMIT $3 OFFSET $4`,
          [siteId, tenantId, limit, (page - 1) * limit],
        );
        return { data: r.rows, page, limit, total: Number(totalR.rows[0].c) };
      },
    );

    // Start tracking a keyword (plan limit enforced).
    app.post<{ Params: { kwId: string } }>(
      '/keywords/:kwId/track',
      { schema: { params: kwParams } },
      async (req) => {
        const { tenantId, plan } = req.tenant;
        const kwId = req.params.kwId;
        const existing = await defaultQuery(
          `SELECT id FROM keywords WHERE id = $1 AND tenant_id = $2`,
          [kwId, tenantId],
        );
        if (existing.rows.length === 0) throw notFound('Keyword');
        assertLimit(await checkLimit(tenantId, plan, 'keywords_tracked'));
        const r = await defaultQuery(
          `UPDATE keywords SET tracked = TRUE WHERE id = $1 AND tenant_id = $2 RETURNING *`,
          [kwId, tenantId],
        );
        return { keyword: r.rows[0] };
      },
    );

    // Stop tracking a keyword.
    app.post<{ Params: { kwId: string } }>(
      '/keywords/:kwId/untrack',
      { schema: { params: kwParams } },
      async (req) => {
        const { tenantId } = req.tenant;
        const kwId = req.params.kwId;
        const r = await defaultQuery(
          `UPDATE keywords SET tracked = FALSE WHERE id = $1 AND tenant_id = $2 RETURNING *`,
          [kwId, tenantId],
        );
        if (r.rows.length === 0) throw notFound('Keyword');
        return { keyword: r.rows[0] };
      },
    );

    // Delete a keyword (and its rank history).
    app.delete<{ Params: { kwId: string } }>(
      '/keywords/:kwId',
      { schema: { params: kwParams } },
      async (req) => {
        const { tenantId } = req.tenant;
        const kwId = req.params.kwId;
        const existing = await defaultQuery(
          `SELECT id FROM keywords WHERE id = $1 AND tenant_id = $2`,
          [kwId, tenantId],
        );
        if (existing.rows.length === 0) throw notFound('Keyword');
        await defaultQuery(`DELETE FROM rank_checks WHERE keyword_id = $1 AND tenant_id = $2`, [kwId, tenantId]);
        await defaultQuery(`DELETE FROM keywords WHERE id = $1 AND tenant_id = $2`, [kwId, tenantId]);
        return { deleted: true };
      },
    );
  });
}
