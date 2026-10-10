import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../middleware/auth.js';
import { query as defaultQuery } from '../db.js';
import { notFound } from '../errors.js';
import { requireSite } from '../services/sites.js';
import { enqueue, QUEUES, Jobs } from '../queues.js';

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

export function registerRankRoutes(fastify: FastifyInstance) {
  fastify.register(async (app) => {
    await app.register(authPlugin);

    // Latest rank per tracked keyword + previous position + 30-point sparkline.
    app.get<{ Params: { id: string } }>(
      '/sites/:id/ranks',
      { schema: { params: siteParams } },
      async (req) => {
        const { tenantId } = req.tenant;
        const siteId = req.params.id;
        await requireSite(tenantId, siteId);

        const latest = (
          await defaultQuery(
            `SELECT k.id AS keyword_id, k.keyword, rc.position, rc.url, rc.checked_at, rc.serp_features
             FROM keywords k
             LEFT JOIN LATERAL (
               SELECT position, url, checked_at, serp_features FROM rank_checks
               WHERE keyword_id = k.id AND tenant_id = $2
               ORDER BY checked_at DESC LIMIT 1
             ) rc ON TRUE
             WHERE k.site_id = $1 AND k.tenant_id = $2 AND k.tracked = TRUE
             ORDER BY k.keyword`,
            [siteId, tenantId],
          )
        ).rows;

        const prevRows = (
          await defaultQuery(
            `SELECT k.id AS keyword_id,
                    (SELECT position FROM rank_checks
                     WHERE keyword_id = k.id AND tenant_id = $2
                       AND checked_at < date_trunc('day', now())
                     ORDER BY checked_at DESC LIMIT 1) AS prev_position
             FROM keywords k
             WHERE k.site_id = $1 AND k.tenant_id = $2 AND k.tracked = TRUE`,
            [siteId, tenantId],
          )
        ).rows;
        const prevMap = new Map<string, number | null>(
          prevRows.map((r: any) => [r.keyword_id as string, r.prev_position as number | null]),
        );

        const sparkRows = (
          await defaultQuery(
            `SELECT keyword_id, t, p FROM (
               SELECT rc.keyword_id, rc.checked_at AS t, rc.position AS p,
                      ROW_NUMBER() OVER (PARTITION BY rc.keyword_id ORDER BY rc.checked_at DESC) AS rn
               FROM rank_checks rc
               JOIN keywords k ON k.id = rc.keyword_id
               WHERE k.site_id = $1 AND k.tenant_id = $2 AND k.tracked = TRUE AND rc.tenant_id = $2
             ) s WHERE rn <= 30 ORDER BY keyword_id, t ASC`,
            [siteId, tenantId],
          )
        ).rows;
        const sparkMap = new Map<string, Array<number | null>>();
        for (const r of sparkRows as Array<{ keyword_id: string; t: string; p: number | null }>) {
          const list = sparkMap.get(r.keyword_id) ?? [];
          list.push(r.p);
          sparkMap.set(r.keyword_id, list);
        }

        return {
          data: latest.map((r: any) => ({
            keyword_id: r.keyword_id,
            keyword: r.keyword,
            position: r.position ?? null,
            url: r.url ?? null,
            checked_at: r.checked_at ?? null,
            prev_position: prevMap.get(r.keyword_id) ?? null,
            spark: sparkMap.get(r.keyword_id) ?? [],
            serp_features: r.serp_features ?? [],
          })),
        };
      },
    );

    // Rank history for one keyword, newest first (max 500 rows).
    app.get<{ Params: { kwId: string }; Querystring: { days?: string } }>(
      '/keywords/:kwId/history',
      {
        schema: {
          params: kwParams,
          querystring: {
            type: 'object',
            properties: { days: { type: 'string', pattern: '^[0-9]+$' } },
          },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const kwId = req.params.kwId;
        const kw = await defaultQuery(`SELECT id, keyword FROM keywords WHERE id = $1 AND tenant_id = $2`, [
          kwId,
          tenantId,
        ]);
        if (kw.rows.length === 0) throw notFound('Keyword');
        const days = Math.min(365, Math.max(1, parseInt(req.query.days ?? '90', 10) || 90));
        const r = await defaultQuery(
          `SELECT id, position, url, serp_features, checked_at FROM rank_checks
           WHERE keyword_id = $1 AND tenant_id = $2
             AND checked_at > now() - ($3 || ' days')::interval
           ORDER BY checked_at DESC LIMIT 500`,
          [kwId, tenantId, String(days)],
        );
        return { keyword: kw.rows[0].keyword, data: r.rows };
      },
    );

    // Enqueue a rank check for all tracked keywords (idempotent per day).
    app.post<{ Params: { id: string } }>(
      '/sites/:id/ranks/refresh',
      { schema: { params: siteParams } },
      async (req) => {
        const { tenantId } = req.tenant;
        const siteId = req.params.id;
        await requireSite(tenantId, siteId);
        await enqueue(QUEUES.rankCheck, Jobs.RANK_CHECK, { siteId, tenantId }, {
          idempotencyKey: `rank:${siteId}:${new Date().toISOString().slice(0, 10)}`,
        });
        return { ok: true, queued: true };
      },
    );
  });
}
