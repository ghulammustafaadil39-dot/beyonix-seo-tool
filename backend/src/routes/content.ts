import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireRoleOrScope, requireScope } from '../middleware/access.js';
import { authPlugin } from '../middleware/auth.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { requireActiveSubscriptionOrTrial } from '../middleware/requireSubscription.js';
import { expensiveTenantLimit } from '../middleware/rateLimit.js';
import { requireSite } from '../services/sites.js';
import { buildGeoHtml } from '../services/contentEngine.js';
import {
  CONTENT_STATUSES, normalizeStatus, canTransition, snapshotVersion,
  optimizeDraft, internalLinkSuggestions, duplicationCheck, generateSeoAssets,
  generateOutlineFromBrief,
} from '../services/contentWorkflow.js';
import { markdownToDocx } from '../services/docxExport.js';
import { publishPiece } from '../services/publishConnector.js';
import { checkLimit, assertLimit } from '../metering.js';
import { ApiError, notFound, badRequest, validationError } from '../errors.js';
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
const STATUSES = [...CONTENT_STATUSES] as const;

const uuidParamSchema = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

interface SiteParams {
  id: string;
}

/**
 * C1-L-11: single source of truth for AI-word estimates. The worker reserves
 * targetWords + 400, so route pre-flights use the same number — the three
 * previously disagreeing constants (800/1500/2500 create pre-flight, +1600
 * generate pre-flight, 1200 enqueue target) are unified here.
 */
export function estimateAiWords(targetWords: number): number {
  return targetWords + 400;
}

async function enqueueGenerateContent(
  pieceId: string,
  tenantId: string,
  tone: string,
  targetWords: number,
): Promise<{ deduplicated: boolean }> {
  const { enqueueDeduped, QUEUES, Jobs } = await import('../queues.js');
  // C1-M-3: the permanent `content:${pieceId}` jobId silently deduped on
  // BullMQ and returned a fake {queued:true} forever after a terminal
  // failure. Use the Redis-claim honest-dedupe pattern like the refresh
  // routes, with a per-day windowed key.
  const day = new Date().toISOString().slice(0, 10);
  return enqueueDeduped(
    QUEUES.content,
    Jobs.GENERATE_CONTENT,
    { pieceId, tenantId, tone, targetWords },
    `content:${pieceId}:${day}`,
  );
}

export async function registerContentRoutes(fastify: FastifyInstance) {
  await fastify.register(async (app) => {
    await authPlugin(app);

    // List content pieces for a site (newest first), optional ?status= filter.
    app.get<{ Params: SiteParams; Querystring: { status?: string } }>(
      '/sites/:id/content',
      { preHandler: requireScope('content:read'),
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
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, expensiveTenantLimit(), requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write')], // S-01: creating a piece enqueues LLM generation; S-03: per-tenant budget
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
              brief: { type: 'string', minLength: 10, maxLength: 20000 },
            },
          },
        },
      },
      async (req: FastifyRequest<{ Params: SiteParams; Body: { keywordId?: string; title: string; tone?: string; length?: string } }>, reply: FastifyReply) => {
        const { tenantId, plan } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);

        const title = req.body.title?.trim();
        if (!title) throw validationError('title is required');
        const tone = req.body.tone?.trim() || 'friendly professional';
        const length = req.body.length ?? 'medium';
        if (!LENGTH_ESTIMATES[length]) throw validationError('length must be short|medium|long');
        const estimate = LENGTH_ESTIMATES[length];

        const lim = await checkLimit(tenantId, plan, 'ai_words');
        // C1-L-11: pre-flight with the same estimate the worker reserves.
        if (!canAffordAiWords(lim.used, lim.limit, estimateAiWords(estimate))) {
          throw new ApiError(
            402,
            'LIMIT_EXCEEDED',
            `AI words limit reached: ${lim.used}/${lim.limit} used this month; this piece needs ~${estimateAiWords(estimate)} words. Upgrade to continue.`,
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

        // F-04: when a brief is supplied the piece starts the brief -> outline ->
        // draft workflow instead of immediately generating.
        const brief = (req.body as { brief?: string }).brief?.trim() || null;
        const ins = await defaultQuery(
          `INSERT INTO content_pieces (id, tenant_id, site_id, keyword_id, title, tone, brief, status)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [tenantId, site.id, req.body.keywordId ?? null, title, tone, brief, brief ? 'brief' : 'draft'],
        );
        const piece = ins.rows[0];

        if (!brief) {
          await enqueueGenerateContent(piece.id, tenantId, tone, estimate);
        }

        return reply.code(201).send(piece);
      },
    );

    // Get one piece (tenant-scoped).
    app.get<{ Params: SiteParams }>(
      '/content/:id',
      { preHandler: requireScope('content:read'), schema: { params: uuidParamSchema } },
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
      { preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write'),
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
        const existing = await defaultQuery(`SELECT * FROM content_pieces WHERE id = $1 AND tenant_id = $2`, [
          req.params.id,
          tenantId,
        ]);
        if (existing.rows.length === 0) throw notFound('Content piece');
        await snapshotVersion(defaultQuery, tenantId, existing.rows[0]);
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const field of ['title', 'outline', 'draft'] as const) {
          const v = req.body[field];
          if (v !== undefined) {
            params.push(field === 'title' ? v.trim() : v);
            sets.push(`${field} = $${params.length}`);
          }
        }
        if (sets.length === 0) throw validationError('nothing to update');
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
      { preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write'), schema: { params: uuidParamSchema } },
      async (req) => {
        const { tenantId } = req.tenant;
        // C1-L-12: route approve through the same canTransition state
        // machine as the status endpoint — a piece can no longer jump
        // brief -> approved while the status endpoint forbids it.
        const cur = await defaultQuery(`SELECT status FROM content_pieces WHERE id = $1 AND tenant_id = $2`, [
          req.params.id,
          tenantId,
        ]);
        if (cur.rows.length === 0) throw notFound('Content piece');
        if (!canTransition(cur.rows[0].status as string, 'approved')) {
          throw new ApiError(
            400,
            'INVALID_STATUS',
            `Cannot approve a piece in '${cur.rows[0].status}' status`,
          );
        }
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
      { schema: { params: uuidParamSchema }, preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, expensiveTenantLimit(), requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write')] }, // S-01: LLM spend; S-03: per-tenant budget
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
        if (lim.used + estimateAiWords(1200) > lim.limit) {
          throw new ApiError(
            402,
            'LIMIT_EXCEEDED',
            `AI words limit reached: ${lim.used}/${lim.limit} used this month. Upgrade to continue.`,
            { used: lim.used, limit: lim.limit, kind: 'ai_words', upgrade: true },
          );
        }
        // C1-M-3: report dedupe honestly — a repeat click in the same day
        // must not get a fake {queued:true}.
        const { deduplicated } = await enqueueGenerateContent(piece.id, tenantId, 'friendly professional', 1200);
        return deduplicated ? { ok: true, queued: false, deduplicated: true } : { ok: true, queued: true };
      },
    );

    // Export a piece as markdown or GEO-ready HTML (downloaded as a file).
    app.get<{ Params: SiteParams; Querystring: { format?: string } }>(
      '/content/:id/export',
      { preHandler: requireScope('content:read'),
        schema: {
          params: uuidParamSchema,
          querystring: {
            type: 'object',
            properties: { format: { type: 'string', enum: ['html', 'markdown', 'docx'], default: 'markdown' } },
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
        if (format === 'docx') {
          const buf = await markdownToDocx(piece.title ?? '', `# ${piece.title ?? ''}\n\n${piece.outline ?? ''}\n\n${piece.draft ?? ''}`);
          return reply
            .type('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
            .header('Content-Disposition', `attachment; filename="${slug}.docx"`)
            .send(buf);
        }
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

    // ---- F-04: content engine v2 ----

    async function requirePiece(tenantId: string, pieceId: string) {
      const r = await defaultQuery(`SELECT * FROM content_pieces WHERE id = $1 AND tenant_id = $2`, [pieceId, tenantId]);
      if (r.rows.length === 0) throw notFound('Content piece');
      return r.rows[0];
    }

    // Set/replace the brief (brief -> outline -> draft workflow).
    app.post<{ Params: SiteParams; Body: { brief: string } }>(
      '/content/:id/brief',
      { preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write'),
        schema: {
          params: uuidParamSchema,
          body: {
            type: 'object', required: ['brief'],
            properties: { brief: { type: 'string', minLength: 10, maxLength: 20000 } },
          },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const piece = await requirePiece(tenantId, req.params.id);
        await snapshotVersion(defaultQuery, tenantId, piece);
        const r = await defaultQuery(
          `UPDATE content_pieces SET brief = $3, status = 'brief', updated_at = now()
           WHERE id = $1 AND tenant_id = $2 RETURNING *`,
          [req.params.id, tenantId, req.body.brief.trim()],
        );
        return r.rows[0];
      },
    );

    // Generate the outline from the brief (LLM, metered).
    app.post<{ Params: SiteParams }>(
      '/content/:id/outline',
      {
        schema: { params: uuidParamSchema },
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, expensiveTenantLimit(), requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write')],
      },
      async (req) => {
        const { tenantId, plan } = req.tenant;
        const piece = await requirePiece(tenantId, req.params.id);
        if (!piece.brief) throw validationError('Set a brief first (POST /content/:id/brief).');
        const lim = await checkLimit(tenantId, plan, 'ai_words');
        if (lim.used + 600 > lim.limit) {
          throw new ApiError(402, 'LIMIT_EXCEEDED', `AI words limit reached: ${lim.used}/${lim.limit} used this month. Upgrade to continue.`,
            { used: lim.used, limit: lim.limit, kind: 'ai_words', upgrade: true });
        }
        let keyword = '';
        if (piece.keyword_id) {
          const kr = await defaultQuery(`SELECT keyword FROM keywords WHERE id = $1 AND tenant_id = $2`, [piece.keyword_id, tenantId]);
          keyword = kr.rows[0]?.keyword ?? '';
        }
        const site = await requireSite(tenantId, piece.site_id);
        await snapshotVersion(defaultQuery, tenantId, piece);
        const outline = await generateOutlineFromBrief(tenantId, {
          keyword, title: piece.title, brief: piece.brief,
          tone: piece.tone || 'friendly professional', siteDomain: site.domain, siteId: site.id,
        });
        const r = await defaultQuery(
          `UPDATE content_pieces SET outline = $3, status = 'outline', updated_at = now()
           WHERE id = $1 AND tenant_id = $2 RETURNING *`,
          [req.params.id, tenantId, outline],
        );
        return r.rows[0];
      },
    );

    // NLP term-coverage scoring against top SERP results.
    app.post<{ Params: SiteParams }>(
      '/content/:id/optimize',
      { preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write')], schema: { params: uuidParamSchema } }, // D1-L-4: S-01 gate; D5-H-1: trial gate (SERP spend)
      async (req) => {
        const { tenantId } = req.tenant;
        const piece = await requirePiece(tenantId, req.params.id);
        return optimizeDraft(tenantId, piece, defaultQuery);
      },
    );

    // Internal-link suggestions from the site's crawl graph.
    app.get<{ Params: SiteParams }>(
      '/content/:id/internal-links',
      { preHandler: requireScope('content:read'), schema: { params: uuidParamSchema } },
      async (req) => {
        const { tenantId } = req.tenant;
        const piece = await requirePiece(tenantId, req.params.id);
        let keyword = '';
        if (piece.keyword_id) {
          const kr = await defaultQuery(`SELECT keyword FROM keywords WHERE id = $1 AND tenant_id = $2`, [piece.keyword_id, tenantId]);
          keyword = kr.rows[0]?.keyword ?? '';
        }
        return { data: await internalLinkSuggestions(tenantId, piece.site_id, keyword, piece.title ?? '', defaultQuery) };
      },
    );

    // Duplication check vs existing content + crawled pages.
    app.post<{ Params: SiteParams; Body: { text?: string } }>(
      '/content/:id/duplication',
      { preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write')], // D1-L-4: S-01 gate; D5-H-1: trial gate
        schema: {
          params: uuidParamSchema,
          body: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 200000 } } },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const piece = await requirePiece(tenantId, req.params.id);
        const text = req.body.text ?? piece.draft ?? '';
        if (!text.trim()) throw validationError('No text to check (piece has no draft and no text was given).');
        return { data: await duplicationCheck(tenantId, piece.site_id, piece.id, text, defaultQuery) };
      },
    );

    // Image alt / meta / schema generation (LLM, metered).
    app.post<{ Params: SiteParams; Body: { topics?: string[]; imageCount?: number } }>(
      '/content/:id/seo-assets',
      {
        schema: {
          params: uuidParamSchema,
          body: {
            type: 'object',
            properties: {
              topics: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 20 },
              imageCount: { type: 'integer', minimum: 1, maximum: 10, default: 3 },
            },
          },
        },
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, expensiveTenantLimit(), requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write')],
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const piece = await requirePiece(tenantId, req.params.id);
        let keyword = '';
        if (piece.keyword_id) {
          const kr = await defaultQuery(`SELECT keyword FROM keywords WHERE id = $1 AND tenant_id = $2`, [piece.keyword_id, tenantId]);
          keyword = kr.rows[0]?.keyword ?? '';
        }
        return generateSeoAssets(tenantId, {
          title: piece.title ?? '',
          keyword,
          topics: req.body.topics ?? [],
          imageCount: req.body.imageCount ?? 3,
        }, defaultQuery);
      },
    );

    // Approval-flow status transitions (validated).
    app.patch<{ Params: SiteParams; Body: { status: string } }>(
      '/content/:id/status',
      { preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write'),
        schema: {
          params: uuidParamSchema,
          body: {
            type: 'object', required: ['status'],
            properties: { status: { type: 'string', enum: [...CONTENT_STATUSES] } },
          },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const piece = await requirePiece(tenantId, req.params.id);
        const target = normalizeStatus(req.body.status);
        if (!canTransition(piece.status, target)) {
          throw new ApiError(400, 'INVALID_TRANSITION', `Cannot move content from "${piece.status}" to "${target}".`);
        }
        await snapshotVersion(defaultQuery, tenantId, piece);
        const r = await defaultQuery(
          `UPDATE content_pieces SET status = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
          [req.params.id, tenantId, target],
        );
        return r.rows[0];
      },
    );

    // Version history.
    app.get<{ Params: SiteParams }>(
      '/content/:id/versions',
      { preHandler: requireScope('content:read'), schema: { params: uuidParamSchema } },
      async (req) => {
        const { tenantId } = req.tenant;
        await requirePiece(tenantId, req.params.id);
        const r = await defaultQuery(
          `SELECT id, title, status, changed_by, created_at,
                  LEFT(COALESCE(outline,''), 200) AS outline_preview,
                  LEFT(COALESCE(draft,''), 200) AS draft_preview
           FROM content_versions WHERE piece_id = $1 AND tenant_id = $2 ORDER BY created_at DESC LIMIT 50`,
          [req.params.id, tenantId],
        );
        return { data: r.rows, total: r.rows.length };
      },
    );

    // Brand-voice profile per site.
    app.get<{ Params: SiteParams }>(
      '/sites/:id/content-profile',
      { preHandler: requireScope('content:read'), schema: { params: uuidParamSchema } },
      async (req) => {
        const { tenantId } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);
        const r = await defaultQuery(
          `SELECT * FROM content_profiles WHERE site_id = $1 AND tenant_id = $2`,
          [site.id, tenantId],
        );
        return { profile: r.rows[0] ?? null };
      },
    );

    app.put<{ Params: SiteParams; Body: { tone?: string; vocabulary?: string; do_rules?: string; dont_rules?: string; sample?: string } }>(
      '/sites/:id/content-profile',
      { preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write'),
        schema: {
          params: uuidParamSchema,
          body: {
            type: 'object', minProperties: 1,
            properties: {
              tone: { type: 'string', maxLength: 500 },
              vocabulary: { type: 'string', maxLength: 2000 },
              do_rules: { type: 'string', maxLength: 2000 },
              dont_rules: { type: 'string', maxLength: 2000 },
              sample: { type: 'string', maxLength: 5000 },
            },
          },
        },
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);
        const b = req.body;
        const r = await defaultQuery(
          `INSERT INTO content_profiles (id, tenant_id, site_id, tone, vocabulary, do_rules, dont_rules, sample, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, now())
           ON CONFLICT (site_id) DO UPDATE SET
             tone = COALESCE(EXCLUDED.tone, content_profiles.tone),
             vocabulary = COALESCE(EXCLUDED.vocabulary, content_profiles.vocabulary),
             do_rules = COALESCE(EXCLUDED.do_rules, content_profiles.do_rules),
             dont_rules = COALESCE(EXCLUDED.dont_rules, content_profiles.dont_rules),
             sample = COALESCE(EXCLUDED.sample, content_profiles.sample),
             updated_at = now()
           RETURNING *`,
          [tenantId, site.id, b.tone ?? null, b.vocabulary ?? null, b.do_rules ?? null, b.dont_rules ?? null, b.sample ?? null],
        );
        return { profile: r.rows[0] };
      },
    );

    // CMS publish connector (WordPress/Webflow; honest mock mode unless CMS_PUBLISH_ENABLED=true).
    app.post<{ Params: SiteParams; Body: { pieceId: string; target: 'wordpress' | 'webflow'; status?: 'draft' | 'publish'; siteUrl?: string; username?: string; appPassword?: string; apiToken?: string; collectionId?: string } }>(
      '/sites/:id/publish',
      {
        schema: {
          params: uuidParamSchema,
          body: {
            type: 'object', required: ['pieceId', 'target'],
            properties: {
              pieceId: { type: 'string', format: 'uuid' },
              target: { type: 'string', enum: ['wordpress', 'webflow'] },
              status: { type: 'string', enum: ['draft', 'publish'], default: 'draft' },
              siteUrl: { type: 'string', maxLength: 500 },
              username: { type: 'string', maxLength: 200 },
              appPassword: { type: 'string', maxLength: 500 },
              apiToken: { type: 'string', maxLength: 500 },
              collectionId: { type: 'string', maxLength: 200 },
            },
          },
        },
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write')],
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);
        const piece = await requirePiece(tenantId, req.body.pieceId);
        if (piece.site_id !== site.id) throw notFound('Content piece');
        // SECURITY (F-04 SSRF fix): the WordPress siteUrl is tenant-supplied
        // and fetched server-side — https only, rejected here with a clear
        // 400 before the connector runs (the connector re-checks as well).
        if (req.body.target === 'wordpress' && req.body.siteUrl) {
          let parsed: URL | null = null;
          try {
            parsed = new URL(req.body.siteUrl);
          } catch {
            parsed = null;
          }
          if (!parsed || parsed.protocol !== 'https:') {
            throw badRequest('siteUrl must be a valid https:// URL');
          }
        }
        const html = buildGeoHtml(piece.draft ?? '', piece.title ?? '');
        const result = await publishPiece({
          target: req.body.target,
          title: piece.title ?? 'Untitled',
          html,
          status: req.body.status ?? 'draft',
          siteUrl: req.body.siteUrl,
          username: req.body.username,
          appPassword: req.body.appPassword,
          apiToken: req.body.apiToken,
          collectionId: req.body.collectionId,
        });
        return result;
      },
    );
    // ---- Phase 4: content campaigns ----

    // Create a campaign (publishing cadence + mode).
    app.post<{
      Params: SiteParams;
      Body: { name: string; blogs_per_week?: number; blogs_per_month?: number; mode?: 'autopilot' | 'approval' };
    }>(
      '/sites/:id/content/campaigns',
      {
        schema: {
          params: uuidParamSchema,
          body: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string', minLength: 1, maxLength: 120 },
              blogs_per_week: { type: 'integer', minimum: 0, maximum: 7 },
              blogs_per_month: { type: 'integer', minimum: 0, maximum: 31 },
              mode: { type: 'string', enum: ['autopilot', 'approval'] },
            },
          },
        },
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write')],
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);
        const { createCampaign } = await import('../services/contentCampaigns.js');
        return createCampaign(tenantId, site.id, req.body);
      },
    );

    // List campaigns for a site (newest first).
    app.get<{ Params: SiteParams }>(
      '/sites/:id/content/campaigns',
      {
        schema: { params: uuidParamSchema },
        preHandler: requireRoleOrScope(['owner', 'admin', 'editor', 'viewer'], 'content:read'),
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);
        const r = await defaultQuery(
          `SELECT c.*, COUNT(t.id) FILTER (WHERE t.status = 'suggested') AS suggested_count,
                  COUNT(t.id) FILTER (WHERE t.status = 'approved') AS approved_count
           FROM content_campaigns c LEFT JOIN campaign_topics t ON t.campaign_id = c.id
           WHERE c.site_id = $1 AND c.tenant_id = $2
           GROUP BY c.id ORDER BY c.created_at DESC`,
          [site.id, tenantId],
        );
        return { data: r.rows };
      },
    );

    // List topics for a campaign.
    app.get<{ Params: SiteParams & { campaignId: string } }>(
      '/sites/:id/content/campaigns/:campaignId/topics',
      {
        schema: {
          params: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              campaignId: { type: 'string', format: 'uuid' },
            },
            required: ['id', 'campaignId'],
          },
        },
        preHandler: requireRoleOrScope(['owner', 'admin', 'editor', 'viewer'], 'content:read'),
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);
        const r = await defaultQuery(
          `SELECT * FROM campaign_topics WHERE campaign_id = $1 AND site_id = $2 AND tenant_id = $3 ORDER BY created_at DESC`,
          [req.params.campaignId, site.id, tenantId],
        );
        return { data: r.rows };
      },
    );

    // AI-suggest topics for a campaign (bodyless — suggestions come from free sources).
    app.post<{ Params: SiteParams & { campaignId: string } }>(
      '/sites/:id/content/campaigns/:campaignId/topics/suggest',
      {
        schema: {
          params: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              campaignId: { type: 'string', format: 'uuid' },
            },
            required: ['id', 'campaignId'],
          },
        },
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write')],
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);
        const camp = await defaultQuery(
          `SELECT id FROM content_campaigns WHERE id = $1 AND site_id = $2 AND tenant_id = $3`,
          [req.params.campaignId, site.id, tenantId],
        );
        if (camp.rows.length === 0) throw notFound('Campaign');
        const { suggestTopics, saveTopicSuggestions } = await import('../services/contentCampaigns.js');
        const suggestions = await suggestTopics(tenantId, site.id, req.params.campaignId, 5);
        const saved = await saveTopicSuggestions(tenantId, site.id, req.params.campaignId, suggestions);
        return { ok: true, suggested: suggestions.length, saved };
      },
    );

    // Manually add a topic to a campaign.
    app.post<{
      Params: SiteParams & { campaignId: string };
      Body: { topic: string; keyword?: string };
    }>(
      '/sites/:id/content/campaigns/:campaignId/topics',
      {
        schema: {
          params: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              campaignId: { type: 'string', format: 'uuid' },
            },
            required: ['id', 'campaignId'],
          },
          body: {
            type: 'object',
            required: ['topic'],
            properties: {
              topic: { type: 'string', minLength: 1, maxLength: 300 },
              keyword: { type: 'string', maxLength: 200 },
            },
          },
        },
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write')],
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);
        const camp = await defaultQuery(
          `SELECT id FROM content_campaigns WHERE id = $1 AND site_id = $2 AND tenant_id = $3`,
          [req.params.campaignId, site.id, tenantId],
        );
        if (camp.rows.length === 0) throw notFound('Campaign');
        const r = await defaultQuery(
          `INSERT INTO campaign_topics (tenant_id, site_id, campaign_id, topic, keyword, status, suggested_by)
           VALUES ($1, $2, $3, $4, $5, 'suggested', 'user')
           ON CONFLICT (campaign_id, lower(topic)) DO NOTHING RETURNING *`,
          [tenantId, site.id, req.params.campaignId, req.body.topic.trim(), req.body.keyword?.trim() || null],
        );
        if (r.rows.length === 0) throw badRequest('This topic is already in the campaign');
        return r.rows[0];
      },
    );

    // Approve a topic for writing (bodyless). Creates a draft content piece
    // linked to the topic so the existing generate/approve flow takes over.
    app.post<{ Params: SiteParams & { topicId: string } }>(
      '/sites/:id/content/topics/:topicId/approve',
      {
        schema: {
          params: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              topicId: { type: 'string', format: 'uuid' },
            },
            required: ['id', 'topicId'],
          },
        },
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write')],
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);
        const t = await defaultQuery(
          `SELECT * FROM campaign_topics WHERE id = $1 AND site_id = $2 AND tenant_id = $3`,
          [req.params.topicId, site.id, tenantId],
        );
        if (t.rows.length === 0) throw notFound('Topic');
        const topic = t.rows[0];
        if (topic.status === 'written' && topic.content_piece_id) {
          return { ok: true, topic, pieceId: topic.content_piece_id, already: true };
        }
        // Create a draft piece for this topic (existing content flow).
        const piece = await defaultQuery(
          `INSERT INTO content_pieces (tenant_id, site_id, title, status, tone)
           VALUES ($1, $2, $3, 'draft', 'professional') RETURNING *`,
          [tenantId, site.id, topic.topic],
        );
        await defaultQuery(
          `UPDATE campaign_topics SET status = 'written', decided_at = now(), content_piece_id = $1 WHERE id = $2`,
          [piece.rows[0].id, topic.id],
        );
        return { ok: true, topic: { ...topic, status: 'written' }, pieceId: piece.rows[0].id };
      },
    );

    // Reject a topic (bodyless).
    app.post<{ Params: SiteParams & { topicId: string } }>(
      '/sites/:id/content/topics/:topicId/reject',
      {
        schema: {
          params: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              topicId: { type: 'string', format: 'uuid' },
            },
            required: ['id', 'topicId'],
          },
        },
        preHandler: [requireRoleOrScope(['owner', 'admin', 'editor'], 'content:write')],
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const site = await requireSite(tenantId, req.params.id);
        const r = await defaultQuery(
          `UPDATE campaign_topics SET status = 'rejected', decided_at = now()
           WHERE id = $1 AND site_id = $2 AND tenant_id = $3 AND status = 'suggested' RETURNING *`,
          [req.params.topicId, site.id, tenantId],
        );
        if (r.rows.length === 0) throw notFound('Topic');
        return r.rows[0];
      },
    );

    // Quality check on a content piece's draft (bodyless).
    // Uses /content/:id to match the existing generate/approve route pattern
    // (Fastify disallows duplicate :id param names in one path).
    app.post<{ Params: { id: string } }>(
      '/content/:id/quality-check',
      {
        schema: { params: uuidParamSchema },
        preHandler: requireRoleOrScope(['owner', 'admin', 'editor', 'viewer'], 'content:read'),
      },
      async (req) => {
        const { tenantId } = req.tenant;
        const { scoreContent, isHumanLike } = await import('../services/contentQuality.js');
        const r = await defaultQuery(
          `SELECT p.*, k.keyword FROM content_pieces p
           LEFT JOIN keywords k ON k.id = p.keyword_id
           WHERE p.id = $1 AND p.tenant_id = $2`,
          [req.params.id, tenantId],
        );
        if (r.rows.length === 0) throw notFound('Content piece');
        const piece = r.rows[0];
        const draft = piece.draft ?? '';
        if (!draft.trim()) {
          return { ok: true, score: 0, passed: false, breakdown: [], suggestions: ['No draft yet — generate the draft first, then run the quality check.'], humanLike: false, humanLikeIssues: ['No draft to evaluate'] };
        }
        const result = scoreContent(draft, piece.keyword ?? '');
        const hl = isHumanLike(draft);
        return { ok: true, ...result, humanLike: hl.humanLike, humanLikeIssues: hl.issues };
      },
    );
  });
}
