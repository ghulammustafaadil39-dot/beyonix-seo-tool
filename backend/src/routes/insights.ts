// W-04: Insights engine API (rules-based v1 — all outputs labeled
// 'computed', not AI-generated). Tenant-scoped via authPlugin + requireSite.
// Phase 6: unified dashboard, weekly report, and quick health endpoints.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authPlugin } from '../middleware/auth.js';
import { requireScope, requireRoleOrScope } from '../middleware/access.js';
import { query as defaultQuery } from '../db.js';
import { requireSite } from '../services/sites.js';
import {
  getSiteInsights,
  getInsightsDashboard,
  getWeeklyReport,
  getHealthScore,
} from '../services/insights.js';

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

    // Phase 6: unified dashboard — health, week-over-week, keywords,
    // content, backlinks, geo, competitors. Every metric has a plain-language
    // summary; no bare zeros.
    app.get<{ Params: { id: string } }>(
      '/sites/:id/insights/dashboard',
      { preHandler: requireRoleOrScope(['owner', 'admin', 'editor', 'viewer'], 'sites:read'), schema: { params } },
      async (req: FastifyRequest) => {
        const siteId = (req.params as any).id as string;
        const { tenantId } = req.tenant;
        await requireSite(tenantId, siteId);
        const dashboard = await getInsightsDashboard(tenantId, siteId);
        return { engine: 'dashboard-v1', ...dashboard };
      },
    );

    // Phase 6: structured weekly report — "is hafte kya hua / kya behtar
    // hua / agla kadam". Also used for email digests.
    app.get<{ Params: { id: string } }>(
      '/sites/:id/insights/weekly',
      { preHandler: requireRoleOrScope(['owner', 'admin', 'editor', 'viewer'], 'sites:read'), schema: { params } },
      async (req: FastifyRequest) => {
        const siteId = (req.params as any).id as string;
        const { tenantId } = req.tenant;
        await requireSite(tenantId, siteId);
        return getWeeklyReport(tenantId, siteId);
      },
    );

    // Phase 6: quick health score only — for overview cards.
    app.get<{ Params: { id: string } }>(
      '/sites/:id/insights/health',
      { preHandler: requireRoleOrScope(['owner', 'admin', 'editor', 'viewer'], 'sites:read'), schema: { params } },
      async (req: FastifyRequest) => {
        const siteId = (req.params as any).id as string;
        const { tenantId } = req.tenant;
        await requireSite(tenantId, siteId);
        return getHealthScore(tenantId, siteId);
      },
    );
  });
}
