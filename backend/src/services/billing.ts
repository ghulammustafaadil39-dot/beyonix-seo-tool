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
      try {
        await notify.sendEmail(to, subject, html);
        await defaultQuery(
          `INSERT INTO notification_log (id, tenant_id, notification_type, channel, status, detail)
           VALUES (gen_random_uuid(), $1, $2, 'email', 'sent', $3)`,
          [e.tenantId, e.type, subject],
        ).catch(() => {});
      } catch (err) {
        await defaultQuery(
          `INSERT INTO notification_log (id, tenant_id, notification_type, channel, status, detail)
           VALUES (gen_random_uuid(), $1, $2, 'email', 'failed', $3)`,
          [e.tenantId, e.type, String((err as Error)?.message ?? err)],
        ).catch(() => {});
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
      await send(
        'Refund processed',
        `<p>Hi ${name},</p><p>A refund of ${e.detail?.amount ?? ''} has been processed to your payment method.</p>`,
      );
    }
  });
}

const GRACE_PERIOD_DAYS = 3;

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
 */
export async function downgradeTenant(
  tenantId: string,
  reason: string,
  q: QueryFn = defaultQuery,
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
  await q(
    `UPDATE subscriptions SET status = 'canceled', grace_until = NULL WHERE tenant_id = $1`,
    [tenantId],
  );
  await emitBillingEvent({ type: 'subscription.downgraded', tenantId, detail: { reason, readOnly: overLimit } });
  return { readOnly: overLimit };
}

/**
 * Daily billing job (C-01): downgrades past_due subscriptions whose grace
 * period has expired. Called from the scheduler; safe to run often (the
 * WHERE clause only matches expired grace rows).
 */
export async function processBillingGrace(q: QueryFn = defaultQuery): Promise<number> {
  const r = await q(
    `SELECT tenant_id FROM subscriptions
     WHERE status = 'past_due' AND grace_until IS NOT NULL AND grace_until < now()`,
  );
  let n = 0;
  for (const row of r.rows) {
    await downgradeTenant(row.tenant_id as string, 'grace_expired', q);
    n += 1;
  }
  return n;
}

/** Grace deadline for a newly past_due subscription (C-01). */
export function graceDeadline(): Date {
  return new Date(Date.now() + GRACE_PERIOD_DAYS * 86400_000);
}
