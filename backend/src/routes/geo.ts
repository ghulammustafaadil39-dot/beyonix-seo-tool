import type { FastifyInstance } from 'fastify';
import { requireRoleOrScope, requireScope } from '../middleware/access.js';
import { authPlugin } from '../middleware/auth.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { requireActiveSubscriptionOrTrial } from '../middleware/requireSubscription.js';
import { expensiveTenantLimit } from '../middleware/rateLimit.js';
import { query } from '../db.js';
import { ApiError, badRequest, validationError, notFound } from '../errors.js';
import { requireSite } from '../services/sites.js';
import {
  geoScore, runGeoCheck, shareOfVoice, geoHistory, geoRecommendations,
  generateLlmsTxt, GEO_ENGINES, SIMULATED_DISCLAIMER,
} from '../services/geoService.js';
import {
  checkAiVisibility, generateGeoFixes, saveReadinessResult,
  latestReadiness, readinessHistory,
} from '../services/geoChecker.js';
import { checkLimit } from '../metering.js';

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

const GEO_PLATFORMS_ALLOWED = [...GEO_ENGINES] as const;
const DEFAULT_PLATFORMS = ['chatgpt', 'perplexity'];

export async function registerGeoRoutes(fastify: FastifyInstance) {
  // Encapsulated child: the auth hook below must cover only this
  // file's routes. Calling fastify.register(authPlugin) directly on the
  // /api/v1 instance would put the preHandler hook on the whole API
  // scope (incl. public /auth/* and /billing/webhook) — see P0-01.
  await fastify.register(async (app) => {
    await authPlugin(app);

    app.get('/sites/:id/geo', { preHandler: requireScope('geo:read'),
      schema: { params: idParams },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const score = await geoScore(site.tenant_id, site.id);
      const checks = await query(
        `SELECT id, query, platform, mentioned, context_snippet, checked_at,
                sentiment, citations, simulated, engine_version
         FROM geo_checks
         WHERE site_id = $1 AND tenant_id = $2
         ORDER BY checked_at DESC LIMIT 20`,
        [site.id, site.tenant_id],
      );
      return { score, checks: checks.rows, simulated: true, disclaimer: SIMULATED_DISCLAIMER };
    });

    app.post('/sites/:id/geo/check', {
      // A1-H2: geo checks spend LLM budget — editor+ / geo:write.
      preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'geo:write'), expensiveTenantLimit()], // S-01: LLM spend; S-03: per-tenant budget
      schema: {
        params: idParams,
        body: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            platforms: {
              type: 'array',
              items: { type: 'string', enum: GEO_PLATFORMS_ALLOWED },
              minItems: 1,
              maxItems: 5,
            },
          },
          required: ['query'],
        },
      },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const { query: queryText, platforms } = req.body as { query: string; platforms?: string[] };
      const site = await requireSite(req.tenant.tenantId, id);

      const q = String(queryText ?? '').trim();
      if (q.length < 3 || q.length > 200) throw validationError('query must be between 3 and 200 characters');
      const plats = platforms && platforms.length > 0 ? platforms : DEFAULT_PLATFORMS;
      for (const p of plats) {
        if (!(GEO_PLATFORMS_ALLOWED as readonly string[]).includes(p)) {
          throw validationError(`Unknown platform: ${p}`);
        }
      }

      const check = await checkLimit(req.tenant.tenantId, req.tenant.plan, 'geo_checks');
      if (check.used + plats.length > check.limit) {
        throw new ApiError(402, 'LIMIT_EXCEEDED',
          `Plan limit reached for geo_checks: ${check.used}/${check.limit} used this month. Upgrade to continue.`,
          { used: check.used, limit: check.limit, kind: 'geo_checks', upgrade: true });
      }

      const results = await runGeoCheck(site.tenant_id, site.id, q, plats);
      return { results, simulated: true, disclaimer: SIMULATED_DISCLAIMER };
    });

    // ---- F-05: GEO v2 ----

    // Prompt sets per site: the same prompts are run on every engine.
    app.get('/sites/:id/geo/prompts', { preHandler: requireScope('geo:read'), schema: { params: idParams } }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const r = await query(
        `SELECT id, prompt, created_at FROM geo_prompts
         WHERE site_id = $1 AND tenant_id = $2 ORDER BY created_at`,
        [site.id, site.tenant_id],
      );
      return { prompts: r.rows, total: r.rows.length };
    });

    app.post<{ Body: { prompt: string } }>('/sites/:id/geo/prompts', {
      schema: {
        params: idParams,
        body: {
          type: 'object', required: ['prompt'],
          properties: { prompt: { type: 'string', minLength: 3, maxLength: 500 } },
        },
      },
      // A1-H2: prompt management is a mutation — editor+ / geo:write.
      preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'geo:write'),
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const promptText = req.body.prompt.trim();
      const existing = await query(
        `SELECT COUNT(*)::int AS n FROM geo_prompts WHERE site_id = $1 AND tenant_id = $2`,
        [site.id, site.tenant_id],
      );
      if (Number(existing.rows[0]?.n ?? 0) >= 25) throw validationError('Prompt set is limited to 25 prompts per site.');
      try {
        const r = await query(
          `INSERT INTO geo_prompts (tenant_id, site_id, prompt)
           VALUES ($1, $2, $3) RETURNING id, prompt, created_at`,
          [site.tenant_id, site.id, promptText],
        );
        return r.rows[0];
      } catch (err) {
        if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
          throw validationError('This prompt is already in the set.');
        }
        throw err;
      }
    });

    // A1-H2: prompt management is a mutation — editor+ / geo:write.
    app.delete('/sites/:id/geo/prompts/:promptId', {
      schema: { params: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' }, promptId: { type: 'string', format: 'uuid' } },
      required: ['id', 'promptId'],
      } },
      preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'geo:write'),
    }, async (req, reply) => {
      const { id, promptId } = req.params as { id: string; promptId: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const r = await query(
        `DELETE FROM geo_prompts WHERE id = $1 AND site_id = $2 AND tenant_id = $3`,
        [promptId, site.id, site.tenant_id],
      );
      if (r.rowCount === 0) throw notFound('Prompt');
      return reply.code(204).send();
    });

    // Run the whole prompt set across engines (capped for latency).
    app.post<{ Body: { engines?: string[]; maxPrompts?: number } }>('/sites/:id/geo/run-set', {
      // A1-H2: run-sets spend LLM budget — editor+ / geo:write.
      preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'geo:write'), expensiveTenantLimit()],
      schema: {
        params: idParams,
        body: {
          type: 'object',
          properties: {
            engines: { type: 'array', items: { type: 'string', enum: GEO_PLATFORMS_ALLOWED }, minItems: 1, maxItems: 5 },
            maxPrompts: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
          },
        },
      },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const engines = req.body.engines && req.body.engines.length > 0 ? req.body.engines : ['chatgpt', 'perplexity', 'gemini'];
      const maxPrompts = req.body.maxPrompts ?? 5;
      const pr = await query(
        `SELECT prompt FROM geo_prompts WHERE site_id = $1 AND tenant_id = $2 ORDER BY created_at LIMIT $3`,
        [site.id, site.tenant_id, maxPrompts],
      );
      if (pr.rows.length === 0) throw validationError('No prompts in the set. Add prompts first.');
      const check = await checkLimit(req.tenant.tenantId, req.tenant.plan, 'geo_checks');
      const total = pr.rows.length * engines.length;
      if (check.used + total > check.limit) {
        throw new ApiError(402, 'LIMIT_EXCEEDED',
          `Plan limit reached for geo_checks: ${check.used}/${check.limit} used this month (need ${total}). Upgrade to continue.`,
          { used: check.used, limit: check.limit, kind: 'geo_checks', upgrade: true });
      }
      const results: Array<{ prompt: string; checks: unknown }> = [];
      for (const row of pr.rows as Array<{ prompt: string }>) {
        const checks = await runGeoCheck(site.tenant_id, site.id, row.prompt, engines);
        results.push({ prompt: row.prompt, checks });
      }
      return { results, simulated: true, disclaimer: SIMULATED_DISCLAIMER };
    });

    // History series (daily mention rate per engine).
    app.get<{ Querystring: { days?: number } }>('/sites/:id/geo/history', { preHandler: requireScope('geo:read'),
      schema: {
        params: idParams,
        querystring: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } } },
      },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const days = (req.query as { days?: number }).days ?? 30;
      return geoHistory(site.tenant_id, site.id, days);
    });

    // Share-of-voice vs tracked competitors (simulated).
    app.get<{ Querystring: { days?: number } }>('/sites/:id/geo/share-of-voice', { preHandler: requireScope('geo:read'),
      schema: {
        params: idParams,
        querystring: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 30 } } },
      },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const days = (req.query as { days?: number }).days ?? 30;
      return shareOfVoice(site.tenant_id, site.id, days);
    });

    // Recommendations incl. llms.txt guidance.
    app.get('/sites/:id/geo/recommendations', { preHandler: requireScope('geo:read'), schema: { params: idParams } }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      return geoRecommendations(site.tenant_id, site.id);
    });

    // llms.txt generator download.
    app.get('/sites/:id/geo/llms-txt', { preHandler: requireScope('geo:read'), schema: { params: idParams } }, async (req, reply) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const pages = await query(
        `SELECT title, url FROM audit_pages ap
         JOIN audits a ON a.id = ap.audit_id
         WHERE a.site_id = $1 AND ap.tenant_id = $2 AND ap.status_code = 200 AND ap.title IS NOT NULL
         ORDER BY ap.title LIMIT 30`,
        [site.id, site.tenant_id],
      );
      const txt = generateLlmsTxt({
        domain: site.domain,
        siteName: site.domain,
        summary: `Official site information for ${site.domain}, generated by Beyonix SEO for AI assistants.`,
        pages: (pages.rows as Array<{ title: string; url: string }>).map((p) => ({ title: p.title, url: p.url })),
      });
      return reply.type('text/plain; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="llms.txt"')
        .send(txt);
    });

    // ---- Phase 5: GEO readiness (FREE AI-visibility audit) ----
    // Separate from the LLM-simulation checks above — this audits the
    // site's own AI-readiness (llms.txt, robots.txt, schema, content).

    // Run full readiness audit (bodyless — no body schema!).
    app.post('/sites/:id/geo/readiness', {
      preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'geo:write')],
      schema: { params: idParams },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const result = await checkAiVisibility(site.tenant_id, site.id);
      await saveReadinessResult(site.tenant_id, site.id, result);
      return result;
    });

    // Latest readiness score + breakdown.
    app.get('/sites/:id/geo/readiness', {
      preHandler: requireScope('geo:read'),
      schema: { params: idParams },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const latest = await latestReadiness(site.tenant_id, site.id);
      if (!latest) return { score: null, checks: [], checked_at: null, message: 'Not checked yet — click "Run check" to start.' };
      return { score: latest.score, checks: latest.checks, checked_at: latest.created_at };
    });

    // Score history (for charts + insights integration).
    app.get<{ Querystring: { days?: number } }>('/sites/:id/geo/readiness/history', {
      preHandler: requireScope('geo:read'),
      schema: {
        params: idParams,
        querystring: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 365, default: 90 } } },
      },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const days = (req.query as { days?: number }).days ?? 90;
      const points = await readinessHistory(site.tenant_id, site.id, days);
      return { points };
    });

    // Get ready-to-use fixes (llms.txt, robots.txt, schemas).
    app.post<{ Body: { fix_type?: string } }>('/sites/:id/geo/readiness/fix', {
      preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'geo:write')],
      schema: {
        params: idParams,
        body: {
          type: 'object',
          properties: { fix_type: { type: 'string', enum: ['llms_txt', 'robots_txt', 'org_schema', 'faq_schema'] } },
        },
      },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const fixes = await generateGeoFixes(site.tenant_id, site.id);
      const { fix_type } = req.body as { fix_type?: string };
      if (fix_type) {
        const one = fixes.find((f) => f.fixType === fix_type);
        if (!one) throw notFound('Fix');
        return { fix: one };
      }
      return { fixes };
    });

    // Client-configurable check schedule (daily/weekly).
    app.post<{ Body: { frequency: 'daily' | 'weekly'; enabled?: boolean } }>('/sites/:id/geo/readiness/schedule', {
      preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'geo:write'),
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['frequency'],
          properties: {
            frequency: { type: 'string', enum: ['daily', 'weekly'] },
            enabled: { type: 'boolean', default: true },
          },
        },
      },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const { frequency, enabled } = req.body;
      await query(
        `INSERT INTO geo_schedules (site_id, tenant_id, frequency, enabled, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (site_id) DO UPDATE SET frequency = $3, enabled = $4, updated_at = now()`,
        [site.id, site.tenant_id, frequency, enabled ?? true],
      );
      return { ok: true, frequency, enabled: enabled ?? true };
    });

    app.get('/sites/:id/geo/readiness/schedule', {
      preHandler: requireScope('geo:read'),
      schema: { params: idParams },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const r = await query(`SELECT frequency, enabled FROM geo_schedules WHERE site_id = $1`, [site.id]);
      return r.rows[0] ?? { frequency: 'weekly', enabled: true };
    });
  });
}