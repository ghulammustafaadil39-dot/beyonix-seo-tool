import type { FastifyInstance } from 'fastify';
import { requireScope } from '../middleware/access.js';
import { authPlugin } from '../middleware/auth.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { expensiveTenantLimit } from '../middleware/rateLimit.js';
import { query as defaultQuery } from '../db.js';
import { notFound } from '../errors.js';
import { requireSite } from '../services/sites.js';
import {
  researchKeywords, seedFromGsc, expandKeywords, clusterRows,
  detectCannibalization, keywordGap, importKeywords,
} from '../services/keywordService.js';
import { isQuestionKeyword, keywordsToCsv } from '../services/keywordText.js';
import { checkLimit, assertLimit } from '../metering.js';
import { getKeywordSerpProvider } from '../providers/dataforseo.js';

/** BUG-QA-W2-4: honest source label, same convention as the gap endpoint. */
function keywordDataSource(): 'mock' | 'real' {
  return getKeywordSerpProvider().isMock ? 'mock' : 'real';
}

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
    await authPlugin(app);

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
        preHandler: [requireVerifiedEmail, expensiveTenantLimit(), requireScope('keywords:write')], // S-01: DataForSEO spend; S-03: per-tenant budget
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
        return { data: rows, total: rows.length, dataSource: keywordDataSource() };
      },
    );

    // List keywords, highest priority first. ?tracked=true|false filters.
    app.get<{ Params: { id: string }; Querystring: { tracked?: string; page?: number; limit?: number } }>(
      '/sites/:id/keywords',
      { preHandler: requireScope('keywords:read'),
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
      { preHandler: requireScope('keywords:write'), schema: { params: kwParams } },
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
      { preHandler: requireScope('keywords:write'), schema: { params: kwParams } },
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

    // ---- F-03: keyword research v2 ----

    // Seed expansion: deterministic long-tail/question variants + metrics.
    app.post<{ Params: { id: string }; Body: { seeds: string[] } }>(
      '/sites/:id/keywords/expand',
      {
        schema: {
          params: siteParams,
          body: {
            type: 'object',
            properties: {
              seeds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, minItems: 1, maxItems: 5 },
            },
            required: ['seeds'],
          },
        },
        preHandler: [requireVerifiedEmail, expensiveTenantLimit(), requireScope('keywords:write')], // S-01: DataForSEO spend
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const rows = await expandKeywords(tenantId, req.params.id, req.body.seeds);
        return { data: rows, total: rows.length, dataSource: keywordDataSource() };
      },
    );

    // Clustering by topic (group_key) + intent mix.
    app.get<{ Params: { id: string } }>(
      '/sites/:id/keywords/clusters',
      { preHandler: requireScope('keywords:read'), schema: { params: siteParams } },
      async (req) => {
        const { tenantId } = req.tenant;
        const siteId = req.params.id;
        await requireSite(tenantId, siteId);
        const r = await defaultQuery(
          `SELECT keyword, group_key, intent, volume, difficulty FROM keywords
           WHERE site_id = $1 AND tenant_id = $2 ORDER BY keyword`,
          [siteId, tenantId],
        );
        return { data: clusterRows(r.rows as any[]) };
      },
    );

    // Question keywords (what/how/why/...).
    app.get<{ Params: { id: string } }>(
      '/sites/:id/keywords/questions',
      { preHandler: requireScope('keywords:read'), schema: { params: siteParams } },
      async (req) => {
        const { tenantId } = req.tenant;
        const siteId = req.params.id;
        await requireSite(tenantId, siteId);
        const r = await defaultQuery(
          `SELECT * FROM keywords WHERE site_id = $1 AND tenant_id = $2 ORDER BY priority_score DESC NULLS LAST`,
          [siteId, tenantId],
        );
        const questions = (r.rows as any[]).filter((k) => isQuestionKeyword(k.keyword));
        return { data: questions, total: questions.length };
      },
    );

    // Cannibalization detection.
    app.get<{ Params: { id: string } }>(
      '/sites/:id/keywords/cannibalization',
      { preHandler: requireScope('keywords:read'), schema: { params: siteParams } },
      async (req) => {
        const { tenantId } = req.tenant;
        const hits = await detectCannibalization(tenantId, req.params.id);
        return { data: hits, total: hits.length };
      },
    );

    // Keyword gap vs a competitor (cached 7d; data_source honestly labeled).
    app.get<{ Params: { id: string }; Querystring: { competitor: string } }>(
      '/sites/:id/keywords/gap',
      {
        schema: {
          params: siteParams,
          querystring: {
            type: 'object',
            properties: { competitor: { type: 'string', minLength: 3, maxLength: 253 } },
            required: ['competitor'],
          },
        },
        preHandler: [requireVerifiedEmail, expensiveTenantLimit(), requireScope('keywords:read')],
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const res = await keywordGap(tenantId, req.params.id, req.query.competitor);
        return res;
      },
    );

    // Keyword lists: create.
    app.post<{ Params: { id: string }; Body: { name: string; tags?: string[] } }>(
      '/sites/:id/keyword-lists',
      { preHandler: requireScope('keywords:write'),
        schema: {
          params: siteParams,
          body: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 100 },
              tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 }, maxItems: 20 },
            },
          },
        },
      },
      async (req, reply) => {
        const { tenantId } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);
        const name = req.body.name.trim();
        const tags = [...new Set((req.body.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
        const r = await defaultQuery(
          `INSERT INTO keyword_lists (id, tenant_id, site_id, name, tags)
           VALUES (gen_random_uuid(), $1, $2, $3, $4)
           ON CONFLICT (site_id, name) DO NOTHING
           RETURNING *`,
          [tenantId, site.id, name, tags],
        );
        if (r.rows.length === 0) {
          const existing = await defaultQuery(
            `SELECT * FROM keyword_lists WHERE site_id = $1 AND tenant_id = $2 AND name = $3`,
            [site.id, tenantId, name],
          );
          return reply.code(200).send({ list: existing.rows[0], existed: true });
        }
        return reply.code(201).send({ list: r.rows[0] });
      },
    );

    // Keyword lists: list with member counts.
    app.get<{ Params: { id: string } }>(
      '/sites/:id/keyword-lists',
      { preHandler: requireScope('keywords:read'), schema: { params: siteParams } },
      async (req) => {
        const { tenantId } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);
        const r = await defaultQuery(
          `SELECT l.*, (SELECT COUNT(*)::int FROM keyword_list_members m WHERE m.list_id = l.id) AS members
           FROM keyword_lists l WHERE l.site_id = $1 AND l.tenant_id = $2 ORDER BY l.created_at DESC`,
          [site.id, tenantId],
        );
        return { data: r.rows };
      },
    );

    const listParams = {
      type: 'object',
      properties: { listId: { type: 'string', format: 'uuid' } },
      required: ['listId'],
    } as const;

    async function requireList(tenantId: string, listId: string) {
      const r = await defaultQuery(`SELECT * FROM keyword_lists WHERE id = $1 AND tenant_id = $2`, [listId, tenantId]);
      if (r.rows.length === 0) throw notFound('Keyword list');
      return r.rows[0];
    }

    // Keyword lists: rename / retag.
    app.patch<{ Params: { listId: string }; Body: { name?: string; tags?: string[] } }>(
      '/keyword-lists/:listId',
      { preHandler: requireScope('keywords:write'),
        schema: {
          params: listParams,
          body: {
            type: 'object',
            minProperties: 1,
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 100 },
              tags: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 40 }, maxItems: 20 },
            },
          },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const list = await requireList(tenantId, req.params.listId);
        const sets: string[] = [];
        const params: unknown[] = [];
        if (req.body.name !== undefined) { params.push(req.body.name.trim()); sets.push(`name = $${params.length}`); }
        if (req.body.tags !== undefined) {
          params.push([...new Set(req.body.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]);
          sets.push(`tags = $${params.length}`);
        }
        params.push(list.id, tenantId);
        const r = await defaultQuery(
          `UPDATE keyword_lists SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND tenant_id = $${params.length} RETURNING *`,
          params,
        );
        return { list: r.rows[0] };
      },
    );

    // Keyword lists: delete.
    app.delete<{ Params: { listId: string } }>(
      '/keyword-lists/:listId',
      { preHandler: requireScope('keywords:write'), schema: { params: listParams } },
      async (req) => {
        const { tenantId } = req.tenant;
        await requireList(tenantId, req.params.listId);
        await defaultQuery(`DELETE FROM keyword_lists WHERE id = $1 AND tenant_id = $2`, [req.params.listId, tenantId]);
        return { deleted: true };
      },
    );

    // Keyword lists: add members.
    app.post<{ Params: { listId: string }; Body: { keywordIds: string[] } }>(
      '/keyword-lists/:listId/keywords',
      { preHandler: requireScope('keywords:write'),
        schema: {
          params: listParams,
          body: {
            type: 'object',
            required: ['keywordIds'],
            properties: { keywordIds: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, maxItems: 500 } },
          },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const list = await requireList(tenantId, req.params.listId);
        let added = 0;
        for (const kwId of req.body.keywordIds) {
          const kw = await defaultQuery(`SELECT id FROM keywords WHERE id = $1 AND tenant_id = $2`, [kwId, tenantId]);
          if (kw.rows.length === 0) continue;
          const r = await defaultQuery(
            `INSERT INTO keyword_list_members (id, tenant_id, list_id, keyword_id)
             VALUES (gen_random_uuid(), $1, $2, $3) ON CONFLICT (list_id, keyword_id) DO NOTHING RETURNING id`,
            [tenantId, list.id, kwId],
          );
          if (r.rows.length > 0) added++;
        }
        return { added };
      },
    );

    // Keyword lists: remove a member.
    app.delete<{ Params: { listId: string; kwId: string } }>(
      '/keyword-lists/:listId/keywords/:kwId',
      { preHandler: requireScope('keywords:write'),
        schema: {
          params: {
            type: 'object',
            properties: { listId: { type: 'string', format: 'uuid' }, kwId: { type: 'string', format: 'uuid' } },
            required: ['listId', 'kwId'],
          },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const list = await requireList(tenantId, req.params.listId);
        await defaultQuery(
          `DELETE FROM keyword_list_members WHERE list_id = $1 AND keyword_id = $2 AND tenant_id = $3`,
          [list.id, req.params.kwId, tenantId],
        );
        return { deleted: true };
      },
    );

    // Keyword lists: members.
    app.get<{ Params: { listId: string } }>(
      '/keyword-lists/:listId/keywords',
      { preHandler: requireScope('keywords:read'), schema: { params: listParams } },
      async (req) => {
        const { tenantId } = req.tenant;
        const list = await requireList(tenantId, req.params.listId);
        const r = await defaultQuery(
          `SELECT k.* FROM keywords k JOIN keyword_list_members m ON m.keyword_id = k.id
           WHERE m.list_id = $1 AND m.tenant_id = $2 ORDER BY k.priority_score DESC NULLS LAST`,
          [list.id, tenantId],
        );
        return { data: r.rows, total: r.rows.length };
      },
    );

    // Bulk import keywords from CSV/text.
    app.post<{ Params: { id: string }; Body: { csv: string } }>(
      '/sites/:id/keywords/import',
      {
        schema: {
          params: siteParams,
          body: {
            type: 'object',
            required: ['csv'],
            properties: { csv: { type: 'string', minLength: 1, maxLength: 500_000 } },
          },
        },
        preHandler: [requireVerifiedEmail, expensiveTenantLimit(), requireScope('keywords:write')],
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const res = await importKeywords(tenantId, req.params.id, req.body.csv);
        return { ...res, dataSource: keywordDataSource() };
      },
    );

    // Export keywords as CSV (download).
    app.get<{ Params: { id: string } }>(
      '/sites/:id/keywords/export',
      { preHandler: requireScope('keywords:read'), schema: { params: siteParams } },
      async (req, reply) => {
        const { tenantId } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);
        const r = await defaultQuery(
          `SELECT keyword, volume, difficulty, intent FROM keywords
           WHERE site_id = $1 AND tenant_id = $2 ORDER BY priority_score DESC NULLS LAST`,
          [site.id, tenantId],
        );
        return reply
          .type('text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="keywords-${site.domain}.csv"`)
          .send(keywordsToCsv(r.rows as any[]));
      },
    );

    // Delete a keyword (and its rank history).
    app.delete<{ Params: { kwId: string } }>(
      '/keywords/:kwId',
      { preHandler: requireScope('keywords:write'), schema: { params: kwParams } },
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
