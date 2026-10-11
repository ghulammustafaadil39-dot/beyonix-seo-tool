import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { query } from '../db.js';
import { ApiError, validationError } from '../errors.js';
import { authPlugin, signToken } from '../middleware/auth.js';
import { logAdminAction, requirePlatformAdmin } from '../middleware/access.js';
import { createSession } from '../services/sessions.js';
import { paginate, assertUuid } from '../pagination.js';
import { isPlanId, type PlanId } from '../plans.js';
import { getProviderSpend } from '../metering.js';
import { getPayments } from '../providers/stripe.js';
import { enqueue } from '../queues.js';
import { logActivity } from '../services/activityLog.js';

/**
 * F-14: admin back-office. Every route requires platform-admin
 * (users.is_platform_admin) and every action writes to admin_audit_log
 * (SECURITY-SENSITIVE — Security Lead review required).
 */

const suspendSchema = {
  body: {
    type: 'object',
    required: ['reason'],
    properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } },
    additionalProperties: false,
  },
} as const;

const planOverrideSchema = {
  body: {
    type: 'object',
    required: ['planId', 'reason'],
    properties: {
      planId: { type: 'string' },
      reason: { type: 'string', minLength: 3, maxLength: 500 },
    },
    additionalProperties: false,
  },
} as const;

const creditSchema = {
  body: {
    type: 'object',
    required: ['amountCents', 'reason'],
    properties: {
      amountCents: { type: 'integer', minimum: 1, maximum: 100_000_00 },
      reason: { type: 'string', minLength: 3, maxLength: 500 },
    },
    additionalProperties: false,
  },
} as const;

const impersonateSchema = {
  body: {
    type: 'object',
    required: ['tenantId'],
    properties: { tenantId: { type: 'string' } },
    additionalProperties: false,
  },
} as const;

const flagSchema = {
  body: {
    type: 'object',
    required: ['enabled'],
    properties: {
      enabled: { type: 'boolean' },
      description: { type: 'string', maxLength: 500 },
    },
    additionalProperties: false,
  },
} as const;

export async function registerAdminRoutes(fastify: FastifyInstance) {
  await fastify.register(async (admin) => {
    await authPlugin(admin);
    admin.addHook('preHandler', requirePlatformAdmin);

    // ---- Tenants ----
    admin.get('/admin/tenants', async (req) => {
      const { page, limit, offset } = paginate(req);
      const search = ((req.query as any).search as string | undefined)?.trim() ?? '';
      const conds: string[] = [];
      const params: unknown[] = [];
      if (search) {
        params.push(`%${search}%`);
        conds.push(`(t.name ILIKE $${params.length} OR t.id::text ILIKE $${params.length})`);
      }
      const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
      const [rows, count] = await Promise.all([
        query(
          `SELECT t.id, t.name, t.plan_id, t.read_only, t.suspended_at, t.created_at,
                  s.status AS sub_status, s.current_period_end,
                  (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id) AS users,
                  (SELECT COUNT(*)::int FROM sites s2 WHERE s2.tenant_id = t.id AND s2.deleted_at IS NULL) AS sites
           FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id
           ${where} ORDER BY t.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset],
        ),
        query(`SELECT COUNT(*)::int c FROM tenants t ${where}`, params),
      ]);
      return { data: rows.rows, page, limit, total: Number(count.rows[0].c) };
    });

    admin.get('/admin/tenants/:id', async (req) => {
      const id = assertUuid((req.params as any).id, 'tenant id');
      // A1-M7: explicit column list — NEVER return llm_api_key_enc (the
      // encrypted BYOK key). Encrypted secrets must not leave the API
      // (mirrors toSettings' llm_key_set boolean in routes/settings.ts).
      const t = await query(
        `SELECT t.id, t.name, t.plan_id, t.stripe_customer_id, t.llm_provider,
                (t.llm_api_key_enc IS NOT NULL) AS llm_key_set,
                t.notify_email, t.telegram_chat_id, t.created_at, t.read_only,
                t.suspended_at, t.suspended_reason, t.llm_cost_cap_words,
                s.stripe_sub_id, s.status AS sub_status, s.current_period_start,
                s.current_period_end, s.trial_ends_at, s.grace_until, s.billing_interval, s.coupon_code
         FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id WHERE t.id = $1`,
        [id],
      );
      if (t.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Tenant not found');
      const [users, spend, credits] = await Promise.all([
        query(`SELECT id, email, name, role, created_at FROM users WHERE tenant_id = $1 ORDER BY created_at`, [id]),
        getProviderSpend(id, {}),
        query(`SELECT COALESCE(SUM(amount_cents),0)::int AS total FROM tenant_credits WHERE tenant_id = $1`, [id]),
      ]);
      return { ...t.rows[0], users: users.rows, spend, credits_cents: Number(credits.rows[0].total) };
    });

    admin.post('/admin/tenants/:id/suspend', { schema: suspendSchema }, async (req) => {
      const id = assertUuid((req.params as any).id, 'tenant id');
      const { reason } = req.body as { reason: string };
      const r = await query(
        `UPDATE tenants SET suspended_at = now(), suspended_reason = $2 WHERE id = $1 AND suspended_at IS NULL
         RETURNING stripe_customer_id`,
        [id, reason],
      );
      if ((r.rowCount ?? 0) === 0) throw new ApiError(404, 'NOT_FOUND', 'Tenant not found or already suspended');
      // D5-L-2: a suspended tenant is fully blocked, so pause Stripe billing
      // too — otherwise the suspended tenant keeps being charged. Best
      // effort: a Stripe outage must not block the suspend itself.
      // E4-M-5: surface pause failures — billingPaused: [] is ambiguous
      // (could mean "nothing to pause" or "pause failed").
      const customerId = (r.rows[0]?.stripe_customer_id as string | null) ?? null;
      let paused: string[] = [];
      let billingPauseFailed = false;
      if (customerId) {
        try {
          paused = (await getPayments().pauseSubscription(customerId)).paused;
        } catch (e) {
          billingPauseFailed = true;
          console.error('[admin] suspend: pauseSubscription failed', { tenantId: id, err: (e as Error).message });
        }
      }
      await logAdminAction(req, 'tenant.suspend', id, { reason, billingPaused: paused, billingPauseFailed });
      return { ok: true, billingPaused: paused, billingPauseFailed };
    });

    admin.post('/admin/tenants/:id/unsuspend', async (req) => {
      const id = assertUuid((req.params as any).id, 'tenant id');
      const r = await query(
        `UPDATE tenants SET suspended_at = NULL, suspended_reason = NULL WHERE id = $1 AND suspended_at IS NOT NULL
         RETURNING stripe_customer_id`,
        [id],
      );
      if ((r.rowCount ?? 0) === 0) throw new ApiError(404, 'NOT_FOUND', 'Tenant not found or not suspended');
      // D5-L-2: resume the billing that suspend paused.
      const customerId = (r.rows[0]?.stripe_customer_id as string | null) ?? null;
      let resumed: string[] = [];
      if (customerId) {
        try {
          resumed = (await getPayments().resumeSubscription(customerId)).resumed;
        } catch (e) {
          console.error('[admin] unsuspend: resumeSubscription failed', { tenantId: id, err: (e as Error).message });
        }
      }
      await logAdminAction(req, 'tenant.unsuspend', id, { billingResumed: resumed });
      return { ok: true, billingResumed: resumed };
    });

    admin.post('/admin/tenants/:id/plan', { schema: planOverrideSchema }, async (req) => {
      const id = assertUuid((req.params as any).id, 'tenant id');
      const { planId, reason } = req.body as { planId: string; reason: string };
      if (!isPlanId(planId)) throw validationError(`Unknown plan: ${planId}`);
      // Manual override: changes OUR plan record without touching Stripe
      // (for comps, migrations, support).
      // A1-M5: the old code only updated tenants.plan_id — a tenant stuck in
      // read_only (from a past downgrade) stayed read-only, and the
      // subscriptions row lingered 'canceled' (which getBillingWindow then
      // read as the usage window). Recompute read_only against the new
      // plan's limits (same check as the Stripe re-activation path) and sync
      // the subscriptions row so it reflects the override instead of a
      // stale canceled subscription. A future real Stripe event upserts ON
      // CONFLICT (tenant_id) and cleanly supersedes this manual row.
      await query(`UPDATE tenants SET plan_id = $2 WHERE id = $1`, [id, planId satisfies PlanId]);
      const { recomputeReadOnly } = await import('../services/billing.js');
      const overLimit = await recomputeReadOnly(id, planId, query);
      await query(
        `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, plan_id, status,
                                    current_period_start, current_period_end)
         VALUES (gen_random_uuid(), $1, NULL, $2, 'active', now(), now() + interval '30 days')
         ON CONFLICT (tenant_id) DO UPDATE SET
           plan_id = EXCLUDED.plan_id, status = 'active', stripe_sub_id = NULL,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end = EXCLUDED.current_period_end,
           grace_until = NULL, trial_ends_at = NULL`,
        [id, planId satisfies PlanId],
      );
      await logAdminAction(req, 'tenant.plan_override', id, { planId, reason, readOnly: overLimit });
      await logActivity(id, {
        userId: (req as any).tenant.apiKeyId ? null : (req as any).tenant.userId,
        action: 'plan.overridden',
        meta: { planId, reason, by: 'platform_admin' },
      });
      return { ok: true, planId };
    });

    admin.post('/admin/tenants/:id/credit', { schema: creditSchema }, async (req) => {
      const id = assertUuid((req.params as any).id, 'tenant id');
      const { amountCents, reason } = req.body as { amountCents: number; reason: string };
      const t = await query(`SELECT id FROM tenants WHERE id = $1`, [id]);
      if (t.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Tenant not found');
      const r = await query(
        `INSERT INTO tenant_credits (id, tenant_id, amount_cents, reason, applied_by)
         VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id, amount_cents, reason, created_at`,
        [id, amountCents, reason, (req as any).tenant.userId],
      );
      await logAdminAction(req, 'tenant.credit', id, { amountCents, reason });
      return r.rows[0];
    });

    // ---- Impersonation (WITH audit log, F-14) ----
    admin.post('/admin/impersonate', { schema: impersonateSchema }, async (req) => {
      const tenantId = assertUuid((req.body as any).tenantId, 'tenantId');
      const target = await query(
        `SELECT u.id, u.token_version, t.suspended_at
         FROM users u JOIN tenants t ON t.id = u.tenant_id
         WHERE u.tenant_id = $1 AND u.role = 'owner' ORDER BY u.created_at ASC LIMIT 1`,
        [tenantId],
      );
      if (target.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Tenant has no owner user');
      if (target.rows[0].suspended_at) throw new ApiError(403, 'TENANT_SUSPENDED', 'Tenant is suspended');
      const row = target.rows[0];
      // Short-lived (5 min) token as the tenant owner. Every use is
      // attributable via the audit row below; the session is registered so
      // per-session revocation keeps working (S-05).
      const token = signToken(row.id as string, tenantId, Number(row.token_version ?? 0), {
        expiresIn: '5m',
      });
      const decoded = jwt.decode(token) as { jti?: string } | null;
      if (decoded?.jti) await createSession(row.id as string, decoded.jti, 'admin-impersonation');
      await logAdminAction(req, 'impersonate', tenantId, { asUserId: row.id });
      return { token, tenantId, expiresInSec: 300 };
    });

    // ---- Failed jobs (DLQ) ----
    admin.get('/admin/jobs/failed', async (req) => {
      const { page, limit, offset } = paginate(req);
      const status = (req.query as any).status as string | undefined;
      const statusFilter = status && ['pending', 'replayed', 'discarded'].includes(status) ? status : null;
      const [rows, count] = await Promise.all([
        query(
          `SELECT d.id, d.queue, d.job_name, d.tenant_id, d.payload, d.attempts,
                  d.error, d.status, d.failed_at, t.name AS tenant_name
           FROM dead_letter_jobs d LEFT JOIN tenants t ON t.id = d.tenant_id
           ${statusFilter ? 'WHERE d.status = $3' : ''} ORDER BY d.failed_at DESC LIMIT $1 OFFSET $2`,
          statusFilter ? [limit, offset, statusFilter] : [limit, offset],
        ),
        query(
          `SELECT COUNT(*)::int c FROM dead_letter_jobs ${statusFilter ? 'WHERE status = $1' : ''}`,
          statusFilter ? [statusFilter] : [],
        ),
      ]);
      return { data: rows.rows, page, limit, total: Number(count.rows[0].c) };
    });

    admin.post('/admin/jobs/failed/:id/replay', async (req) => {
      const id = assertUuid((req.params as any).id, 'job id');
      const r = await query(`SELECT * FROM dead_letter_jobs WHERE id = $1 AND status = 'pending'`, [id]);
      if (r.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Dead-letter job not found');
      const dl = r.rows[0];
      await enqueue(dl.queue as string, dl.job_name as string, dl.payload as Record<string, unknown>, {
        rateLimit: false,
      });
      await query(`UPDATE dead_letter_jobs SET status = 'replayed', replayed_at = now() WHERE id = $1`, [id]);
      await logAdminAction(req, 'job.replay', dl.tenant_id as string, { jobId: id, queue: dl.queue });
      return { ok: true };
    });

    admin.post('/admin/jobs/failed/:id/discard', async (req) => {
      const id = assertUuid((req.params as any).id, 'job id');
      const r = await query(
        `UPDATE dead_letter_jobs SET status = 'discarded' WHERE id = $1 AND status = 'pending'`,
        [id],
      );
      if ((r.rowCount ?? 0) === 0) throw new ApiError(404, 'NOT_FOUND', 'Dead-letter job not found');
      await logAdminAction(req, 'job.discard', null, { jobId: id });
      return { ok: true };
    });

    // ---- Provider spend ----
    admin.get('/admin/spend', async (req) => {
      const { page, limit, offset } = paginate(req);
      const [rows, count, totals] = await Promise.all([
        query(
          `SELECT p.tenant_id, t.name AS tenant_name, p.provider,
                  SUM(p.units)::int AS units, SUM(p.cost_cents)::int AS cost_cents,
                  MAX(p.created_at) AS last_spend_at
           FROM provider_spend p JOIN tenants t ON t.id = p.tenant_id
           GROUP BY p.tenant_id, t.name, p.provider
           ORDER BY cost_cents DESC LIMIT $1 OFFSET $2`,
          [limit, offset],
        ),
        query(`SELECT COUNT(*)::int c FROM (SELECT DISTINCT tenant_id, provider FROM provider_spend) s`),
        query(
          `SELECT provider, SUM(units)::int AS units, SUM(cost_cents)::int AS cost_cents
           FROM provider_spend GROUP BY provider ORDER BY cost_cents DESC`,
        ),
      ]);
      return {
        data: rows.rows,
        page,
        limit,
        total: Number(count.rows[0].c),
        totals: totals.rows,
      };
    });

    // ---- Feature flags ----
    admin.get('/admin/feature-flags', async () => {
      const r = await query(`SELECT key, enabled, description, updated_at FROM feature_flags ORDER BY key`);
      return { data: r.rows };
    });

    admin.put('/admin/feature-flags/:key', { schema: flagSchema }, async (req) => {
      const key = String((req.params as any).key).slice(0, 120);
      if (!/^[a-z0-9_.-]+$/i.test(key)) throw validationError('Invalid flag key');
      const { enabled, description } = req.body as { enabled: boolean; description?: string };
      const r = await query(
        `INSERT INTO feature_flags (key, enabled, description, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled,
           description = COALESCE(EXCLUDED.description, feature_flags.description),
           updated_at = now()
         RETURNING key, enabled, description, updated_at`,
        [key, enabled, description ?? null],
      );
      await logAdminAction(req, 'feature_flag.set', null, { key, enabled });
      return r.rows[0];
    });

    // ---- Admin audit log ----
    admin.get('/admin/audit-log', async (req) => {
      const { page, limit, offset } = paginate(req);
      const [rows, count] = await Promise.all([
        query(
          `SELECT l.id, l.action, l.target_tenant_id, l.meta, l.created_at,
                  u.email AS actor_email
           FROM admin_audit_log l LEFT JOIN users u ON u.id = l.actor_user_id
           ORDER BY l.created_at DESC LIMIT $1 OFFSET $2`,
          [limit, offset],
        ),
        query(`SELECT COUNT(*)::int c FROM admin_audit_log`),
      ]);
      return { data: rows.rows, page, limit, total: Number(count.rows[0].c) };
    });
  });
}
