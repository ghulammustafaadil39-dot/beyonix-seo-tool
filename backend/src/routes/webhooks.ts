import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { authPlugin } from '../middleware/auth.js';
import { actorMeta, actorUserId, requireRole, requireRoleOrScope, requireScope } from '../middleware/access.js';
import { paginate, assertUuid } from '../pagination.js';
import { logActivity } from '../services/activityLog.js';
import {
  registerWebhookEndpoint,
  replayDelivery,
} from '../services/webhookDelivery.js';

/**
 * F-10: tenant webhook endpoints (outbound). The signed event catalog:
 * audit.completed, rank.changed, report.ready, invoice.paid,
 * invoice.payment_failed, subscription.updated, limit.near, site.down,
 * issue.critical, notify.*.
 */
export const WEBHOOK_EVENT_CATALOG = [
  'audit.completed',
  'rank.changed',
  'report.ready',
  'invoice.paid',
  'invoice.payment_failed',
  'subscription.updated',
  'limit.near',
  'site.down',
  'issue.critical',
  'notify.rank_drop',
  'notify.critical_issue',
  'notify.site_down',
  'notify.limit_near',
] as const;

const createSchema = {
  body: {
    type: 'object',
    required: ['url', 'events'],
    properties: {
      url: { type: 'string', maxLength: 2048 },
      events: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
    },
    additionalProperties: false,
  },
} as const;

export async function registerWebhookRoutes(fastify: FastifyInstance) {
  await fastify.register(async (authed) => {
    await authPlugin(authed);
    const t = (req: any) => req.tenant.tenantId as string;

    authed.get('/webhooks/events', { preHandler: requireScope('webhooks:read') }, async () => ({ events: WEBHOOK_EVENT_CATALOG })); // E1-L-1: scope gate like siblings

    authed.get('/webhooks', { preHandler: requireScope('webhooks:read') }, async (req) => {
      const r = await query(
        `SELECT id, url, events, enabled, created_at FROM webhook_endpoints
         WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [t(req)],
      );
      return { data: r.rows };
    });

    authed.post(
      '/webhooks',
      {
        schema: createSchema,
        preHandler: requireRoleOrScope(['owner', 'admin'], 'webhooks:write'),
      },
      async (req) => {
        const { url, events } = req.body as { url: string; events: string[] };
        const unknown = events.filter((e) => !(WEBHOOK_EVENT_CATALOG as readonly string[]).includes(e));
        if (unknown.length > 0) {
          throw new ApiError(400, 'UNKNOWN_EVENT', `Unknown webhook event(s): ${unknown.join(', ')}`);
        }
        let created: { id: string; secret: string };
        try {
          created = await registerWebhookEndpoint(t(req), url, events);
        } catch (err) {
          throw new ApiError(400, 'INVALID_WEBHOOK_URL', (err as Error).message);
        }
        await logActivity(t(req), {
          userId: actorUserId(req),
          action: 'webhook.created',
          entityType: 'webhook_endpoint',
          entityId: created.id,
          meta: { url, events, ...actorMeta(req) },
        });
        // The signing secret is shown ONCE (like API keys); afterwards only
        // the endpoint id is visible.
        return { id: created.id, url, events, secret: created.secret };
      },
    );

    authed.delete(
      '/webhooks/:id',
      { preHandler: requireRoleOrScope(['owner', 'admin'], 'webhooks:write') },
      async (req) => {
        const id = assertUuid((req.params as any).id, 'webhook id');
        const r = await query(`DELETE FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2`, [id, t(req)]);
        if ((r.rowCount ?? 0) === 0) throw new ApiError(404, 'NOT_FOUND', 'Webhook endpoint not found');
        await logActivity(t(req), {
          userId: actorUserId(req),
          action: 'webhook.deleted',
          meta: actorMeta(req),
          entityType: 'webhook_endpoint',
          entityId: id,
        });
        return { ok: true };
      },
    );

    authed.get('/webhooks/deliveries', { preHandler: requireScope('webhooks:read') }, async (req) => {
      const { page, limit, offset } = paginate(req);
      const [rows, count] = await Promise.all([
        query(
          `SELECT d.id, d.event, d.status, d.attempts, d.last_error, d.last_status_code,
                  d.created_at, d.delivered_at, e.url AS endpoint_url
           FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
           WHERE d.tenant_id = $1 ORDER BY d.created_at DESC LIMIT $2 OFFSET $3`,
          [t(req), limit, offset],
        ),
        query(`SELECT COUNT(*)::int c FROM webhook_deliveries WHERE tenant_id = $1`, [t(req)]),
      ]);
      return { data: rows.rows, page, limit, total: Number(count.rows[0].c) };
    });

    authed.post(
      '/webhooks/deliveries/:id/replay',
      { preHandler: requireRoleOrScope(['owner', 'admin'], 'webhooks:write') },
      async (req) => {
        const id = assertUuid((req.params as any).id, 'delivery id');
        const ok = await replayDelivery(t(req), id);
        if (!ok) throw new ApiError(404, 'NOT_FOUND', 'Delivery not found or not replayable');
        return { ok: true };
      },
    );

    // Test/ops helper: enqueue a test delivery to THIS endpoint to verify
    // signing end-to-end.
    authed.post(
      '/webhooks/:id/test',
      { preHandler: requireRoleOrScope(['owner', 'admin'], 'webhooks:write') },
      async (req) => {
        const id = assertUuid((req.params as any).id, 'webhook id');
        const ep = await query(`SELECT id FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2`, [id, t(req)]);
        if (ep.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Webhook endpoint not found');
        await query(
          `INSERT INTO webhook_deliveries (id, endpoint_id, tenant_id, event, payload, status, attempts, next_retry_at)
           VALUES (gen_random_uuid(), $1, $2, 'notify.limit_near', $3, 'pending', 0, now())`,
          [id, t(req), JSON.stringify({ event: 'notify.limit_near', title: 'Webhook test', body: 'Test delivery from Beyonix SEO.' })],
        );
        return { ok: true };
      },
    );
  });
}
