import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authPlugin } from '../middleware/auth.js';
import { requireSite } from '../services/sites.js';
import { buildGeoHtml } from '../services/contentEngine.js';
import { checkLimit, assertLimit } from '../metering.js';
import { ApiError, notFound, badRequest } from '../errors.js';
import { query as defaultQuery } from '../db.js';

// NOTE: queues.js is imported lazily inside handlers so that importing this
// module never opens a Redis connection (keeps unit tests dependency-free).

/** Pre-flight affordability check for ai_words: used + estimate must fit the plan limit. */
export function canAffordAiWords(used: number, limit: number, estimate: number): boolean {
  return used + estimate <= limit;
}

/** Filename-safe slug for content exports (no path separators/quotes). */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'content'
  );
}

const LENGTH_ESTIMATES: Record<string, number> = { short: 800, medium: 1500, long: 2500 };
const STATUSES = ['draft', 'review', 'approved'] as const;

const uuidParamSchema = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

interface SiteParams {
  id: string;
}

async function enqueueGenerateContent(pieceId: string, tenantId: string, tone: string, targetWords: number) {
  const { enqueue, QUEUES, Jobs } = await import('../queues.js');
  await enqueue(
    QUEUES.content,
    Jobs.GENERATE_CONTENT,
    { pieceId, tenantId, tone, targetWords },
    { idempotencyKey: `content:${pieceId}` },
  );
}

export async function registerContentRoutes(fastify: FastifyInstance) {
  await fastify.register(async (app) => {
    await authPlugin(app);

    // List content pieces for a site (newest first), optional ?status= filter.
    app.get<{ Params: SiteParams; Querystring: { status?: string } }>(
      '/sites/:id/content',
      {
        schema: {
          params: uuidParamSchema,
          querystring: {
            type: 'object',
            properties: { status: { type: 'string', enum: [...STATUSES] } },
          },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);
        const params: unknown[] = [site.id, tenantId];
        let sql = `SELECT * FROM content_pieces WHERE site_id = $1 AND tenant_id = $2`;
        if (req.query.status) {
          params.push(req.query.status);
          sql += ` AND status = $3`;
        }
        sql += ` ORDER BY updated_at DESC`;
        const r = await defaultQuery(sql, params);
        return { data: r.rows };
      },
    );

    // Create a piece and enqueue generation.
    app.post<{
      Params: SiteParams;
      Body: { keywordId?: string; title: string; tone?: string; length?: string };
    }>(
      '/sites/:id/content',
      {
        schema: {
          params: uuidParamSchema,
          body: {
            type: 'object',
            required: ['title'],
            properties: {
              keywordId: { type: 'string', format: 'uuid' },
              title: { type: 'string', minLength: 1, maxLength: 200 },
              tone: { type: 'string', maxLength: 80 },
              length: { type: 'string', enum: ['short', 'medium', 'long'], default: 'medium' },
            },
          },
        },
      },
      async (req: FastifyRequest<{ Params: SiteParams; Body: { keywordId?: string; title: string; tone?: string; length?: string } }>, reply: FastifyReply) => {
        const { tenantId, plan } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);

        const title = req.body.title?.trim();
        if (!title) throw badRequest('title is required');
        const tone = req.body.tone?.trim() || 'friendly professional';
        const length = req.body.length ?? 'medium';
        if (!LENGTH_ESTIMATES[length]) throw badRequest('length must be short|medium|long');
        const estimate = LENGTH_ESTIMATES[length];

        const lim = await checkLimit(tenantId, plan, 'ai_words');
        if (!canAffordAiWords(lim.used, lim.limit, estimate)) {
          throw new ApiError(
            402,
            'LIMIT_EXCEEDED',
            `AI words limit reached: ${lim.used}/${lim.limit} used this month; this piece needs ~${estimate} words. Upgrade to continue.`,
            { used: lim.used, limit: lim.limit, kind: 'ai_words', upgrade: true },
          );
        }

        if (req.body.keywordId) {
          const kr = await defaultQuery(`SELECT id FROM keywords WHERE id = $1 AND tenant_id = $2`, [
            req.body.keywordId,
            tenantId,
          ]);
          if (kr.rows.length === 0) throw notFound('Keyword');
        }

        const ins = await defaultQuery(
          `INSERT INTO content_pieces (id, tenant_id, site_id, keyword_id, title, status)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'draft')
           RETURNING *`,
          [tenantId, site.id, req.body.keywordId ?? null, title],
        );
        const piece = ins.rows[0];

        await enqueueGenerateContent(piece.id, tenantId, tone, estimate);

        return reply.code(201).send(piece);
      },
    );

    // Get one piece (tenant-scoped).
    app.get<{ Params: SiteParams }>(
      '/content/:id',
      { schema: { params: uuidParamSchema } },
      async (req) => {
        const { tenantId } = req.tenant;
        const r = await defaultQuery(`SELECT * FROM content_pieces WHERE id = $1 AND tenant_id = $2`, [
          req.params.id,
          tenantId,
        ]);
        if (r.rows.length === 0) throw notFound('Content piece');
        return r.rows[0];
      },
    );

    // Edit a piece (title/outline/draft).
    app.patch<{
      Params: SiteParams;
      Body: { title?: string; outline?: string; draft?: string };
    }>(
      '/content/:id',
      {
        schema: {
          params: uuidParamSchema,
          body: {
            type: 'object',
            minProperties: 1,
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 200 },
              outline: { type: 'string', maxLength: 200_000 },
              draft: { type: 'string', maxLength: 200_000 },
            },
          },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const field of ['title', 'outline', 'draft'] as const) {
          const v = req.body[field];
          if (v !== undefined) {
            params.push(field === 'title' ? v.trim() : v);
            sets.push(`${field} = $${params.length}`);
          }
        }
        if (sets.length === 0) throw badRequest('nothing to update');
        params.push(req.params.id, tenantId);
        const r = await defaultQuery(
          `UPDATE content_pieces SET ${sets.join(', ')}, updated_at = now()
           WHERE id = $${params.length - 1} AND tenant_id = $${params.length}
           RETURNING *`,
          params,
        );
        if (r.rows.length === 0) throw notFound('Content piece');
        return r.rows[0];
      },
    );

    // Approve a piece (moves review -> approved).
    app.post<{ Params: SiteParams }>(
      '/content/:id/approve',
      { schema: { params: uuidParamSchema } },
      async (req) => {
        const { tenantId } = req.tenant;
        const r = await defaultQuery(
          `UPDATE content_pieces SET status = 'approved', updated_at = now()
           WHERE id = $1 AND tenant_id = $2 RETURNING *`,
          [req.params.id, tenantId],
        );
        if (r.rows.length === 0) throw notFound('Content piece');
        return r.rows[0];
      },
    );

    // (Re)enqueue generation; only allowed from draft status.
    app.post<{ Params: SiteParams }>(
      '/content/:id/generate',
      { schema: { params: uuidParamSchema } },
      async (req) => {
        const { tenantId, plan } = req.tenant;
        const r = await defaultQuery(`SELECT * FROM content_pieces WHERE id = $1 AND tenant_id = $2`, [
          req.params.id,
          tenantId,
        ]);
        if (r.rows.length === 0) throw notFound('Content piece');
        const piece = r.rows[0];
        if (piece.status !== 'draft') {
          throw new ApiError(400, 'INVALID_STATUS', 'Only pieces in draft status can be (re)generated');
        }
        // Pre-flight AI budget check (same estimate the worker enforces).
        const lim = await checkLimit(tenantId, plan, 'ai_words');
        if (lim.used + 1600 > lim.limit) {
          throw new ApiError(
            402,
            'LIMIT_EXCEEDED',
            `AI words limit reached: ${lim.used}/${lim.limit} used this month. Upgrade to continue.`,
            { used: lim.used, limit: lim.limit, kind: 'ai_words', upgrade: true },
          );
        }
        await enqueueGenerateContent(piece.id, tenantId, 'friendly professional', 1200);
        return { ok: true, queued: true };
      },
    );

    // Export a piece as markdown or GEO-ready HTML (downloaded as a file).
    app.get<{ Params: SiteParams; Querystring: { format?: string } }>(
      '/content/:id/export',
      {
        schema: {
          params: uuidParamSchema,
          querystring: {
            type: 'object',
            properties: { format: { type: 'string', enum: ['html', 'markdown'], default: 'markdown' } },
          },
        },
      },
      async (req, reply) => {
        const { tenantId } = req.tenant;
        const r = await defaultQuery(`SELECT * FROM content_pieces WHERE id = $1 AND tenant_id = $2`, [
          req.params.id,
          tenantId,
        ]);
        if (r.rows.length === 0) throw notFound('Content piece');
        const piece = r.rows[0];
        const format = req.query.format ?? 'markdown';
        const slug = slugify(piece.title ?? 'content');
        if (format === 'html') {
          const html = buildGeoHtml(piece.draft ?? '', piece.title ?? '');
          return reply
            .type('text/html; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="${slug}.html"`)
            .send(html);
        }
        const md = `# ${piece.title ?? ''}\n\n${piece.outline ?? ''}\n\n${piece.draft ?? ''}`;
        return reply
          .type('text/markdown; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${slug}.md"`)
          .send(md);
      },
    );
  });
}
