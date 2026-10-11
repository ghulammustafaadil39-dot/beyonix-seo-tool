// Competitor analysis (F-07): competitors CRUD per site, visibility
// comparison, keyword gaps, content gaps, and backlink comparison.
// All gap/visibility data is derived from the tenant's own rank-tracking
// snapshots — no competitor backlink provider is wired, so backlink
// comparison honestly reports what we have (own data) vs. unavailable.

import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../middleware/auth.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { requireRoleOrScope } from '../middleware/access.js';
import { query } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { requireSite } from '../services/sites.js';
import { positionVisibility, competitorPositions } from '../services/rankMetrics.js';

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

export async function registerCompetitorRoutes(fastify: FastifyInstance) {
  // Encapsulated child: the auth hook below must cover only this
  // file's routes. Calling fastify.register(authPlugin) directly on the
  // /api/v1 instance would put the preHandler hook on the whole API
  // scope (incl. public /auth/* and /billing/webhook) — see P0-01.
  await fastify.register(async (app) => {
    await authPlugin(app);

    // ---- CRUD ----

    app.get('/sites/:id/competitors', { schema: { params: idParams } }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const r = await query(
        `SELECT id, domain, label, created_at FROM competitors
         WHERE site_id = $1 AND tenant_id = $2 ORDER BY domain`,
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
      preHandler: [requireVerifiedEmail, requireRoleOrScope(['owner', 'admin', 'editor'], 'competitors:write')],
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
      preHandler: [requireVerifiedEmail, requireRoleOrScope(['owner', 'admin', 'editor'], 'competitors:write')],
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

    // ---- Visibility comparison ----

    app.get('/sites/:id/competitors/compare', { schema: { params: idParams } }, async (req) => {
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

      for (const row of rows) {
        let items: Array<{ position: number; domain: string }> = [];
        if (row.snapshot_id) {
          const sr = await query(`SELECT items FROM serp_snapshots WHERE id = $1`, [row.snapshot_id]);
          const parsed = sr.rows[0]?.items as Array<{ position: number; domain: string }> | undefined;
          if (Array.isArray(parsed)) items = parsed;
        }
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
      for (const row of rows) {
        if (!row.snapshot_id) continue;
        const sr = await query(`SELECT items FROM serp_snapshots WHERE id = $1`, [row.snapshot_id]);
        const items = sr.rows[0]?.items as Array<{ position: number; domain: string }> | undefined;
        if (!Array.isArray(items)) continue;
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
      for (const row of rows) {
        if (covered.has(row.keyword_id) || !row.snapshot_id) continue;
        const sr = await query(`SELECT items FROM serp_snapshots WHERE id = $1`, [row.snapshot_id]);
        const items = sr.rows[0]?.items as Array<{ position: number; domain: string }> | undefined;
        if (!Array.isArray(items)) continue;
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

    app.get('/sites/:id/competitors/backlinks', { schema: { params: idParams } }, async (req) => {
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
