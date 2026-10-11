import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../middleware/auth.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { expensiveTenantLimit } from '../middleware/rateLimit.js';
import { query } from '../db.js';
import { ApiError, badRequest } from '../errors.js';
import { requireSite } from '../services/sites.js';
import { geoScore, runGeoCheck } from '../services/geoService.js';
import { checkLimit } from '../metering.js';

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

const GEO_PLATFORMS_ALLOWED = ['chatgpt', 'perplexity', 'gemini', 'ai_overview'] as const;
const DEFAULT_PLATFORMS = ['chatgpt', 'perplexity'];

export async function registerGeoRoutes(fastify: FastifyInstance) {
  // Encapsulated child: the auth hook below must cover only this
  // file's routes. Calling fastify.register(authPlugin) directly on the
  // /api/v1 instance would put the preHandler hook on the whole API
  // scope (incl. public /auth/* and /billing/webhook) — see P0-01.
  await fastify.register(async (app) => {
    await authPlugin(app);

    app.get('/sites/:id/geo', {
      schema: { params: idParams },
    }, async (req) => {
      const { id } = req.params as { id: string };
      const site = await requireSite(req.tenant.tenantId, id);
      const score = await geoScore(site.tenant_id, site.id);
      const checks = await query(
        `SELECT id, query, platform, mentioned, context_snippet, checked_at
         FROM geo_checks
         WHERE site_id = $1 AND tenant_id = $2
         ORDER BY checked_at DESC LIMIT 20`,
        [site.id, site.tenant_id],
      );
      return { score, checks: checks.rows };
    });

    app.post('/sites/:id/geo/check', {
      preHandler: [requireVerifiedEmail, expensiveTenantLimit()], // S-01: LLM spend; S-03: per-tenant budget
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
              maxItems: 4,
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
      if (q.length < 3 || q.length > 200) throw badRequest('query must be between 3 and 200 characters');
      const plats = platforms && platforms.length > 0 ? platforms : DEFAULT_PLATFORMS;
      for (const p of plats) {
        if (!(GEO_PLATFORMS_ALLOWED as readonly string[]).includes(p)) {
          throw badRequest(`Unknown platform: ${p}`);
        }
      }

      const check = await checkLimit(req.tenant.tenantId, req.tenant.plan, 'geo_checks');
      if (check.used + plats.length > check.limit) {
        throw new ApiError(402, 'LIMIT_EXCEEDED',
          `Plan limit reached for geo_checks: ${check.used}/${check.limit} used this month. Upgrade to continue.`,
          { used: check.used, limit: check.limit, kind: 'geo_checks', upgrade: true });
      }

      const results = await runGeoCheck(site.tenant_id, site.id, q, plats);
      return { results };
    });
  });
}