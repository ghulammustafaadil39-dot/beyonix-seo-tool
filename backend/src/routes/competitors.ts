// Competitor analysis (F-07): competitors CRUD per site, visibility
// comparison, keyword gaps, content gaps, and backlink comparison.
// All gap/visibility data is derived from the tenant's own rank-tracking
// snapshots — no competitor backlink provider is wired, so backlink
// comparison honestly reports what we have (own data) vs. unavailable.

import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../middleware/auth.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { requireActiveSubscriptionOrTrial } from '../middleware/requireSubscription.js';
import { requireRoleOrScope, requireScope } from '../middleware/access.js';
import { query } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { requireSite } from '../services/sites.js';
import { positionVisibility, competitorPositions } from '../services/rankMetrics.js';
import { discoverCompetitors, competitorGaps } from '../services/competitorDiscovery.js';

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

const competitorIdParams = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    competitorId: { type: 'string', format: 'uuid' },
  },
  required: ['id', 'competitorId'],
} as const;

function validDomain(d: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d.trim()) && d.trim().length <= 253;
}

async function listCompetitorDomains(tenantId: string, siteId: string): Promise<string[]> {
  const r = await query(`SELECT domain FROM competitors WHERE site_id = $1 AND tenant_id = $2 ORDER BY domain`, [
    siteId, tenantId,
  ]);
  return r.rows.map((row: { domain: string }) => row.domain);
}

interface SnapshotItem {
  position: number;
  domain: string;
}

/**
 * C1-M-8: batch-fetch snapshot items for many keywords in ONE query.
 * The old code issued one `SELECT items FROM serp_snapshots WHERE id = $1`
 * per keyword (N+1) — a 1,000-keyword site fired ~1,000 sequential DB
 * round-trips and could time out behind the route budget.
 */
async function snapshotItemsById(snapshotIds: Array<string | null>): Promise<Map<string, SnapshotItem[]>> {
  const uniq = [...new Set(snapshotIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const out = new Map<string, SnapshotItem[]>();
  if (uniq.length === 0) return out;
  const r = await query(`SELECT id, items FROM serp_snapshots WHERE id = ANY($1)`, [uniq]);
  for (const row of r.rows as Array<{ id: string; items: unknown }>) {
    out.set(row.id, Array.isArray(row.items) ? (row.items as SnapshotItem[]) : []);
  }
  return out;
}

export async function registerCompetitorRoutes(fastify: FastifyInstance) {
  // Encapsulated child: the auth hook below must cover only this
  // file's routes. Calling fastify.register(authPlugin) directly on the
  // /api/v1 instance would put the preHandler hook on the whole API
  // scope (incl. public /auth/* and /billing/webhook) — see P0-01.
  await fastify.register(async (app) => {
    await authPlugin(app);

    // ---- CRUD ----

    // B1-M1: reads need competitors:read for API keys (session users pass through).
    app.get('/sites/:id/competitors', { schema: { params: idParams }, preHandler: requireScope('competitors:read') }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const r = await query(
        `SELECT id, domain, label, discovery_source, overlap_score, shared_keywords, avg_position, last_discovered_at, created_at
         FROM competitors
         WHERE site_id = $1 AND tenant_id = $2
         ORDER BY overlap_score DESC NULLS LAST, domain`,
        [site.id, site.tenant_id],
      );
      return { competitors: r.rows, total: r.rows.length };
    });

    app.post<{ Body: { domain: string; label?: string } }>('/sites/:id/competitors', {
      schema: {
        params: idParams,
        body: {
          type: 'object', required: ['domain'],
          properties: {
            domain: { type: 'string', minLength: 3, maxLength: 253 },
            label: { type: 'string', maxLength: 100 },
          },
        },
      },
      // A1-H2: competitor CRUD is a mutation — editor+ (sessions) /
      // competitors:write (API keys). Previously only requireVerifiedEmail.
      preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'competitors:write')],
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const domain = req.body.domain.trim().toLowerCase().replace(/^www\./, '');
      if (!validDomain(domain)) throw badRequest('Invalid domain.');
      if (domain === site.domain.toLowerCase()) throw badRequest('A site cannot compete with itself.');
      try {
        const r = await query(
          `INSERT INTO competitors (tenant_id, site_id, domain, label)
           VALUES ($1, $2, $3, $4) RETURNING id, domain, label, created_at`,
          [site.tenant_id, site.id, domain, req.body.label?.trim() || null],
        );
        return r.rows[0];
      } catch (err) {
        if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
          throw badRequest('This competitor is already tracked.');
        }
        throw err;
      }
    });

    app.delete('/sites/:id/competitors/:competitorId', {
      schema: { params: competitorIdParams },
      // A1-H2: competitor CRUD is a mutation — editor+ / competitors:write.
      preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'competitors:write')],
    }, async (req, reply) => {
      const { id, competitorId } = req.params as { id: string; competitorId: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const r = await query(
        `DELETE FROM competitors WHERE id = $1 AND site_id = $2 AND tenant_id = $3`,
        [competitorId, site.id, site.tenant_id],
      );
      if (r.rowCount === 0) throw notFound('Competitor');
      return reply.code(204).send();
    });

    // ---- Auto-discovery (Phase 3) ----
    // Free SERP overlap via DuckDuckGo — no paid APIs. Bodyless POST:
    // no body schema on purpose (bodyless POST + body schema = 400).

    app.post('/sites/:id/competitors/discover', {
      schema: { params: idParams },
      preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'competitors:write')],
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const result = await discoverCompetitors(site.tenant_id, site.id);
      if (result.keywordsChecked === 0) {
        return {
          ...result,
          note: 'No keywords to base discovery on. Add or approve keywords first (Keywords tab).',
        };
      }
      return result;
    });

    // Gap analysis for one competitor: keywords where the competitor ranks
    // top-10 on free SERP but the site is missing or clearly behind.
    app.get('/sites/:id/competitors/:competitorId/gaps', {
      schema: { params: competitorIdParams },
      preHandler: requireScope('competitors:read'),
    }, async (req) => {
      const { id, competitorId } = req.params as { id: string; competitorId: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const compR = await query(
        `SELECT domain FROM competitors WHERE id = $1 AND site_id = $2 AND tenant_id = $3`,
        [competitorId, site.id, site.tenant_id],
      );
      if (compR.rows.length === 0) throw notFound('Competitor');
      const domain = compR.rows[0].domain as string;
      const result = await competitorGaps(site.tenant_id, site.id, domain);
      return { competitor: domain, ...result };
    });

    // ---- Visibility comparison ----

    app.get('/sites/:id/competitors/compare', { schema: { params: idParams }, preHandler: requireScope('competitors:read') }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const compDomains = await listCompetitorDomains(site.tenant_id, site.id);

      // Latest position per tracked keyword + its snapshot items.
      const rows = (
        await query(
          `SELECT DISTINCT ON (rc.keyword_id)
                  k.keyword, k.volume, rc.position, rc.snapshot_id
           FROM rank_checks rc
           JOIN keywords k ON k.id = rc.keyword_id
           WHERE k.site_id = $1 AND rc.tenant_id = $2
           ORDER BY rc.keyword_id, rc.checked_at DESC`,
          [site.id, site.tenant_id],
        )
      ).rows as Array<{ keyword: string; volume: number | null; position: number | null; snapshot_id: string | null }>;

      const keywordRows: Array<{
        keyword: string; volume: number | null; sitePosition: number | null;
        competitors: Record<string, number | null>;
      }> = [];
      const visTotals: Record<string, { vis: number; n: number }> = {};
      const bump = (domain: string, position: number | null): void => {
        const t = visTotals[domain] ?? { vis: 0, n: 0 };
        t.vis += positionVisibility(position);
        t.n++;
        visTotals[domain] = t;
      };

      // C1-M-8: one batched snapshot fetch for all keywords (was N+1).
      const snapshots = await snapshotItemsById(rows.map((r) => r.snapshot_id));
      for (const row of rows) {
        const items = row.snapshot_id ? (snapshots.get(row.snapshot_id) ?? []) : [];
        const compPos = competitorPositions(items, compDomains);
        keywordRows.push({
          keyword: row.keyword, volume: row.volume, sitePosition: row.position, competitors: compPos,
        });
        bump(site.domain, row.position);
        for (const d of compDomains) bump(d, compPos[d] ?? null);
      }

      const summary = Object.entries(visTotals).map(([domain, t]) => ({
        domain,
        keywords: t.n,
        visibilitySharePct: t.n === 0 ? 0 : Math.round((t.vis / t.n) * 100) / 100,
      }));
      summary.sort((a, b) => b.visibilitySharePct - a.visibilitySharePct);

      return { site: site.domain, competitors: compDomains, keywords: keywordRows, summary };
    });

    // ---- Keyword gaps ----

    app.get('/sites/:id/competitors/keyword-gaps', {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        },
      },
      preHandler: requireScope('competitors:read'),
    }, async (req) => {
      const { id } = req.params as { id: string };
      const { limit = 50 } = req.query as { limit?: number };
      const site = await requireSite(req.tenant.tenantId, id);
      const compDomains = await listCompetitorDomains(site.tenant_id, site.id);
      if (compDomains.length === 0) return { gaps: [], total: 0, note: 'Add competitors first.' };

      const rows = (
        await query(
          `SELECT DISTINCT ON (rc.keyword_id)
                  k.keyword, k.volume, rc.position, rc.snapshot_id
           FROM rank_checks rc
           JOIN keywords k ON k.id = rc.keyword_id
           WHERE k.site_id = $1 AND rc.tenant_id = $2
           ORDER BY rc.keyword_id, rc.checked_at DESC`,
          [site.id, site.tenant_id],
        )
      ).rows as Array<{ keyword: string; volume: number | null; position: number | null; snapshot_id: string | null }>;

      const gaps: Array<{
        keyword: string; volume: number | null; sitePosition: number | null;
        competitor: string; competitorPosition: number;
      }> = [];
      // C1-M-8: one batched snapshot fetch for all keywords (was N+1).
      const snapshots = await snapshotItemsById(rows.map((r) => r.snapshot_id));
      for (const row of rows) {
        if (!row.snapshot_id) continue;
        const items = snapshots.get(row.snapshot_id);
        if (!items) continue;
        const compPos = competitorPositions(items, compDomains);
        for (const d of compDomains) {
          const cp = compPos[d];
          if (cp !== null && cp <= 10 && (row.position === null || row.position > cp + 10)) {
            gaps.push({
              keyword: row.keyword, volume: row.volume, sitePosition: row.position,
              competitor: d, competitorPosition: cp,
            });
            break; // one row per keyword (strongest competitor)
          }
        }
      }
      gaps.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
      return { gaps: gaps.slice(0, limit), total: gaps.length };
    });

    // ---- Content gaps ----

    app.get('/sites/:id/competitors/content-gaps', {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        },
      },
      preHandler: requireScope('competitors:read'),
    }, async (req) => {
      const { id } = req.params as { id: string };
      const { limit = 50 } = req.query as { limit?: number };
      const site = await requireSite(req.tenant.tenantId, id);

      // Keywords where a competitor ranks top-10 but no content piece targets them.
      const rows = (
        await query(
          `SELECT DISTINCT ON (rc.keyword_id)
                  k.id AS keyword_id, k.keyword, k.volume, rc.snapshot_id
           FROM rank_checks rc
           JOIN keywords k ON k.id = rc.keyword_id
           WHERE k.site_id = $1 AND rc.tenant_id = $2
           ORDER BY rc.keyword_id, rc.checked_at DESC`,
          [site.id, site.tenant_id],
        )
      ).rows as Array<{ keyword_id: string; keyword: string; volume: number | null; snapshot_id: string | null }>;
      const compDomains = await listCompetitorDomains(site.tenant_id, site.id);

      const covered = new Set<string>(
        (await query(`SELECT keyword_id FROM content_pieces WHERE site_id = $1 AND tenant_id = $2 AND keyword_id IS NOT NULL`, [
          site.id, site.tenant_id,
        ])).rows.map((r: { keyword_id: string }) => r.keyword_id),
      );

      const gaps: Array<{ keyword: string; volume: number | null; competitor: string; competitorPosition: number; suggestion: string }> = [];
      // C1-M-8: one batched snapshot fetch for all keywords (was N+1).
      const snapshots = await snapshotItemsById(rows.map((r) => r.snapshot_id));
      for (const row of rows) {
        if (covered.has(row.keyword_id) || !row.snapshot_id) continue;
        const items = snapshots.get(row.snapshot_id);
        if (!items) continue;
        const compPos = competitorPositions(items, compDomains);
        for (const d of compDomains) {
          const cp = compPos[d];
          if (cp !== null && cp <= 10) {
            gaps.push({
              keyword: row.keyword, volume: row.volume, competitor: d, competitorPosition: cp,
              suggestion: `No content targets "${row.keyword}" yet — ${d} ranks #${cp}. Create a brief → outline → draft piece for this keyword.`,
            });
            break;
          }
        }
      }
      gaps.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
      return { gaps: gaps.slice(0, limit), total: gaps.length };
    });

    // ---- Backlink comparison (honest: own data only) ----

    app.get('/sites/:id/competitors/backlinks', { schema: { params: idParams }, preHandler: requireScope('competitors:read') }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const compDomains = await listCompetitorDomains(site.tenant_id, site.id);
      const own = await query(
        `SELECT COUNT(*)::int AS links, COUNT(DISTINCT referring_domain)::int AS referring_domains
         FROM backlinks WHERE site_id = $1 AND tenant_id = $2 AND status = 'active'`,
        [site.id, site.tenant_id],
      );
      return {
        site: {
          domain: site.domain,
          links: Number(own.rows[0]?.links ?? 0),
          referringDomains: Number(own.rows[0]?.referring_domains ?? 0),
        },
        competitors: compDomains.map((d) => ({
          domain: d, links: null, referringDomains: null, data: 'unavailable' as const,
        })),
        note: 'Competitor backlink counts need a backlinks provider (e.g. DataForSEO backlinks API), which is not wired yet. Own counts come from your GSC CSV uploads.',
      };
    });
  });
}
