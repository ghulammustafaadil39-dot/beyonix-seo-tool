import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pool, query } from '../db.js';
import { ApiError } from '../errors.js';
import { authPlugin } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import {
  applyPaymentEvent,
  getPayments,
  mockBillingRoutesEnabled,
  priceIdForPlan,
} from '../providers/stripe.js';
import { isPlanId } from '../plans.js';

const checkoutSchema = {
  body: {
    type: 'object',
    required: ['planId'],
    properties: {
      planId: { type: 'string' },
      interval: { type: 'string', enum: ['monthly', 'annual'] },
      couponCode: { type: 'string', maxLength: 64 },
      trialDays: { type: 'integer', minimum: 1, maximum: 90 },
    },
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
      interval: { type: 'string' },
      trial_days: { type: 'string' },
      coupon: { type: 'string' },
    },
  },
} as const;

const invoicesQuerySchema = {
  querystring: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1, default: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
  },
} as const;

const ACTIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'];

async function validateCoupon(code: string): Promise<void> {
  const r = await query(
    `SELECT active, max_redemptions, redeemed_count FROM billing_coupons WHERE code = $1`,
    [code.toUpperCase()],
  );
  if (r.rows.length === 0 || !r.rows[0].active) {
    throw new ApiError(400, 'INVALID_COUPON', `Unknown or inactive coupon code: ${code}`);
  }
  const row = r.rows[0];
  if (row.max_redemptions != null && Number(row.redeemed_count) >= Number(row.max_redemptions)) {
    throw new ApiError(400, 'COUPON_EXHAUSTED', 'This coupon has reached its redemption limit');
  }
}

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
      // The event id is NOT part of the frozen provider interface, so it is
      // read from the raw payload here (both real Stripe and mock shapes
      // carry top-level `id`) for the idempotency ledger (C-01 / N-A2-6).
      let eventId: string | undefined;
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as { id?: unknown };
        if (typeof parsed.id === 'string' && parsed.id.length > 0) eventId = parsed.id;
      } catch {
        /* unsigned/invalid payloads are rejected by constructWebhookEvent */
      }
      const { deduplicated } = await applyPaymentEvent(evt, query, eventId);
      return { received: true, deduplicated };
    });
  });

  await fastify.register(async (authed) => {
    await authPlugin(authed);

    authed.post(
      '/billing/checkout',
      { schema: checkoutSchema, preHandler: requireVerifiedEmail },
      withIdempotency('billing:checkout', async (req) => {
        const { planId, interval, couponCode, trialDays } = req.body as {
          planId: string;
          interval?: 'monthly' | 'annual';
          couponCode?: string;
          trialDays?: number;
        };
        if (!isPlanId(planId)) throw new ApiError(400, 'INVALID_PLAN', `Unknown plan: ${planId}`);
        const billingInterval = interval === 'annual' ? 'annual' : 'monthly';
        // Real Stripe checkouts need a configured price; the mock provider
        // mints fake sessions and needs none for monthly. Annual billing
        // always needs its price id (even in mock mode) so the interval is
        // never silently recorded against a nonexistent price (C-01).
        const needsPrice = !getPayments().isMock || billingInterval === 'annual';
        if (needsPrice && !priceIdForPlan(planId, billingInterval)) {
          throw new ApiError(
            400,
            billingInterval === 'annual' ? 'ANNUAL_NOT_CONFIGURED' : 'PRICE_NOT_CONFIGURED',
            billingInterval === 'annual'
              ? `Annual billing is not configured for the ${planId} plan yet.`
              : `No Stripe price configured for the ${planId} plan yet.`,
          );
        }
        if (couponCode) await validateCoupon(couponCode);

        // Block double checkout when already subscribed (C-01): plan changes
        // go through the customer portal. The tenant row is locked
        // (SELECT ... FOR UPDATE) around customer creation so concurrent
        // checkouts cannot create duplicate Stripe customers (N-A1-5).
        const client = await pool.connect();
        let customerId: string | null;
        try {
          await client.query('BEGIN');
          try {
            const t = await client.query(
              `SELECT stripe_customer_id FROM tenants WHERE id = $1 FOR UPDATE`,
              [(req as any).tenant.tenantId],
            );
            customerId = t.rows[0]?.stripe_customer_id ?? null;
            const sub = await client.query(`SELECT status FROM subscriptions WHERE tenant_id = $1`, [
              (req as any).tenant.tenantId,
            ]);
            const status: string | undefined = sub.rows[0]?.status;
            if (status && ACTIVE_SUBSCRIPTION_STATUSES.includes(status)) {
              await client.query('ROLLBACK');
              throw new ApiError(
                409,
                'ALREADY_SUBSCRIBED',
                'You already have an active subscription — use the billing portal to change plans.',
                { portal: true },
              );
            }
            if (!customerId) {
              const created = await getPayments().createCustomer(
                (req as any).tenant.email,
                (req as any).tenant.tenantId,
              );
              customerId = created.customerId;
              await client.query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [
                customerId,
                (req as any).tenant.tenantId,
              ]);
            }
            await client.query('COMMIT');
          } catch (err) {
            try {
              await client.query('ROLLBACK');
            } catch {
              /* already rolled back */
            }
            throw err;
          }
        } finally {
          client.release();
        }

        const s = await getPayments().createCheckoutSession({
          customerId: customerId!,
          planId,
          successUrl: `${config.appUrl}/dashboard/billing?success=1`,
          cancelUrl: `${config.appUrl}/dashboard/billing?canceled=1`,
          metadata: {
            tenantId: (req as any).tenant.tenantId,
            interval: billingInterval,
            ...(trialDays ? { trialDays: String(trialDays) } : {}),
            ...(couponCode ? { couponCode: couponCode.toUpperCase() } : {}),
          },
        });
        return { url: s.url };
      }),
    );

    authed.get('/billing/subscription', async (req) => {
      const r = await query(
        `SELECT plan_id, status, stripe_sub_id, current_period_start, current_period_end,
                trial_ends_at, cancel_at_period_end, billing_interval, coupon_code, grace_until
         FROM subscriptions WHERE tenant_id = $1`,
        [(req as any).tenant.tenantId],
      );
      const t = await query(`SELECT plan_id, read_only FROM tenants WHERE id = $1`, [
        (req as any).tenant.tenantId,
      ]);
      if (r.rows.length > 0) {
        return { ...r.rows[0], read_only: t.rows[0]?.read_only ?? false };
      }
      return {
        plan_id: t.rows[0]?.plan_id ?? 'starter',
        status: 'none',
        read_only: t.rows[0]?.read_only ?? false,
      };
    });

    authed.get('/billing/invoices', { schema: invoicesQuerySchema }, async (req) => {
      const { page = 1, limit = 20 } = req.query as { page?: number; limit?: number };
      const offset = (page - 1) * limit;
      const tenantId = (req as any).tenant.tenantId as string;
      const [rows, count] = await Promise.all([
        query(
          `SELECT id, stripe_invoice_id, amount_due_cents, currency, status,
                  period_start, period_end, hosted_invoice_url, created_at
           FROM invoices WHERE tenant_id = $1
           ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
          [tenantId, limit, offset],
        ),
        query(`SELECT COUNT(*)::int c FROM invoices WHERE tenant_id = $1`, [tenantId]),
      ]);
      return { data: rows.rows, page, limit, total: Number(count.rows[0].c) };
    });

    authed.post('/billing/portal', async (req) => {
      const t = await query('SELECT stripe_customer_id FROM tenants WHERE id = $1', [
        (req as any).tenant.tenantId,
      ]);
      const customerId: string | null = t.rows[0]?.stripe_customer_id ?? null;
      if (!customerId) throw new ApiError(400, 'NO_CUSTOMER', 'No billing customer yet — start a checkout first');
      const s = await getPayments().createPortalSession(customerId, `${config.appUrl}/dashboard/billing`);
      return { url: s.url };
    });
  });

  // Dev/test helper: simulates a completed mock checkout (mock provider only).
  // Authenticated + tenant-scoped: the customer must belong to the caller,
  // otherwise anyone could upgrade arbitrary tenants in mock mode.
  // P0-05: the route is not registered at all in production builds.
  if (!mockBillingRoutesEnabled()) return;
  await fastify.register(async (authed) => {
    await authPlugin(authed);

    authed.get('/billing/mock-confirm', { schema: mockConfirmSchema }, async (req, reply) => {
      if (!getPayments().isMock) throw new ApiError(404, 'NOT_FOUND', 'Not found');
      const { plan, customer, interval, trial_days, coupon } = req.query as {
        session_id?: string;
        plan?: string;
        customer?: string;
        interval?: string;
        trial_days?: string;
        coupon?: string;
      };
      if (!plan || !isPlanId(plan)) throw new ApiError(400, 'INVALID_PLAN', `Unknown plan: ${plan}`);
      const t = await query('SELECT id FROM tenants WHERE id = $1 AND stripe_customer_id = $2', [
        (req as any).tenant.tenantId,
        customer ?? '',
      ]);
      if (t.rows.length === 0) throw new ApiError(403, 'FORBIDDEN', 'That checkout does not belong to your account');
      const tenantId = t.rows[0].id as string;
      await applyPaymentEvent({
        type: 'checkout.session.completed',
        data: {
          metadata: {
            tenantId,
            planId: plan,
            interval: interval === 'annual' ? 'annual' : 'monthly',
            ...(trial_days ? { trialDays: trial_days } : {}),
            ...(coupon ? { couponCode: coupon } : {}),
          },
          customer,
          subscription: `sub_mock_${Date.now()}`,
        },
      });
      return reply.redirect(`${config.appUrl}/dashboard/billing?success=1`);
    });
  });
}
