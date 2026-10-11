import type { FastifyInstance } from 'fastify';
import { requireScope } from '../middleware/access.js';
import { authPlugin } from '../middleware/auth.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { query } from '../db.js';
import { badRequest, validationError } from '../errors.js';
import { requireSite } from '../services/sites.js';
import { enqueue, QUEUES, Jobs } from '../queues.js';
import { rescoreToxicLinks, TOXIC_THRESHOLD } from '../services/toxicLinks.js';
import { findLinkOpportunities, buildDisavowFile } from '../services/linkOpportunities.js';

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

const MAX_CSV_ROWS = 5000;
const MAX_CSV_BYTES = 2_000_000;

export interface ParsedBacklink {
  sourceUrl: string;
  targetUrl: string;
}

/**
 * Parses a backlink CSV into {sourceUrl, targetUrl} pairs.
 * Accepted shapes (header row optional, comma or semicolon separated):
 *   source_url,target_url
 *   https://blog.example/a, https://mysite.com/page
 * A single-column CSV is treated as a list of source URLs linking to the
 * site's homepage path '/' (matches the GSC "Top linking sites" export,
 * which lists domains — we normalize them to https://domain/).
 */
export function parseBacklinkCsv(csv: string, siteDomain: string): ParsedBacklink[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out: ParsedBacklink[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (out.length >= MAX_CSV_ROWS) break;
    const cells = line.split(/[,;]\s*/).map((c) => c.trim().replace(/^"|"$/g, ''));
    const looksHeader = /source|target|link|url|domain|site/i.test(cells[0] ?? '');
    if (looksHeader && out.length === 0) continue; // skip header row
    let source = cells[0] ?? '';
    let target = cells[1] ?? '';
    if (!source) continue;
    // bare domain -> https://domain/
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) source = `https://${source}`;
    if (target && !/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) target = `https://${target}`;
    let sourceUrl: string;
    try {
      const u = new URL(source);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      sourceUrl = u.toString();
    } catch {
      continue;
    }
    let targetUrl: string;
    if (target) {
      try {
        const u = new URL(target);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        targetUrl = u.toString();
      } catch {
        continue;
      }
    } else {
      targetUrl = `https://${siteDomain}/`;
    }
    const key = `${sourceUrl}|${targetUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sourceUrl, targetUrl });
  }
  return out;
}

export async function registerBacklinkRoutes(fastify: FastifyInstance) {
  // Encapsulated child: the auth hook below must cover only this
  // file's routes. Calling fastify.register(authPlugin) directly on the
  // /api/v1 instance would put the preHandler hook on the whole API
  // scope (incl. public /auth/* and /billing/webhook) — see P0-01.
  await fastify.register(async (app) => {
    await authPlugin(app);

    app.get('/sites/:id/backlinks', { preHandler: requireScope('backlinks:read'),
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['active', 'lost'] },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          },
        },
      },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const { status, page = 1, limit = 50 } = req.query as { status?: 'active' | 'lost'; page?: number; limit?: number };
      const site = await requireSite(req.tenant.tenantId, id);

      const params: unknown[] = [site.id, site.tenant_id];
      let where = `WHERE site_id = $1 AND tenant_id = $2`;
      if (status) {
        params.push(status);
        where += ` AND status = $3`;
      }
      const totalR = await query(`SELECT COUNT(*)::int AS c FROM backlinks ${where}`, params);
      params.push(limit, (page - 1) * limit);
      const r = await query(
        `SELECT id, source_url, target_url, first_seen, last_seen, status
         FROM backlinks ${where}
         ORDER BY last_seen DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      return { data: r.rows, page, limit, total: Number(totalR.rows[0].c) };
    });

    app.post('/sites/:id/backlinks/refresh', {
      schema: { params: idParams },
      preHandler: requireVerifiedEmail, // S-01: provider-backed refresh
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      await enqueue(
        QUEUES.crawl,
        Jobs.BACKLINK_REFRESH,
        { siteId: site.id, tenantId: site.tenant_id },
        { idempotencyKey: `bl:${site.id}:${new Date().toISOString().slice(0, 10)}` },
      );
      return { ok: true, queued: true };
    });

    // Upload backlinks as CSV (e.g. exported from Google Search Console UI:
    // Links -> Top linking pages -> Export). This is the v1 data source for
    // backlinks because the GSC API exposes no links endpoint.
    app.post('/sites/:id/backlinks/upload', {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['csv'],
          properties: { csv: { type: 'string', minLength: 1, maxLength: MAX_CSV_BYTES } },
        },
      },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const { csv } = req.body as { csv: string };
      const links = parseBacklinkCsv(csv, site.domain);
      if (links.length === 0) {
        throw validationError(
          'No valid links found in the CSV. Expected rows like: https://blog.example/post, https://yoursite.com/page (or a single column of linking page URLs).',
        );
      }
      const tenantId = req.tenant.tenantId;
      for (const link of links) {
        await query(
          `INSERT INTO backlinks (id, tenant_id, site_id, source_url, target_url)
           VALUES (gen_random_uuid(), $1, $2, $3, $4)
           ON CONFLICT (site_id, source_url, target_url)
           DO UPDATE SET last_seen = CURRENT_DATE, status = 'active'`,
          [tenantId, site.id, link.sourceUrl, link.targetUrl],
        );
      }
      // F-06: score every imported link with the heuristic so the UI can
      // show toxic flags immediately.
      const rescored = await rescoreToxicLinks(tenantId, site.id, site.domain, query);
      return { ok: true, imported: links.length, toxic: rescored.toxic, toxic_heuristic: true };
    });

    // ---- F-06: backlinks v2 ----

    // Anchor-text distribution.
    app.get('/sites/:id/backlinks/anchors', { preHandler: requireScope('backlinks:read'), schema: { params: idParams } }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const r = await query(
        `SELECT COALESCE(NULLIF(anchor_text, ''), '(no anchor text)') AS anchor, COUNT(*)::int AS links
         FROM backlinks
         WHERE site_id = $1 AND tenant_id = $2 AND status = 'active'
         GROUP BY 1 ORDER BY links DESC LIMIT 50`,
        [site.id, site.tenant_id],
      );
      return { anchors: r.rows, toxic_heuristic: true };
    });

    // Heuristic toxic-link list (labeled — never a penalty verdict).
    app.get('/sites/:id/backlinks/toxic', { preHandler: requireScope('backlinks:read'),
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          properties: {
            minScore: { type: 'integer', minimum: 0, maximum: 100, default: TOXIC_THRESHOLD },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const { minScore = TOXIC_THRESHOLD, limit = 50 } = req.query as { minScore?: number; limit?: number };
      const site = await requireSite(req.tenant.tenantId, id);
      const r = await query(
        `SELECT id, source_url, target_url, anchor_text, toxic_flags, toxic_score, referring_domain, last_seen
         FROM backlinks
         WHERE site_id = $1 AND tenant_id = $2 AND status = 'active' AND toxic_score >= $3
         ORDER BY toxic_score DESC LIMIT $4`,
        [site.id, site.tenant_id, minScore, limit],
      );
      return {
        links: r.rows,
        total: r.rows.length,
        threshold: TOXIC_THRESHOLD,
        heuristic: true,
        note: 'Flags are heuristics, not a measured penalty risk. Review before disavowing.',
      };
    });

    // Re-score all active links (e.g. after the heuristic is improved).
    app.post('/sites/:id/backlinks/rescore', {
      schema: { params: idParams },
      preHandler: requireVerifiedEmail,
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const result = await rescoreToxicLinks(site.tenant_id, site.id, site.domain, query);
      return { ...result, toxic_heuristic: true };
    });

    // Link-opportunity finder.
    app.get('/sites/:id/backlinks/opportunities', { preHandler: requireScope('backlinks:read'), schema: { params: idParams } }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const r = await query(
        `SELECT id, source_url, source_domain, kind, reason, created_at FROM link_opportunities
         WHERE site_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT 100`,
        [site.id, site.tenant_id],
      );
      return { opportunities: r.rows, total: r.rows.length, heuristic: true };
    });

    app.post('/sites/:id/backlinks/opportunities/refresh', {
      schema: { params: idParams },
      preHandler: requireVerifiedEmail,
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const opportunities = await findLinkOpportunities(site.tenant_id, site.id, query);
      return { opportunities, total: opportunities.length, heuristic: true };
    });

    // Disavow file download (.txt) for heuristic-toxic links.
    app.get('/sites/:id/backlinks/disavow', { preHandler: requireScope('backlinks:read'),
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          properties: { minScore: { type: 'integer', minimum: 0, maximum: 100, default: TOXIC_THRESHOLD } },
        },
      },
    }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const { minScore = TOXIC_THRESHOLD } = req.query as { minScore?: number };
      const site = await requireSite(req.tenant.tenantId, id);
      const r = await query(
        `SELECT source_url, toxic_score FROM backlinks
         WHERE site_id = $1 AND tenant_id = $2 AND status = 'active' AND toxic_score >= $3`,
        [site.id, site.tenant_id, minScore],
      );
      const txt = buildDisavowFile(r.rows as Array<{ source_url: string; toxic_score: number }>);
      return reply
        .type('text/plain; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="disavow-${site.domain}.txt"`)
        .send(txt);
    });
  });
}