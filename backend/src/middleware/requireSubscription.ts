// D5-H-1: trial/subscription gate for paid/spend routes.
//
// LA product decision (2026-10-11): every new signup gets a SERVER-SIDE
// 14-day trial (tenants.trial_ends_at, set at signup in routes/auth.ts)
// with Starter quota. While the trial is live — or a subscription is
// active/trialing/past_due/incomplete — paid features work. After the trial
// expires with no live subscription, spend routes 402 and the tenant is
// flipped read-only (the existing read-only machinery then blocks
// mutations; billing/account/auth routes stay open so the user can
// subscribe).
//
// NULL trial_ends_at = grandfathered (pre-trial tenants: seed/demo/existing
// rows backfilled far-future by migration 044). A tenant whose trial is
// live but unverified is still blocked earlier by requireVerifiedEmail —
// wire this AFTER requireVerifiedEmail in the preHandler chain.
//
// Wiring (preHandler arrays — add alongside requireVerifiedEmail):
//   keywords.ts, ranks.ts, content.ts, geo.ts, audit.ts, reports.ts,
//   competitors.ts, backlinks.ts (all routes carrying requireVerifiedEmail
//   for paid use), e.g.
//     preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, ...]
// Do NOT add to /billing/checkout or /billing/portal — those are how an
// expired-trial user subscribes.
import type { FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import { query } from '../db.js';

/** Subscription states that keep paid features enabled (incl. 3-day grace).
 * E4-M-1: 'incomplete' is NOT billable here — an incomplete subscription
 * means the first payment never succeeded (async payment pending). Counting
 * it as billable enables rolling free access via never-funded checkouts.
 * ('incomplete' stays in the dunning/grace logic and the checkout block
 * list, where it belongs.) */
export const BILLABLE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'];

/** Fastify preHandler: use on routes that spend provider budget or money. */
export async function requireActiveSubscriptionOrTrial(req: FastifyRequest): Promise<void> {
  const tenantId = (req as any).tenant?.tenantId as string | undefined;
  if (!tenantId) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Not authenticated');
  }
  const r = await query(
    `SELECT t.trial_ends_at, t.read_only, s.status AS sub_status
     FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id
     WHERE t.id = $1`,
    [tenantId],
  );
  const row = r.rows[0];
  if (!row) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Unknown tenant');
  }
  if (BILLABLE_SUBSCRIPTION_STATUSES.includes(row.sub_status as string)) return;
  // NULL trial_ends_at = grandfathered pre-trial tenant (migration 044).
  const trialEnds: Date | null = row.trial_ends_at ? new Date(row.trial_ends_at) : null;
  if (trialEnds === null || trialEnds.getTime() > Date.now()) return;
  // Trial expired and no live subscription: mark read-only (existing
  // machinery blocks mutations from here) and fail with an honest 402.
  if (!row.read_only) {
    await query(`UPDATE tenants SET read_only = TRUE WHERE id = $1`, [tenantId]);
  }
  throw new ApiError(
    402,
    'SUBSCRIPTION_REQUIRED',
    'Your free trial has ended — subscribe to keep using paid features.',
  );
}
