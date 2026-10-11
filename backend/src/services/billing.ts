import { query as defaultQuery, type QueryFn } from '../db.js';
import { getNotify } from '../providers/notify.js';
import { getPlan, type PlanId } from '../plans.js';

// ---------------------------------------------------------------------------
// Billing event hooks (C-01: dunning emails + grace-period lifecycle).
// Modules register handlers via onBillingEvent(); the default dunning email
// sender is wired by registerDefaultBillingHooks() at API/worker boot.
// ---------------------------------------------------------------------------

export interface BillingEvent {
  type:
    | 'invoice.payment_failed'
    | 'invoice.paid'
    | 'subscription.past_due'
    | 'subscription.downgraded'
    | 'subscription.deleted'
    | 'charge.refunded'
    | 'trial.started'
    | 'checkout.completed';
  tenantId: string;
  detail?: Record<string, unknown>;
  /**
   * G1-L-1: the originating webhook event id (stripe.ts threads it
   * through). The email-sending hook dedupes on (event_id, type) so an
   * E4-M-2 crash-retry or concurrent duplicate delivery cannot send the
   * same lifecycle email twice. Absent for direct (non-webhook) callers —
   * no dedupe there, as before.
   */
  eventId?: string;
}

export type BillingEventHook = (e: BillingEvent) => Promise<void> | void;

const billingHooks = new Set<BillingEventHook>();

/** Registers a billing-event hook; returns an unsubscribe function. */
export function onBillingEvent(hook: BillingEventHook): () => void {
  billingHooks.add(hook);
  return () => {
    billingHooks.delete(hook);
  };
}

/**
 * F1-L-3 / F2-L-4: the SINGLE definition of a "live" Stripe subscription —
 * one Stripe is (or may still be) billing for: active, trialing, past_due,
 * and incomplete (async first payment still pending/retried). Shared by
 * the checkout block (routes/billing.ts), the admin plan-override guard
 * (routes/admin.ts), and the webhook supersede/adopt guard
 * (providers/stripe.ts). Keep all three on this list — F1-M-1/F2-M-1
 * showed what happens when two "live" definitions drift apart.
 */
export const LIVE_SUBSCRIPTION_STATUSES: string[] = ['active', 'trialing', 'past_due', 'incomplete'];

/** Terminal (non-billable) subscription states: the sub is dead locally. */
export const TERMINAL_SUBSCRIPTION_STATUSES: string[] = ['canceled', 'incomplete_expired'];

/** Fires hooks best-effort (a failing hook never breaks the webhook). */
export async function emitBillingEvent(e: BillingEvent): Promise<void> {
  for (const hook of billingHooks) {
    try {
      await hook(e);
    } catch (err) {
      console.error('[billing] event hook threw', e.type, err);
    }
  }
}

/**
 * Default dunning + lifecycle emails (C-01). Sends via the notify provider
 * (real SMTP when configured, logged mock otherwise) and records the send
 * in notification_log when the table exists.
 */
export function registerDefaultBillingHooks(): void {
  onBillingEvent(async (e) => {
    const t = await defaultQuery(
      `SELECT notify_email, name FROM tenants WHERE id = $1`,
      [e.tenantId],
    );
    const to: string | null = t.rows[0]?.notify_email ?? null;
    if (!to) return; // no address on file — nothing to dun
    const name = t.rows[0]?.name ?? 'there';
    const notify = getNotify();
    const send = async (subject: string, html: string) => {
      // G1-L-1 / H2-L-1: dedupe customer lifecycle emails on (event_id,
      // type). Claim-FIRST and atomic: INSERT the 'sending' row with
      // ON CONFLICT DO NOTHING on the partial unique index — only the claim
      // winner sends. (The first G1-L-1 version did SELECT-check → send →
      // INSERT, a TOCTOU: a concurrent duplicate delivery could pass the
      // check while the first attempt was still sending.)
      // Takeover on conflict: 'sent' → skip; 'failed' or stale 'sending'
      // (>10 min — crashed mid-send) → atomic conditional UPDATE, exactly
      // one taker wins. No event id (direct callers), or a missing
      // table/event_id column → send as before (no dedupe).
      if (e.eventId) {
        try {
          const claim = await defaultQuery(
            `INSERT INTO notification_log (id, tenant_id, notification_type, channel, status, detail, event_id)
             VALUES (gen_random_uuid(), $1, $2, 'email', 'sending', $3, $4)
             ON CONFLICT (event_id, notification_type) WHERE event_id IS NOT NULL DO NOTHING
             RETURNING id`,
            [e.tenantId, e.type, subject, e.eventId],
          );
          if ((claim.rowCount ?? 0) === 0) {
            const takeover = await defaultQuery(
              `UPDATE notification_log SET status = 'sending', created_at = now()
               WHERE event_id = $1 AND notification_type = $2
                 AND (status = 'failed'
                      OR (status = 'sending' AND created_at < now() - interval '10 minutes'))`,
              [e.eventId, e.type],
            );
            if ((takeover.rowCount ?? 0) === 0) return; // 'sent' or live 'sending' — skip
          }
        } catch {
          /* table or event_id column missing → no dedupe, send as before */
        }
      }
      try {
        await notify.sendEmail(to, subject, html);
        if (e.eventId) {
          await defaultQuery(
            `UPDATE notification_log SET status = 'sent' WHERE event_id = $1 AND notification_type = $2`,
            [e.eventId, e.type],
          ).catch(() => {});
        } else {
          await defaultQuery(
            `INSERT INTO notification_log (id, tenant_id, notification_type, channel, status, detail)
             VALUES (gen_random_uuid(), $1, $2, 'email', 'sent', $3)`,
            [e.tenantId, e.type, subject],
          ).catch(() => {});
        }
      } catch (err) {
        // Mark 'failed' (not delete): a retry may still send it, and the
        // takeover rule above lets exactly one retry proceed.
        if (e.eventId) {
          await defaultQuery(
            `UPDATE notification_log SET status = 'failed', detail = $3
             WHERE event_id = $1 AND notification_type = $2`,
            [e.eventId, e.type, String((err as Error)?.message ?? err)],
          ).catch(() => {});
        } else {
          await defaultQuery(
            `INSERT INTO notification_log (id, tenant_id, notification_type, channel, status, detail)
             VALUES (gen_random_uuid(), $1, $2, 'email', 'failed', $3)`,
            [e.tenantId, e.type, String((err as Error)?.message ?? err)],
          ).catch(() => {});
        }
      }
    };
    if (e.type === 'invoice.payment_failed' || e.type === 'subscription.past_due') {
      await send(
        'Payment failed — please update your payment method',
        `<p>Hi ${name},</p><p>We couldn't charge your payment method for Beyonix SEO. ` +
          `Your plan stays fully active for a 3-day grace period. ` +
          `Please update your payment method to avoid interruption.</p>`,
      );
    } else if (e.type === 'subscription.downgraded') {
      await send(
        'Your Beyonix SEO plan was downgraded',
        `<p>Hi ${name},</p><p>Your subscription lapsed and your workspace was moved to the Starter plan. ` +
          `All of your data is intact — upgrade anytime to restore your limits.</p>`,
      );
    } else if (e.type === 'charge.refunded') {
      // K5-LOW-2 (pass#11): the amount is in minor units (cents) — format
      // it as money instead of printing raw cents ("A refund of 1000").
      const cents = Number(e.detail?.amount ?? 0);
      const cur = String(e.detail?.currency ?? 'usd').toUpperCase();
      const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(cents / 100);
      await send(
        'Refund processed',
        `<p>Hi ${name},</p><p>A refund of ${money} has been processed to your payment method.</p>`,
      );
    }
  });
}

export const GRACE_PERIOD_DAYS = 3;

/**
 * D5-H-1: server-side trial length for new signups (LA product decision,
 * 2026-10-11). The length is server-controlled — never client-supplied
 * (A1-M6 lesson). Overridable via SIGNUP_TRIAL_DAYS for ops/Mustafa.
 */
export function signupTrialDays(): number {
  const v = parseInt(process.env.SIGNUP_TRIAL_DAYS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 14;
}

/** Trial expiry timestamp for a tenant created right now. */
export function newTenantTrialEndsAt(): Date {
  return new Date(Date.now() + signupTrialDays() * 86400_000);
}

/**
 * A1-M5: recomputes tenants.read_only against a plan's site/keyword
 * limits (shared by the Stripe re-activation path and the admin plan
 * override — previously the override left read_only stale and the two
 * code paths disagreed).
 */
export async function recomputeReadOnly(
  tenantId: string,
  planId: PlanId,
  q: QueryFn = defaultQuery,
): Promise<boolean> {
  const plan = getPlan(planId);
  const sites = Number(
    (await q('SELECT COUNT(*)::int c FROM sites WHERE tenant_id=$1 AND deleted_at IS NULL', [tenantId])).rows[0].c,
  );
  const kws = Number(
    (await q('SELECT COUNT(*)::int c FROM keywords WHERE tenant_id=$1 AND tracked=TRUE', [tenantId])).rows[0].c,
  );
  const overLimit = sites > plan.max_sites || kws > plan.max_keywords_tracked;
  await q(`UPDATE tenants SET read_only = $2 WHERE id = $1`, [tenantId, overLimit]);
  return overLimit;
}

/**
 * Downgrades a tenant to starter after the grace period (C-01). Data is
 * NEVER deleted; if usage exceeds the starter limits the tenant is put in
 * read-only mode instead (mutations blocked except billing/admin/account).
 *
 * D1-H-1 / D5-M-2: the local subscription status is reconciled with Stripe,
 * not blindly written. 'canceled' is reserved for genuine Stripe-side
 * termination (customer.subscription.deleted / canceled|incomplete_expired
 * updates). A grace-expiry downgrade keeps 'past_due' (grace consumed) —
 * the Stripe subscription is still alive and Smart Retrying — so that
 * (a) the checkout ALREADY_SUBSCRIBED block keeps rejecting a second
 *     subscription (no double-billing path), and
 * (b) a later successful retry's invoice.paid recovery still matches the
 *     row and revives the paid plan instead of stranding a payer on
 *     Starter.
 */
export async function downgradeTenant(
  tenantId: string,
  reason: string,
  q: QueryFn = defaultQuery,
  opts: { subscriptionStatus?: 'canceled' | 'past_due'; eventId?: string } = {},
): Promise<{ readOnly: boolean }> {
  const starter = getPlan('starter');
  const sites = Number(
    (await q('SELECT COUNT(*)::int c FROM sites WHERE tenant_id = $1 AND deleted_at IS NULL', [tenantId])).rows[0].c,
  );
  const kws = Number(
    (await q('SELECT COUNT(*)::int c FROM keywords WHERE tenant_id = $1 AND tracked = TRUE', [tenantId])).rows[0].c,
  );
  const overLimit = sites > starter.max_sites || kws > starter.max_keywords_tracked;
  await q(`UPDATE tenants SET plan_id = 'starter', read_only = $2 WHERE id = $1`, [tenantId, overLimit]);
  const statusAfter = opts.subscriptionStatus ?? 'canceled';
  if (statusAfter === 'past_due') {
    // Grace consumed, but the Stripe subscription may still be retrying:
    // keep past_due and clear the (expired) grace marker. invoice.payment_failed
    // for a consumed-grace row does NOT mint a fresh grace (see stripe.ts),
    // so failed retries can't restart the dunning cycle.
    await q(`UPDATE subscriptions SET status = 'past_due', grace_until = NULL WHERE tenant_id = $1`, [
      tenantId,
    ]);
  } else {
    await q(`UPDATE subscriptions SET status = 'canceled', grace_until = NULL WHERE tenant_id = $1`, [
      tenantId,
    ]);
  }
  await emitBillingEvent({
    type: 'subscription.downgraded',
    tenantId,
    detail: { reason, readOnly: overLimit },
    eventId: opts.eventId,
  });
  return { readOnly: overLimit };
}

/**
 * Daily billing job (C-01): downgrades past_due subscriptions whose grace
 * period has expired. Called from the scheduler; safe to run often (the
 * WHERE clause only matches expired grace rows).
 *
 * D5-L-4: per-tenant try/catch — one tenant's failure (DB hiccup, hook
 * failure) must not abort the whole run and delay everyone behind it.
 *
 * D1-H-1: grace expiry downgrades the PRODUCT to starter but keeps the
 * local subscription 'past_due' (Stripe is still retrying) — see
 * downgradeTenant.
 */
export async function processBillingGrace(q: QueryFn = defaultQuery): Promise<number> {
  const r = await q(
    `SELECT tenant_id FROM subscriptions
     WHERE status = 'past_due' AND grace_until IS NOT NULL AND grace_until < now()`,
  );
  let n = 0;
  for (const row of r.rows) {
    try {
      await downgradeTenant(row.tenant_id as string, 'grace_expired', q, { subscriptionStatus: 'past_due' });
      n += 1;
    } catch (err) {
      console.error('[billing] processBillingGrace: downgrade failed for tenant', row.tenant_id, err);
    }
  }
  return n;
}

/** Grace deadline for a newly past_due subscription (C-01). */
export function graceDeadline(): Date {
  return new Date(Date.now() + GRACE_PERIOD_DAYS * 86400_000);
}
