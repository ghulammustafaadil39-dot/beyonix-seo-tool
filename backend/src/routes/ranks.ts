// Rank routes (C-05 v2): latest ranks, history, refresh, tracking config,
// SERP snapshots, visibility share, persisted alerts.
// All routes are tenant-scoped via authPlugin + requireSite/tenant_id filters.

import type { FastifyInstance } from 'fastify';
import { requireRoleOrScope, requireScope } from '../middleware/access.js';
import { authPlugin } from '../middleware/auth.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { requireActiveSubscriptionOrTrial } from '../middleware/requireSubscription.js';
import { query as defaultQuery } from '../db.js';
import { notFound, badRequest } from '../errors.js';
import { requireSite } from '../services/sites.js';
import { enqueue, enqueueDeduped, QUEUES, Jobs } from '../queues.js';
import { positionVisibility, siteVisibilityShare, competitorPositions } from '../services/rankMetrics.js';
import { DEFAULT_TRACKING } from '../services/rankJobs.js';

/** Phase 7: rank checks always use the free DuckDuckGo provider now —
 *  positions are really measured (top 10), never mock-seeded. */
function rankDataSource(): 'mock' | 'real' {
  return 'real';
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

const DEVICE_ENUM = ['desktop', 'mobile'] as const;

const trackingBodySchema = {
  type: 'object',
  properties: {
    device: { type: 'string', enum: [...DEVICE_ENUM] },
    location_code: { type: 'integer', minimum: 1, maximum: 999999 },
    language: { type: 'string', minLength: 2, maxLength: 10, pattern: '^[a-z]{2}(-[A-Z]{2})?$' },
  },
  minProperties: 1,
  additionalProperties: false,
} as const;

const rankRowSchema = (prefix: string) => ({
  type: 'object',
  properties: {
    keyword_id: { type: 'string' },
    keyword: { type: 'string' },
    position: { type: ['integer', 'null'] },
    not_ranked: { type: 'boolean' },
    pixel_rank: { type: ['integer', 'null'] },
    url: { type: ['string', 'null'] },
    checked_at: { type: ['string', 'null'] },
    device: { type: 'string' },
    location_code: { type: 'integer' },
    language: { type: 'string' },
    prev_position: { type: ['integer', 'null'] },
    spark: { type: 'array', items: { type: ['integer', 'null'] } },
    serp_features: { type: 'array' },
  },
});

/** Shared enqueue for manual rank checks (refresh + check routes). */
async function enqueueRankCheck(tenantId: string, siteId: string) {
  // B1-M3: report dedupe honestly — a repeat click in the same day
  // must not get a fake `{queued:true}`.
  const { deduplicated } = await enqueueDeduped(
    QUEUES.rankCheck,
    Jobs.RANK_CHECK,
    { siteId, tenantId },
    `rank:${siteId}:${new Date().toISOString().slice(0, 10)}`,
  );
  return deduplicated ? { ok: true, queued: false, deduplicated: true } : { ok: true, queued: true };
}

export function registerRankRoutes(fastify: FastifyInstance) {  fastify.register(async (app) => {
    await authPlugin(app);

    // Latest rank per tracked keyword + previous position + 30-point sparkline.
    app.get<{ Params: { id: string } }>(
      '/sites/:id/ranks',
      { preHandler: requireScope('ranks:read'),
        schema: {
          params: siteParams,
          response: {
            200: {
              type: 'object',
              properties: {
                data: { type: 'array', items: rankRowSchema('r') },
                dataSource: { type: 'string', enum: ['mock', 'real'] },
              },
            },
          },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const siteId = req.params.id;
        await requireSite(tenantId, siteId);

        const latest = (
          await defaultQuery(
            `SELECT k.id AS keyword_id, k.keyword, rc.position, rc.pixel_rank, rc.url,
                    rc.checked_at, rc.device, rc.location_code, rc.language, rc.serp_features
             FROM keywords k
             LEFT JOIN LATERAL (
               SELECT position, pixel_rank, url, checked_at, device, location_code, language, serp_features
               FROM rank_checks
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
          dataSource: rankDataSource(),
          data: latest.map((r: any) => ({
            keyword_id: r.keyword_id,
            keyword: r.keyword,
            position: r.position ?? null,
            not_ranked: r.checked_at != null && r.position == null,
            pixel_rank: r.pixel_rank ?? null,
            url: r.url ?? null,
            checked_at: r.checked_at ?? null,
            device: r.device ?? DEFAULT_TRACKING.device,
            location_code: r.location_code ?? DEFAULT_TRACKING.locationCode,
            language: r.language ?? DEFAULT_TRACKING.language,
            prev_position: prevMap.get(r.keyword_id) ?? null,
            spark: sparkMap.get(r.keyword_id) ?? [],
            serp_features: r.serp_features ?? [],
          })),
        };
      },
    );

    // Visibility share for the site + per-competitor comparison (C-05/F-07).
    app.get<{ Params: { id: string } }>(
      '/sites/:id/ranks/visibility',
      { preHandler: requireScope('ranks:read'), schema: { params: siteParams } },
      async (req) => {
        const { tenantId } = req.tenant;
        const siteId = req.params.id;
        const site = await requireSite(tenantId, siteId);

        const latest = (
          await defaultQuery(
            `SELECT k.id AS keyword_id, k.keyword, rc.position, rc.snapshot_id
             FROM keywords k
             LEFT JOIN LATERAL (
               SELECT position, snapshot_id FROM rank_checks
               WHERE keyword_id = k.id AND tenant_id = $2
               ORDER BY checked_at DESC LIMIT 1
             ) rc ON TRUE
             WHERE k.site_id = $1 AND k.tenant_id = $2 AND k.tracked = TRUE`,
            [siteId, tenantId],
          )
        ).rows as Array<{ keyword_id: string; keyword: string; position: number | null; snapshot_id: string | null }>;

        const own = latest.map((r) => ({
          keywordId: r.keyword_id,
          keyword: r.keyword,
          position: r.position,
          notRanked: r.position == null,
          visibility: positionVisibility(r.position),
        }));
        const summary = siteVisibilityShare(own);

        // Competitors: position from the same snapshots (shared cache rows).
        const comps = (
          await defaultQuery(`SELECT domain FROM competitors WHERE site_id = $1 AND tenant_id = $2`, [siteId, tenantId])
        ).rows as Array<{ domain: string }>;
        const compDomains = comps.map((c) => c.domain);
        const snapIds = [...new Set(latest.map((r) => r.snapshot_id).filter(Boolean))] as string[];
        const compPositions: Record<string, Array<number | null>> = {};
        for (const d of compDomains) compPositions[d] = [];
        if (snapIds.length > 0 && compDomains.length > 0) {
          const snaps = (
            await defaultQuery(`SELECT id, items FROM serp_snapshots WHERE id = ANY($1)`, [snapIds])
          ).rows as Array<{ id: string; items: Array<{ position: number; domain: string }> }>;
          const byId = new Map(snaps.map((s) => [s.id, s.items ?? []]));
          for (const r of latest) {
            if (!r.snapshot_id) continue;
            const items = byId.get(r.snapshot_id) ?? [];
            const pos = competitorPositions(items, compDomains);
            for (const d of compDomains) compPositions[d].push(pos[d]);
          }
        }
        const competitors = compDomains.map((d) => {
          const positions = compPositions[d];
          const rows = positions.map((p, i) => ({
            keywordId: latest[i]?.keyword_id ?? '',
            keyword: latest[i]?.keyword ?? '',
            position: p,
            notRanked: p === null,
            visibility: positionVisibility(p),
          }));
          return { domain: d, ...siteVisibilityShare(rows) };
        });

        return {
          dataSource: rankDataSource(),
          site: { domain: site.domain, ...summary },
          competitors,
          keywords: own,
        };
      },
    );

    // Persisted position-change alerts for a site (newest first).
    app.get<{ Params: { id: string }; Querystring: { limit?: number } }>(
      '/sites/:id/ranks/alerts',
      { preHandler: requireScope('ranks:read'),
        schema: {
          params: siteParams,
          querystring: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } } },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const siteId = req.params.id;
        await requireSite(tenantId, siteId);
        const limit = req.query.limit ?? 20;
        const r = await defaultQuery(
          `SELECT ra.id, ra.keyword_id, k.keyword, ra.direction, ra.prev_position, ra.position, ra.delta, ra.reason, ra.created_at
           FROM rank_alerts ra
           JOIN keywords k ON k.id = ra.keyword_id
           WHERE ra.site_id = $1 AND ra.tenant_id = $2
           ORDER BY ra.created_at DESC LIMIT $3`,
          [siteId, tenantId, limit],
        );
        return { data: r.rows };
      },
    );

    // Rank history for one keyword, newest first (max 500 rows).
    app.get<{ Params: { kwId: string }; Querystring: { days?: string } }>(
      '/keywords/:kwId/history',
      { preHandler: requireScope('ranks:read'),
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
          `SELECT id, position, pixel_rank, url, serp_features, device, location_code, language, checked_at
           FROM rank_checks
           WHERE keyword_id = $1 AND tenant_id = $2
             AND checked_at > now() - ($3 || ' days')::interval
           ORDER BY checked_at DESC LIMIT 500`,
          [kwId, tenantId, String(days)],
        );
        return {
          keyword: kw.rows[0].keyword,
          dataSource: rankDataSource(),
          data: r.rows.map((row: any) => ({ ...row, not_ranked: row.position == null })),
        };
      },
    );

    // Latest full SERP snapshot for a keyword (top-100 items + features).
    app.get<{ Params: { kwId: string } }>(
      '/keywords/:kwId/snapshot',
      { preHandler: requireScope('ranks:read'), schema: { params: kwParams } },
      async (req) => {
        const { tenantId } = req.tenant;
        const kwId = req.params.kwId;
        const kw = await defaultQuery(`SELECT id, keyword FROM keywords WHERE id = $1 AND tenant_id = $2`, [
          kwId,
          tenantId,
        ]);
        if (kw.rows.length === 0) throw notFound('Keyword');
        const r = await defaultQuery(
          `SELECT s.id, s.keyword, s.location_code, s.device, s.language, s.fetched_at, s.items, s.features,
                  rc.position AS own_position, rc.url AS own_url, rc.pixel_rank
           FROM rank_checks rc
           JOIN serp_snapshots s ON s.id = rc.snapshot_id
           WHERE rc.keyword_id = $1 AND rc.tenant_id = $2
           ORDER BY rc.checked_at DESC LIMIT 1`,
          [kwId, tenantId],
        );
        if (r.rows.length === 0) throw notFound('SERP snapshot');
        const s = r.rows[0];
        return {
          keyword: kw.rows[0].keyword,
          dataSource: rankDataSource(),
          snapshot: {
            id: s.id,
            location_code: s.location_code,
            device: s.device,
            language: s.language,
            fetched_at: s.fetched_at,
            features: s.features ?? [],
            own_position: s.own_position ?? null,
            not_ranked: s.own_position == null,
            own_url: s.own_url ?? null,
            pixel_rank: s.pixel_rank ?? null,
            items: s.items ?? [],
          },
        };
      },
    );

    // Per-keyword tracking config: device / location / language (C-05).
    app.patch<{ Params: { kwId: string }; Body: { device?: string; location_code?: number; language?: string } }>(
      '/keywords/:kwId/tracking',
      {
        schema: { params: kwParams, body: trackingBodySchema },
        // A1-H2: tracking config is a mutation — editor+ / ranks:write.
        preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'ranks:write'),
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const kwId = req.params.kwId;
        const kw = await defaultQuery(`SELECT id FROM keywords WHERE id = $1 AND tenant_id = $2`, [kwId, tenantId]);
        if (kw.rows.length === 0) throw notFound('Keyword');
        const body = req.body;
        if (body.location_code !== undefined && !Number.isInteger(body.location_code)) {
          throw badRequest('location_code must be an integer');
        }
        // Update-first (partial), insert-with-defaults when absent.
        const sets: string[] = [];
        const params: unknown[] = [];
        if (body.device !== undefined) { params.push(body.device); sets.push(`device = $${params.length}`); }
        if (body.location_code !== undefined) { params.push(body.location_code); sets.push(`location_code = $${params.length}`); }
        if (body.language !== undefined) { params.push(body.language); sets.push(`language = $${params.length}`); }
        params.push(kwId);
        const upd = await defaultQuery(
          `UPDATE rank_tracking_configs SET ${sets.join(', ')}
           WHERE keyword_id = $${params.length} RETURNING *`,
          params,
        );
        const row = upd.rows[0] ?? (
          await defaultQuery(
            `INSERT INTO rank_tracking_configs (keyword_id, device, location_code, language)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [
              kwId,
              body.device ?? DEFAULT_TRACKING.device,
              body.location_code ?? DEFAULT_TRACKING.locationCode,
              body.language ?? DEFAULT_TRACKING.language,
            ],
          )
        ).rows[0];
        return { tracking: row };
      },
    );

    // Enqueue a rank check for all tracked keywords (idempotent per day).
    app.post<{ Params: { id: string } }>(
      '/sites/:id/ranks/refresh',
      {
        schema: { params: siteParams },
        // A1-H2: refresh spends rank-check resources — editor+ / ranks:write.
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'ranks:write')],
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const siteId = req.params.id;
        await requireSite(tenantId, siteId);
        return enqueueRankCheck(tenantId, siteId);
      },
    );

    // Phase 7: manual rank check trigger (bodyless POST — same as refresh).
    // Exists so the frontend "Check rankings now" button has a dedicated,
    // clearly-named endpoint; behavior is identical to /refresh.
    app.post<{ Params: { id: string } }>(
      '/sites/:id/ranks/check',
      {
        // CRITICAL: no body schema — the frontend sends a bodyless POST.
        schema: { params: siteParams },
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'ranks:write')],
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const siteId = req.params.id;
        await requireSite(tenantId, siteId);
        return enqueueRankCheck(tenantId, siteId);
      },
    );

    // Phase 7: rank history scoped to a site (for the Ranks tab chart).
    // Mirrors /keywords/:kwId/history but verifies the keyword belongs to
    // the site, so the tab never needs a keyword-scoped call.
    app.get<{ Params: { id: string }; Querystring: { keyword_id?: string; days?: string } }>(
      '/sites/:id/ranks/history',
      {
        preHandler: requireScope('ranks:read'),
        schema: {
          params: siteParams,
          querystring: {
            type: 'object',
            properties: {
              keyword_id: { type: 'string', format: 'uuid' },
              days: { type: 'string', pattern: '^[0-9]+$' },
            },
            required: ['keyword_id'],
          },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const siteId = req.params.id;
        const kwId = req.query.keyword_id as string;
        await requireSite(tenantId, siteId);
        const kw = await defaultQuery(
          `SELECT id, keyword FROM keywords WHERE id = $1 AND site_id = $2 AND tenant_id = $3`,
          [kwId, siteId, tenantId],
        );
        if (kw.rows.length === 0) throw notFound('Keyword');
        const days = Math.min(365, Math.max(1, parseInt(req.query.days ?? '90', 10) || 90));
        const r = await defaultQuery(
          `SELECT id, position, pixel_rank, url, serp_features, device, location_code, language, checked_at
           FROM rank_checks
           WHERE keyword_id = $1 AND tenant_id = $2
             AND checked_at > now() - ($3 || ' days')::interval
           ORDER BY checked_at DESC LIMIT 500`,
          [kwId, tenantId, String(days)],
        );
        return {
          keyword: kw.rows[0].keyword,
          dataSource: rankDataSource(),
          data: r.rows.map((row: any) => ({ ...row, not_ranked: row.position == null })),
        };
      },
    );
  });
}
