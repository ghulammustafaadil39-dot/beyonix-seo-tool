// W-04: Insights engine API (rules-based v1 — all outputs labeled
// 'computed', not AI-generated). Tenant-scoped via authPlugin + requireSite.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authPlugin } from '../middleware/auth.js';
import { requireScope } from '../middleware/access.js';
import { query as defaultQuery } from '../db.js';
import { requireSite } from '../services/sites.js';
import { getSiteInsights } from '../services/insights.js';

const params = { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] } as const;

export async function registerInsightRoutes(fastify: FastifyInstance) {
  fastify.register(async (app) => {
    await authPlugin(app);

    app.get<{ Params: { id: string } }>(
      '/sites/:id/insights',
      { preHandler: requireScope('ranks:read'), schema: { params } },
      async (req: FastifyRequest) => {
        const siteId = (req.params as any).id as string;
        const { tenantId } = req.tenant;
        await requireSite(tenantId, siteId);
        const { actions, forecast } = await getSiteInsights(tenantId, siteId);
        return { engine: 'rules-v1', computedAt: new Date().toISOString(), actions, forecast };
      },
    );
  });
}
