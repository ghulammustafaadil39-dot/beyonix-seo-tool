import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { query } from '../db.js';
import { ApiError } from '../errors.js';
import { authPlugin } from '../middleware/auth.js';
import { applyPaymentEvent, getPayments } from '../providers/stripe.js';
import { isPlanId } from '../plans.js';

const checkoutSchema = {
  body: {
    type: 'object',
    required: ['planId'],
    properties: { planId: { type: 'string' } },
    additionalProperties: false,
  },
} as const;

const mockConfirmSchema = {
  querystring: {
    type: 'object',
    properties: {
      session_id: { type: 'string' },
      plan: { type: 'string' },
      customer: { type: 'string' },
    },
  },
} as const;

export async function registerBillingRoutes(fastify: FastifyInstance) {
  // Webhook: keep the raw body for signature verification, scoped to this
  // encapsulated context so other routes keep the default JSON parser.
  await fastify.register(async (webhook) => {
    webhook.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
      (req as any).rawBody = body;
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        done(err as Error);
      }
    });

    webhook.post('/billing/webhook', async (req) => {
      const raw = (req as any).rawBody as Buffer;
      const sig = req.headers['stripe-signature'] as string | undefined;
      const evt = await getPayments().constructWebhookEvent(raw, sig ?? '');
      await applyPaymentEvent(evt);
      return { received: true };
    });
  });

  await fastify.register(async (authed) => {
    await authPlugin(authed);

    authed.post('/billing/checkout', { schema: checkoutSchema }, async (req) => {
      const { planId } = req.body as { planId: string };
      if (!isPlanId(planId)) throw new ApiError(400, 'INVALID_PLAN', `Unknown plan: ${planId}`);

      const t = await query('SELECT stripe_customer_id FROM tenants WHERE id = $1', [req.tenant.tenantId]);
      let customerId: string | null = t.rows[0]?.stripe_customer_id ?? null;
      if (!customerId) {
        const c = await getPayments().createCustomer(req.tenant.email, req.tenant.tenantId);
        customerId = c.customerId;
        await query('UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.tenant.tenantId]);
      }

      const s = await getPayments().createCheckoutSession({
        customerId,
        planId,
        successUrl: `${config.appUrl}/dashboard/billing?success=1`,
        cancelUrl: `${config.appUrl}/dashboard/billing?canceled=1`,
        metadata: { tenantId: req.tenant.tenantId },
      });
      return { url: s.url };
    });

    authed.get('/billing/subscription', async (req) => {
      const r = await query(
        `SELECT plan_id, status, stripe_sub_id, current_period_end
         FROM subscriptions WHERE tenant_id = $1`,
        [req.tenant.tenantId],
      );
      if (r.rows.length > 0) return r.rows[0];
      const t = await query('SELECT plan_id FROM tenants WHERE id = $1', [req.tenant.tenantId]);
      return { plan_id: t.rows[0]?.plan_id ?? 'starter', status: 'none' };
    });

    authed.post('/billing/portal', async (req) => {
      const t = await query('SELECT stripe_customer_id FROM tenants WHERE id = $1', [req.tenant.tenantId]);
      const customerId: string | null = t.rows[0]?.stripe_customer_id ?? null;
      if (!customerId) throw new ApiError(400, 'NO_CUSTOMER', 'No billing customer yet — start a checkout first');
      const s = await getPayments().createPortalSession(customerId, `${config.appUrl}/dashboard/billing`);
      return { url: s.url };
    });
  });

  // Dev/test helper: simulates a completed mock checkout (mock provider only).
  // Authenticated + tenant-scoped: the customer must belong to the caller,
  // otherwise anyone could upgrade arbitrary tenants in mock mode.
  await fastify.register(async (authed) => {
    await authPlugin(authed);

    authed.get('/billing/mock-confirm', { schema: mockConfirmSchema }, async (req, reply) => {
      if (!getPayments().isMock) throw new ApiError(404, 'NOT_FOUND', 'Not found');
      const { plan, customer } = req.query as { session_id?: string; plan?: string; customer?: string };
      if (!plan || !isPlanId(plan)) throw new ApiError(400, 'INVALID_PLAN', `Unknown plan: ${plan}`);
      const t = await query('SELECT id FROM tenants WHERE id = $1 AND stripe_customer_id = $2', [
        req.tenant.tenantId,
        customer ?? '',
      ]);
      if (t.rows.length === 0) throw new ApiError(403, 'FORBIDDEN', 'That checkout does not belong to your account');
      const tenantId = t.rows[0].id as string;
      await applyPaymentEvent({
        type: 'checkout.session.completed',
        data: {
          metadata: { tenantId, planId: plan },
          customer,
          subscription: `sub_mock_${Date.now()}`,
        },
      });
      return reply.redirect(`${config.appUrl}/dashboard/billing?success=1`);
    });
  });
}
