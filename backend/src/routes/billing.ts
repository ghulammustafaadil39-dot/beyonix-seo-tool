import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pool, query } from '../db.js';
import { ApiError } from '../errors.js';
import { authPlugin } from '../middleware/auth.js';
import { requireRoleOrScope, requireScope } from '../middleware/access.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import {
  applyPaymentEvent,
  getPayments,
  mockBillingRoutesEnabled,
  priceIdForPlan,
  stripeCouponIdFor,
} from '../providers/stripe.js';
import { getPlan, isPlanId } from '../plans.js';
import { LIVE_SUBSCRIPTION_STATUSES } from '../services/billing.js';

const checkoutSchema = {
  body: {
    type: 'object',
    required: ['planId'],
    properties: {
      planId: { type: 'string' },
      interval: { type: 'string', enum: ['monthly', 'annual'] },
      couponCode: { type: 'string', maxLength: 64 },
      // A1-M6: trial length is server-side (plans.ts trial_days); the
      // client must not control it. Unknown properties are rejected by
      // additionalProperties: false.
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

// Single live-subscription definition (F1-M-1/F2-M-1: do not fork this
// list — services/billing.ts owns it).
const ACTIVE_SUBSCRIPTION_STATUSES: string[] = LIVE_SUBSCRIPTION_STATUSES;
// D1-H-1: 'past_due' MUST stay in this list (and grace-expiry downgrades
// must keep the local row 'past_due' — see downgradeTenant). A past_due
// Stripe subscription is still alive and retrying; letting checkout through
// would create a SECOND Stripe subscription = real double billing.
// E4-H-2: 'incomplete' MUST stay too — an incomplete Stripe subscription is
// alive (auto-retries / expires after 23h). The correct recovery for a failed
// first payment is the billing portal's open-invoice payment, not a second
// subscription (which webhook clobbering would then corrupt).

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

/**
 * A2-L5: maps a local coupon code to the real Stripe coupon id.
 *
 * C5-H-1 / C1-M-6: the redemption slot is RESERVED atomically in a short
 * locked transaction BEFORE the Stripe discount is attached to the
 * session. The conditional UPDATE increments reserved_count only when
 * redeemed+reserved is still under max_redemptions, so N concurrent
 * checkouts can never overshoot the cap (the old lock-free validateCoupon
 * let every checkout through and only capped the local counter later,
 * after Stripe had already granted the discounts). Slots are released on
 * checkout.session.expired and converted to redeemed_count on
 * checkout.session.completed.
 *
 * D5-L-5: the coupon row lock is NEVER held across the Stripe network call
 * (B1-10 lesson). The definition is read unlocked, the Stripe coupon is
 * ensured first (idempotent by deterministic id, so a concurrent duplicate
 * create just retrieves), and only then is the atomic reserve run in a
 * short transaction. The reserve re-checks active/cap under the lock, so
 * the unlocked pre-reads are safe.
 */
async function resolveStripeCoupon(code: string): Promise<string> {
  const upper = code.toUpperCase();
  // Unlocked definition read (no lock held yet).
  const def = await query(
    `SELECT percent_off, amount_off_cents, duration, stripe_coupon_id, active
     FROM billing_coupons WHERE code = $1`,
    [upper],
  );
  const row0 = def.rows[0];
  if (!row0 || !row0.active) {
    throw new ApiError(400, 'INVALID_COUPON', `Unknown or inactive coupon code: ${code}`);
  }
  if (row0.stripe_coupon_id) {
    return reserveCouponSlot(upper, row0.stripe_coupon_id as string, code);
  }
  // C1-L-3: collision guard — with the hash-suffixed namespace
  // (C5-M-6) this is near-impossible, but a collision must fail loudly,
  // never silently attach another code's discount.
  const candidateId = stripeCouponIdFor(upper);
  const clash = await query(`SELECT code FROM billing_coupons WHERE stripe_coupon_id = $1 AND code <> $2`, [
    candidateId,
    upper,
  ]);
  if (clash.rows.length > 0) {
    throw new ApiError(
      409,
      'COUPON_ID_COLLISION',
      `Coupon ${upper} collides with ${clash.rows[0].code} in the Stripe namespace — refusing to attach a discount`,
    );
  }
  // No row lock held across this network call. If the reserve below then
  // fails (cap hit / deactivated in the meantime), the Stripe coupon is
  // orphaned — bounded, and idempotent on retry (retrieve returns it).
  const stripeId = await getPayments().ensureCoupon({
    code: upper,
    percentOff: row0.percent_off as number | null,
    amountOffCents: row0.amount_off_cents as number | null,
    duration: row0.duration as string,
  });
  return reserveCouponSlot(upper, stripeId, code);
}

/** Atomic check-and-reserve under the coupon row lock (short transaction). */
async function reserveCouponSlot(upper: string, stripeId: string, code: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      // Atomic check-and-reserve under the row lock: 0 rows means the
      // coupon is unknown, inactive, or the cap is already fully reserved.
      const r = await client.query(
        `UPDATE billing_coupons
         SET reserved_count = reserved_count + 1, stripe_coupon_id = $2
         WHERE code = $1 AND active
           AND (max_redemptions IS NULL OR redeemed_count + reserved_count < max_redemptions)
         RETURNING 1`,
        [upper, stripeId],
      );
      if (r.rows.length === 0) {
        const why = await client.query(
          `SELECT active, max_redemptions, redeemed_count, reserved_count
           FROM billing_coupons WHERE code = $1`,
          [upper],
        );
        await client.query('ROLLBACK');
        const row = why.rows[0];
        if (!row || !row.active) {
          throw new ApiError(400, 'INVALID_COUPON', `Unknown or inactive coupon code: ${code}`);
        }
        throw new ApiError(400, 'COUPON_EXHAUSTED', 'This coupon has reached its redemption limit');
      }
      await client.query('COMMIT');
      return stripeId;
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
      let eventCreated: number | undefined;
      try {
        const parsed = JSON.parse(raw.toString('utf8')) as { id?: unknown; created?: unknown };
        if (typeof parsed.id === 'string' && parsed.id.length > 0) eventId = parsed.id;
        // C-01 ordering guard: thread Stripe's top-level `created` through
        // (the frozen provider interface drops it from the parsed event).
        if (typeof parsed.created === 'number' && parsed.created > 0) eventCreated = parsed.created;
        // C5-L-4: a mock payload without a top-level id was replayable
        // within the tolerance window. Derive a deterministic synthetic id
        // from the payload hash so identical replays hit the idempotency
        // ledger instead of being applied twice.
        if (!eventId && getPayments().isMock) {
          const { createHash } = await import('node:crypto');
          eventId = `mock-payload:${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
        }
      } catch {
        /* unsigned/invalid payloads are rejected by constructWebhookEvent */
      }
      const { deduplicated } = await applyPaymentEvent({ ...evt, created: eventCreated }, query, eventId);
      return { received: true, deduplicated };
    });
  });

  await fastify.register(async (authed) => {
    await authPlugin(authed);

    authed.post(
      '/billing/checkout',
      { schema: checkoutSchema, preHandler: requireVerifiedEmail },
      withIdempotency('billing:checkout', async (req) => {
        const { planId, interval, couponCode } = req.body as {
          planId: string;
          interval?: 'monthly' | 'annual';
          couponCode?: string;
        };
        // A1-M6: trial length comes from the server-side plan config, never
        // from the request body.
        const trialDays = getPlan(planId).trial_days;
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
        // A2-L5: resolve the local code to the Stripe coupon id up-front —
        // the raw local code is never sent to Stripe as a coupon id.
        // D5-M-3: resolveStripeCoupon rolls back its reservation when it
        // fails, so the catch below must release ONLY when the reservation
        // actually committed — tracked by couponReserved, never by
        // assumption.
        let couponReserved = false;
        const stripeCouponId = couponCode ? await resolveStripeCoupon(couponCode) : null;
        if (couponCode && stripeCouponId) couponReserved = true;

        // Block double checkout when already subscribed (C-01): plan changes
        // go through the customer portal.
        //
        // B1-10: NEVER hold the tenant row lock across the Stripe network
        // call. The customer is created BEFORE the transaction; inside, the
        // row is re-read under FOR UPDATE and the winner's id is adopted on
        // a race (a loser-created Stripe customer stays orphaned — bounded
        // and logged; the old code additionally serialized ALL concurrent
        // billing mutations for the tenant on Stripe latency).
        const tenantId = (req as any).tenant.tenantId as string;
        // C5-H-1: a coupon slot was reserved above; if anything below fails
        // before the Stripe session is created, release the hold so the
        // cap isn't burned by failed checkouts.
        const releaseReservation = async () => {
          if (!couponCode) return;
          await query(
            `UPDATE billing_coupons SET reserved_count = GREATEST(reserved_count - 1, 0) WHERE code = $1`,
            [couponCode.toUpperCase()],
          ).catch(() => undefined);
        };
        try {
          const preRead = await query(`SELECT stripe_customer_id FROM tenants WHERE id = $1`, [tenantId]);
          let customerId: string | null = (preRead.rows[0]?.stripe_customer_id as string | null) ?? null;
          if (!customerId) {
            const created = await getPayments().createCustomer((req as any).tenant.email, tenantId);
            customerId = created.customerId;
          }
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            try {
              const t = await client.query(`SELECT stripe_customer_id FROM tenants WHERE id = $1 FOR UPDATE`, [tenantId]);
              const existing: string | null = (t.rows[0]?.stripe_customer_id as string | null) ?? null;
              // E4-M-4: ignore admin-override rows (stripe_sub_id IS NULL) —
              // a comped tenant must be able to start a real subscription.
              const sub = await client.query(`SELECT status, stripe_sub_id FROM subscriptions WHERE tenant_id = $1`, [tenantId]);
              const status: string | undefined = sub.rows[0]?.status;
              const hasStripeSub = !!sub.rows[0]?.stripe_sub_id;
              if (status && hasStripeSub && ACTIVE_SUBSCRIPTION_STATUSES.includes(status)) {
                await client.query('ROLLBACK');
                throw new ApiError(
                  409,
                  'ALREADY_SUBSCRIBED',
                  'You already have an active subscription — use the billing portal to change plans.',
                  { portal: true },
                );
              }
              if (existing) {
                // A concurrent checkout won the race — adopt their customer id.
                // Ours (created above) is orphaned in Stripe; bounded to one
                // per race and surfaced in logs for manual cleanup.
                if (existing !== customerId) {
                  console.warn(`[billing] checkout race: adopting existing customer for tenant ${tenantId}`);
                  customerId = existing;
                }
              } else {
                await client.query(`UPDATE tenants SET stripe_customer_id = $1 WHERE id = $2`, [customerId, tenantId]);
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
              ...(stripeCouponId ? { stripeCouponId } : {}),
            },
          });
          return { url: s.url };
        } catch (err) {
          // D5-M-3: release exactly once — only when the reservation
          // committed (couponReserved) and the session was never created.
          if (couponReserved) await releaseReservation();
          throw err;
        }
      }),
    );

    // B1-M1: billing reads need billing:read for API keys (sessions pass).
    authed.get('/billing/subscription', { preHandler: requireScope('billing:read') }, async (req) => {
      const r = await query(
        `SELECT plan_id, status, stripe_sub_id, current_period_start, current_period_end,
                trial_ends_at, cancel_at_period_end, billing_interval, coupon_code, grace_until
         FROM subscriptions WHERE tenant_id = $1`,
        [(req as any).tenant.tenantId],
      );
      // E3-MED-1: include the server-side trial expiry so the frontend can
      // show a trial countdown (not just Stripe's trialing status).
      const t = await query(`SELECT plan_id, read_only, trial_ends_at AS tenant_trial_ends_at FROM tenants WHERE id = $1`, [
        (req as any).tenant.tenantId,
      ]);
      if (r.rows.length > 0) {
        return { ...r.rows[0], read_only: t.rows[0]?.read_only ?? false, tenant_trial_ends_at: t.rows[0]?.tenant_trial_ends_at ?? null };
      }
      return {
        plan_id: t.rows[0]?.plan_id ?? 'starter',
        status: 'none',
        read_only: t.rows[0]?.read_only ?? false,
        tenant_trial_ends_at: t.rows[0]?.tenant_trial_ends_at ?? null,
      };
    });

    authed.get('/billing/invoices', { schema: invoicesQuerySchema, preHandler: requireScope('billing:read') }, async (req) => {
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

    // B1-M2: the portal URL grants full billing management (cancel, plan
    // changes, payment method). Dual gate: human sessions need owner/admin;
    // API keys need the billing:write scope. Previously ANY valid API key
    // (even sites:read-only) could mint a portal session.
    authed.post('/billing/portal', { preHandler: requireRoleOrScope(['owner', 'admin'], 'billing:write') }, async (req) => {
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
      // D1-L-1 (mock-only known limitation): abandoned mock checkouts leak
      // coupon reserved_count (no checkout.session.expired webhook in mock
      // mode). Dev/test only — production Stripe fires the expiry webhook
      // which releases the hold.
      const { plan, customer, interval, coupon } = req.query as {
        session_id?: string;
        plan?: string;
        customer?: string;
        interval?: string;
        coupon?: string;
      };
      // A1-M6: the trial length is server-side (plan config). The old code
      // read trial_days from the (user-tamperable) mock-confirm querystring.
      const trial_days = String(getPlan(plan as string).trial_days || '');
      if (!plan || !isPlanId(plan)) throw new ApiError(400, 'INVALID_PLAN', `Unknown plan: ${plan}`);
      const t = await query('SELECT id FROM tenants WHERE id = $1 AND stripe_customer_id = $2', [
        (req as any).tenant.tenantId,
        customer ?? '',
      ]);
      if (t.rows.length === 0) throw new ApiError(403, 'FORBIDDEN', 'That checkout does not belong to your account');
      const tenantId = t.rows[0].id as string;
      const { session_id } = req.query as { session_id?: string };
      // C1-L-2: route the event through the webhook idempotency ledger with
      // a synthetic event id — re-visiting the mock-confirm URL replays the
      // SAME session id and becomes a deduplicated no-op instead of
      // double-redeeming the coupon and re-emitting billing events.
      const eventId = session_id ? `mock-confirm:${session_id}` : `mock-confirm:${Date.now()}`;
      await applyPaymentEvent(
        {
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
        },
        query,
        eventId,
      );
      return reply.redirect(`${config.appUrl}/dashboard/billing?success=1`);
    });
  });
}
