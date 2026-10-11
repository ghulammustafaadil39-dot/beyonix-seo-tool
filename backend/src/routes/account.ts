import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';
import { ApiError, validationError } from '../errors.js';
import { authPlugin, signToken } from '../middleware/auth.js';
import { canAssignRole, requireRole, requireScope } from '../middleware/access.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { getNotify } from '../providers/notify.js';
import { createSession } from '../services/sessions.js';
import { getPlan, type PlanId } from '../plans.js';
import { logActivity } from '../services/activityLog.js';
import { paginate, assertUuid } from '../pagination.js';
import { config } from '../config.js';

const ONBOARDING_STEPS = ['verify_site', 'connect_gsc', 'first_crawl', 'add_keywords', 'first_report'] as const;

const inviteSchema = {
  body: {
    type: 'object',
    required: ['email', 'role'],
    properties: {
      email: { type: 'string', maxLength: 320 },
      role: { type: 'string', enum: ['admin', 'editor', 'viewer'] },
    },
    additionalProperties: false,
  },
} as const;

const acceptInviteSchema = {
  body: {
    type: 'object',
    required: ['token'],
    properties: { token: { type: 'string', minLength: 32, maxLength: 128 } },
    additionalProperties: false,
  },
} as const;

const workspaceSchema = {
  body: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 },
      limits: {
        type: 'object',
        properties: {
          max_sites: { type: 'integer', minimum: 1, maximum: 1000 },
          max_keywords_tracked: { type: 'integer', minimum: 1, maximum: 100000 },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
} as const;

const assignSiteSchema = {
  body: {
    type: 'object',
    required: ['siteId'],
    properties: { siteId: { type: 'string' } },
    additionalProperties: false,
  },
} as const;

const memberRoleSchema = {
  body: {
    type: 'object',
    required: ['role'],
    properties: { role: { type: 'string', enum: ['admin', 'editor', 'viewer'] } },
    additionalProperties: false,
  },
} as const;

const alertRuleSchema = {
  body: {
    type: 'object',
    required: ['ruleType', 'channels'],
    properties: {
      ruleType: { type: 'string', enum: ['rank_drop', 'critical_issue', 'site_down', 'limit_near'] },
      channels: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: { type: 'string', enum: ['email', 'telegram', 'slack', 'webhook', 'inapp'] },
      },
      config: { type: 'object' },
      enabled: { type: 'boolean' },
    },
    additionalProperties: false,
  },
} as const;

const digestSchema = {
  body: {
    type: 'object',
    required: ['frequency'],
    properties: {
      frequency: { type: 'string', enum: ['daily', 'weekly', 'off'] },
      channels: { type: 'array', items: { type: 'string', enum: ['email'] }, maxItems: 1 },
    },
    additionalProperties: false,
  },
} as const;

const onboardingSchema = {
  body: {
    type: 'object',
    required: ['step', 'completed'],
    properties: {
      step: { type: 'string', enum: [...ONBOARDING_STEPS] },
      completed: { type: 'boolean' },
    },
    additionalProperties: false,
  },
} as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function requireWorkspace(tenantId: string, workspaceId: string) {
  assertUuid(workspaceId, 'workspaceId');
  const r = await query(`SELECT id, name, limits FROM workspaces WHERE id = $1 AND tenant_id = $2`, [
    workspaceId,
    tenantId,
  ]);
  if (r.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Workspace not found');
  return r.rows[0];
}

export async function registerAccountRoutes(fastify: FastifyInstance) {
  await fastify.register(async (authed) => {
    await authPlugin(authed);
    const t = (req: any) => (req.tenant.tenantId as string);
    const u = (req: any) => (req.tenant.userId as string);

    // ---- Team members (F-09) ----
    authed.get('/account/members', async (req) => {
      const r = await query(
        `SELECT id, email, name, role, created_at FROM users WHERE tenant_id = $1 ORDER BY created_at ASC`,
        [t(req)],
      );
      return { data: r.rows };
    });

    authed.patch(
      '/account/members/:id',
      { schema: memberRoleSchema, preHandler: requireRole('owner', 'admin') },
      async (req) => {
        const memberId = assertUuid((req.params as any).id, 'member id');
        const { role } = req.body as { role: string };
        if (!canAssignRole((req as any).tenant.role, role)) {
          throw new ApiError(403, 'FORBIDDEN', 'You cannot grant a role equal to or above your own');
        }
        const m = await query(`SELECT id, role FROM users WHERE id = $1 AND tenant_id = $2`, [memberId, t(req)]);
        if (m.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Member not found');
        if (m.rows[0].role === 'owner') throw new ApiError(403, 'FORBIDDEN', 'Ownership cannot be changed here');
        await query(`UPDATE users SET role = $1 WHERE id = $2`, [role, memberId]);
        await logActivity(t(req), {
          userId: u(req),
          action: 'member.role_changed',
          entityType: 'user',
          entityId: memberId,
          meta: { role },
        });
        return { ok: true };
      },
    );

    authed.delete('/account/members/:id', { preHandler: requireRole('owner', 'admin') }, async (req) => {
      const memberId = assertUuid((req.params as any).id, 'member id');
      const m = await query(`SELECT role FROM users WHERE id = $1 AND tenant_id = $2`, [memberId, t(req)]);
      if (m.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Member not found');
      // A sole owner leaving is the last-owner problem first, self-removal
      // second (use the invite flow to hand off before leaving).
      if (m.rows[0].role === 'owner') {
        const owners = await query(
          `SELECT COUNT(*)::int c FROM users WHERE tenant_id = $1 AND role = 'owner'`,
          [t(req)],
        );
        if (Number(owners.rows[0].c) <= 1) {
          throw new ApiError(400, 'LAST_OWNER', 'You cannot remove the last owner of the workspace');
        }
      }
      if (memberId === u(req)) throw new ApiError(400, 'CANNOT_REMOVE_SELF', 'You cannot remove yourself');
      await query(`DELETE FROM users WHERE id = $1`, [memberId]);
      await logActivity(t(req), {
        userId: u(req),
        action: 'member.removed',
        entityType: 'user',
        entityId: memberId,
      });
      return { ok: true };
    });

    // ---- Invitations (F-09) ----
    authed.post(
      '/account/invitations',
      { schema: inviteSchema, preHandler: [requireVerifiedEmail, requireRole('owner', 'admin', 'editor')] },
      async (req) => {
        const { email, role } = req.body as { email: string; role: string };
        if (!EMAIL_RE.test(email)) throw validationError('Invalid email address');
        if (!canAssignRole((req as any).tenant.role, role)) {
          throw new ApiError(403, 'FORBIDDEN', 'You cannot invite a role equal to or above your own');
        }
        const existing = await query(`SELECT id FROM users WHERE email = $1`, [email]);
        if (existing.rows.length > 0) {
          throw new ApiError(409, 'USER_EXISTS', 'This email already has an account — ask them to accept from their login');
        }
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const inv = await query(
          `INSERT INTO team_invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now() + interval '7 days')
           RETURNING id, expires_at`,
          [t(req), email, role, tokenHash, u(req)],
        );
        const acceptUrl = `${config.appUrl}/dashboard/team/accept?token=${rawToken}`;
        try {
          await getNotify().sendEmail(
            email,
            'You are invited to join a Beyonix SEO workspace',
            `<p>You've been invited as <b>${role}</b>. Accept within 7 days:</p><p><a href="${acceptUrl}">Accept invitation</a></p>`,
          );
        } catch (err) {
          console.error('[account] invitation email failed', err);
        }
        await logActivity(t(req), {
          userId: u(req),
          action: 'invite.sent',
          entityType: 'invitation',
          entityId: inv.rows[0].id as string,
          meta: { email, role },
        });
        // The raw token is returned so API clients (and tests) can complete
        // the flow; email remains the primary channel.
        return { id: inv.rows[0].id, email, role, expires_at: inv.rows[0].expires_at, token: rawToken };
      },
    );

    authed.get('/account/invitations', { preHandler: requireRole('owner', 'admin') }, async (req) => {
      const r = await query(
        `SELECT id, email, role, expires_at, accepted_at, revoked_at, created_at
         FROM team_invitations WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [t(req)],
      );
      return { data: r.rows.map((row: any) => ({ ...row, token_hash: undefined })) };
    });

    authed.delete('/account/invitations/:id', { preHandler: requireRole('owner', 'admin') }, async (req) => {
      const id = assertUuid((req.params as any).id, 'invitation id');
      const r = await query(
        `UPDATE team_invitations SET revoked_at = now()
         WHERE id = $1 AND tenant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [id, t(req)],
      );
      if ((r.rowCount ?? 0) === 0) throw new ApiError(404, 'NOT_FOUND', 'Invitation not found');
      await logActivity(t(req), { userId: u(req), action: 'invite.revoked', entityType: 'invitation', entityId: id });
      return { ok: true };
    });

    authed.post('/account/invitations/accept', { schema: acceptInviteSchema }, async (req) => {
      const { token } = req.body as { token: string };
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      const inv = await query(
        `SELECT id, tenant_id, email, role, expires_at, accepted_at, revoked_at
         FROM team_invitations WHERE token_hash = $1`,
        [tokenHash],
      );
      if (inv.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Invitation not found');
      const row = inv.rows[0];
      if (row.revoked_at || row.accepted_at || new Date(row.expires_at).getTime() < Date.now()) {
        throw new ApiError(410, 'INVITE_EXPIRED', 'This invitation has expired or was revoked');
      }
      const me = await query(`SELECT id, email, tenant_id, role FROM users WHERE id = $1`, [u(req)]);
      if (me.rows.length === 0) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
      if (me.rows[0].email.toLowerCase() !== (row.email as string).toLowerCase()) {
        throw new ApiError(403, 'FORBIDDEN', 'This invitation was sent to a different email address');
      }
      // Wave-2 model: one email = one tenant (users.email is globally
      // unique). Accepting MOVES the user into the inviting tenant:
      // - sole user of an empty shell tenant -> the shell is dissolved;
      // - sole user of a tenant WITH data -> refused (no silent data loss);
      // - last owner of a shared tenant -> refused (would orphan it).
      const oldTenantId = me.rows[0].tenant_id as string;
      if (oldTenantId !== row.tenant_id) {
        const others = await query(
          `SELECT COUNT(*)::int c FROM users WHERE tenant_id = $1 AND id <> $2`,
          [oldTenantId, u(req)],
        );
        const oldSites = await query(`SELECT COUNT(*)::int c FROM sites WHERE tenant_id = $1`, [oldTenantId]);
        if (Number(others.rows[0].c) === 0) {
          if (Number(oldSites.rows[0].c) > 0) {
            throw new ApiError(
              409,
              'INVITE_WOULD_ORPHAN_DATA',
              'You own a workspace with data — delete or transfer it before joining another workspace',
            );
          }
          await query(`UPDATE users SET tenant_id = $1, role = $2 WHERE id = $3`, [
            row.tenant_id,
            row.role,
            u(req),
          ]);
          await query(`DELETE FROM tenants WHERE id = $1`, [oldTenantId]);
        } else {
          if (me.rows[0].role === 'owner') {
            const owners = await query(
              `SELECT COUNT(*)::int c FROM users WHERE tenant_id = $1 AND role = 'owner' AND id <> $2`,
              [oldTenantId, u(req)],
            );
            if (Number(owners.rows[0].c) === 0) {
              throw new ApiError(
                409,
                'INVITE_WOULD_ORPHAN_TENANT',
                'You are the last owner of your current workspace — transfer ownership first',
              );
            }
          }
          await query(`UPDATE users SET tenant_id = $1, role = $2 WHERE id = $3`, [
            row.tenant_id,
            row.role,
            u(req),
          ]);
        }
      }
      await query(`UPDATE team_invitations SET accepted_at = now() WHERE id = $1`, [row.id]);
      await logActivity(row.tenant_id as string, {
        userId: u(req),
        action: 'invite.accepted',
        entityType: 'invitation',
        entityId: row.id as string,
      });
      // The move changes the token's tenant binding — issue a fresh session
      // token for the new tenant (the old one 401s by design).
      const tv = await query(`SELECT token_version FROM users WHERE id = $1`, [u(req)]);
      const fresh = signToken(u(req), row.tenant_id as string, Number(tv.rows[0]?.token_version ?? 0));
      const dj = jwt.decode(fresh) as { jti?: string } | null;
      if (dj?.jti) await createSession(u(req), dj.jti, 'invite-accept');
      return { ok: true, tenantId: row.tenant_id, role: row.role, token: fresh };
    });

    // ---- Client workspaces (F-09) ----
    authed.get('/account/workspaces', async (req) => {
      const { page, limit, offset } = paginate(req);
      const [rows, count] = await Promise.all([
        query(
          `SELECT w.id, w.name, w.limits, w.created_at,
                  (SELECT COUNT(*)::int FROM sites s WHERE s.workspace_id = w.id AND s.deleted_at IS NULL) AS sites
           FROM workspaces w WHERE w.tenant_id = $1 ORDER BY w.created_at ASC LIMIT $2 OFFSET $3`,
          [t(req), limit, offset],
        ),
        query(`SELECT COUNT(*)::int c FROM workspaces WHERE tenant_id = $1`, [t(req)]),
      ]);
      return { data: rows.rows, page, limit, total: Number(count.rows[0].c) };
    });

    authed.post(
      '/account/workspaces',
      { schema: workspaceSchema, preHandler: requireRole('owner', 'admin') },
      async (req) => {
        const { name, limits } = req.body as { name: string; limits?: Record<string, number> };
        try {
          const r = await query(
            `INSERT INTO workspaces (id, tenant_id, name, limits, created_by)
             VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id, name, limits, created_at`,
            [t(req), name.trim(), limits ? JSON.stringify(limits) : null, u(req)],
          );
          await logActivity(t(req), {
            userId: u(req),
            action: 'workspace.created',
            entityType: 'workspace',
            entityId: r.rows[0].id as string,
            workspaceId: r.rows[0].id as string,
            meta: { name },
          });
          return r.rows[0];
        } catch (err: any) {
          if (err?.code === '23505') throw new ApiError(409, 'WORKSPACE_EXISTS', 'A workspace with this name exists');
          throw err;
        }
      },
    );

    authed.patch(
      '/account/workspaces/:id',
      { schema: workspaceSchema, preHandler: requireRole('owner', 'admin') },
      async (req) => {
        const ws = await requireWorkspace(t(req), (req.params as any).id);
        const { name, limits } = req.body as { name: string; limits?: Record<string, number> };
        const r = await query(
          `UPDATE workspaces SET name = $1, limits = COALESCE($2, limits)
           WHERE id = $3 RETURNING id, name, limits, created_at`,
          [name.trim(), limits ? JSON.stringify(limits) : null, ws.id],
        ).catch((err: any) => {
          if (err?.code === '23505') throw new ApiError(409, 'WORKSPACE_EXISTS', 'A workspace with this name exists');
          throw err;
        });
        await logActivity(t(req), {
          userId: u(req),
          action: 'workspace.updated',
          entityType: 'workspace',
          entityId: ws.id as string,
          workspaceId: ws.id as string,
        });
        return r.rows[0];
      },
    );

    authed.delete('/account/workspaces/:id', { preHandler: requireRole('owner', 'admin') }, async (req) => {
      const ws = await requireWorkspace(t(req), (req.params as any).id);
      await query(`UPDATE sites SET workspace_id = NULL WHERE workspace_id = $1`, [ws.id]);
      await query(`DELETE FROM workspaces WHERE id = $1`, [ws.id]);
      await logActivity(t(req), {
        userId: u(req),
        action: 'workspace.deleted',
        entityType: 'workspace',
        entityId: ws.id as string,
      });
      return { ok: true };
    });

    authed.post(
      '/account/workspaces/:id/sites',
      { schema: assignSiteSchema, preHandler: requireRole('owner', 'admin', 'editor') },
      async (req) => {
        const ws = await requireWorkspace(t(req), (req.params as any).id);
        const siteId = assertUuid((req.body as any).siteId, 'siteId');
        const site = await query(`SELECT id, workspace_id FROM sites WHERE id = $1 AND tenant_id = $2`, [
          siteId,
          t(req),
        ]);
        if (site.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Site not found');
        // Per-client limits (F-09): workspace limits override the plan.
        const limits = (ws.limits ?? {}) as { max_sites?: number };
        const maxSites = limits.max_sites ?? getPlan((req as any).tenant.plan as PlanId).max_sites;
        const count = await query(
          `SELECT COUNT(*)::int c FROM sites WHERE workspace_id = $1 AND deleted_at IS NULL`,
          [ws.id],
        );
        if (Number(count.rows[0].c) >= maxSites && site.rows[0].workspace_id !== ws.id) {
          throw new ApiError(402, 'LIMIT_EXCEEDED', `Workspace site limit reached (${maxSites})`, {
            upgrade: true,
            limit: maxSites,
            used: Number(count.rows[0].c),
          });
        }
        await query(`UPDATE sites SET workspace_id = $1 WHERE id = $2`, [ws.id, siteId]);
        await logActivity(t(req), {
          userId: u(req),
          action: 'workspace.site_assigned',
          entityType: 'site',
          entityId: siteId,
          workspaceId: ws.id as string,
        });
        return { ok: true };
      },
    );

    authed.delete(
      '/account/workspaces/:id/sites/:siteId',
      { preHandler: requireRole('owner', 'admin', 'editor') },
      async (req) => {
        const ws = await requireWorkspace(t(req), (req.params as any).id);
        const siteId = assertUuid((req.params as any).siteId, 'siteId');
        await query(`UPDATE sites SET workspace_id = NULL WHERE id = $1 AND workspace_id = $2`, [siteId, ws.id]);
        return { ok: true };
      },
    );

    // ---- Activity log (F-09) ----
    authed.get('/account/activity', { preHandler: requireRole('owner', 'admin') }, async (req) => {
      const { page, limit, offset } = paginate(req);
      const [rows, count] = await Promise.all([
        query(
          `SELECT a.id, a.action, a.entity_type, a.entity_id, a.meta, a.created_at,
                  u.email AS user_email, w.name AS workspace_name
           FROM activity_log a
           LEFT JOIN users u ON u.id = a.user_id
           LEFT JOIN workspaces w ON w.id = a.workspace_id
           WHERE a.tenant_id = $1 ORDER BY a.created_at DESC LIMIT $2 OFFSET $3`,
          [t(req), limit, offset],
        ),
        query(`SELECT COUNT(*)::int c FROM activity_log WHERE tenant_id = $1`, [t(req)]),
      ]);
      return { data: rows.rows, page, limit, total: Number(count.rows[0].c) };
    });

    // ---- Alert rules (F-10) ----
    authed.get('/account/alert-rules', async (req) => {
      const r = await query(
        `SELECT id, rule_type, channels, config, enabled, created_at
         FROM notification_rules WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at ASC`,
        [t(req), u(req)],
      );
      return { data: r.rows };
    });

    authed.post('/account/alert-rules', { schema: alertRuleSchema }, async (req) => {
      const { ruleType, channels, config, enabled } = req.body as {
        ruleType: string;
        channels: string[];
        config?: Record<string, unknown>;
        enabled?: boolean;
      };
      if (channels.includes('slack') && !(config as any)?.slack_webhook_url) {
        throw validationError('slack_webhook_url is required in config for the slack channel');
      }
      const r = await query(
        `INSERT INTO notification_rules (id, tenant_id, user_id, rule_type, channels, config, enabled)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, user_id, rule_type) DO UPDATE SET
           channels = EXCLUDED.channels, config = EXCLUDED.config, enabled = EXCLUDED.enabled
         RETURNING id, rule_type, channels, config, enabled, created_at`,
        [t(req), u(req), ruleType, channels, config ? JSON.stringify(config) : '{}', enabled ?? true],
      );
      return r.rows[0];
    });

    authed.delete('/account/alert-rules/:id', async (req) => {
      const id = assertUuid((req.params as any).id, 'rule id');
      const r = await query(`DELETE FROM notification_rules WHERE id = $1 AND tenant_id = $2 AND user_id = $3`, [
        id,
        t(req),
        u(req),
      ]);
      if ((r.rowCount ?? 0) === 0) throw new ApiError(404, 'NOT_FOUND', 'Alert rule not found');
      return { ok: true };
    });

    // ---- Digest settings (F-10) ----
    authed.get('/account/digest', async (req) => {
      const r = await query(`SELECT frequency, channels, last_sent_at FROM notification_digests WHERE tenant_id = $1 AND user_id = $2`, [
        t(req),
        u(req),
      ]);
      return r.rows[0] ?? { frequency: 'weekly', channels: ['email'], last_sent_at: null };
    });

    authed.put('/account/digest', { schema: digestSchema }, async (req) => {
      const { frequency, channels } = req.body as { frequency: string; channels?: string[] };
      const r = await query(
        `INSERT INTO notification_digests (tenant_id, user_id, frequency, channels)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, user_id) DO UPDATE SET frequency = EXCLUDED.frequency, channels = EXCLUDED.channels
         RETURNING frequency, channels, last_sent_at`,
        [t(req), u(req), frequency, channels ?? ['email']],
      );
      return r.rows[0];
    });

    // ---- Notification center (F-10) ----
    authed.get('/account/notifications', async (req) => {
      const { page, limit, offset } = paginate(req);
      const [rows, count] = await Promise.all([
        query(
          `SELECT id, notification_type, channel, status, detail, created_at
           FROM notification_log WHERE tenant_id = $1 AND (user_id = $2 OR user_id IS NULL)
           ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
          [t(req), u(req), limit, offset],
        ),
        query(`SELECT COUNT(*)::int c FROM notification_log WHERE tenant_id = $1 AND (user_id = $2 OR user_id IS NULL)`, [
          t(req),
          u(req),
        ]),
      ]);
      return { data: rows.rows, page, limit, total: Number(count.rows[0].c) };
    });

    // ---- Onboarding progress (F-01 sub-task) ----
    authed.get('/account/sites/:siteId/onboarding', async (req) => {
      const siteId = assertUuid((req.params as any).siteId, 'siteId');
      const site = await query(`SELECT id FROM sites WHERE id = $1 AND tenant_id = $2`, [siteId, t(req)]);
      if (site.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Site not found');
      const r = await query(`SELECT step, completed, completed_at FROM onboarding_state WHERE tenant_id = $1 AND site_id = $2`, [
        t(req),
        siteId,
      ]);
      const byStep = new Map(r.rows.map((row: any) => [row.step, row]));
      return {
        siteId,
        steps: ONBOARDING_STEPS.map((step) => ({
          step,
          completed: Boolean(byStep.get(step)?.completed),
          completed_at: byStep.get(step)?.completed_at ?? null,
        })),
      };
    });

    authed.put('/account/sites/:siteId/onboarding', { schema: onboardingSchema }, async (req) => {
      const siteId = assertUuid((req.params as any).siteId, 'siteId');
      const site = await query(`SELECT id FROM sites WHERE id = $1 AND tenant_id = $2`, [siteId, t(req)]);
      if (site.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Site not found');
      const { step, completed } = req.body as { step: string; completed: boolean };
      const r = await query(
        `INSERT INTO onboarding_state (tenant_id, site_id, step, completed, completed_at, updated_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN now() ELSE NULL END, now())
         ON CONFLICT (tenant_id, site_id, step) DO UPDATE SET
           completed = EXCLUDED.completed,
           completed_at = CASE WHEN EXCLUDED.completed THEN now() ELSE NULL END,
           updated_at = now()
         RETURNING step, completed, completed_at`,
        [t(req), siteId, step, completed],
      );
      return r.rows[0];
    });

    // ---- Tenant data export (C-06 / GDPR) ----
    authed.get(
      '/account/export',
      { preHandler: [requireRole('owner', 'admin'), requireScope('sites:read')] },
      async (req, reply) => {
        const tenantId = t(req);
        const dump: Record<string, unknown> = { exported_at: new Date().toISOString(), tenant_id: tenantId };
        const tables: Array<[string, string]> = [
          ['users', 'SELECT id, email, name, role, created_at FROM users WHERE tenant_id = $1'],
          ['sites', 'SELECT id, domain, verified, workspace_id, created_at FROM sites WHERE tenant_id = $1'],
          ['workspaces', 'SELECT id, name, limits, created_at FROM workspaces WHERE tenant_id = $1'],
          ['audits', 'SELECT * FROM audits WHERE tenant_id = $1'],
          ['audit_issues', 'SELECT * FROM audit_issues WHERE tenant_id = $1'],
          ['keywords', 'SELECT * FROM keywords WHERE tenant_id = $1'],
          ['rank_checks', 'SELECT * FROM rank_checks WHERE tenant_id = $1'],
          ['content_pieces', 'SELECT * FROM content_pieces WHERE tenant_id = $1'],
          ['geo_checks', 'SELECT * FROM geo_checks WHERE tenant_id = $1'],
          ['backlinks', 'SELECT * FROM backlinks WHERE tenant_id = $1'],
          ['reports', 'SELECT * FROM reports WHERE tenant_id = $1'],
          ['subscriptions', 'SELECT * FROM subscriptions WHERE tenant_id = $1'],
          ['invoices', 'SELECT * FROM invoices WHERE tenant_id = $1'],
          ['usage_events', 'SELECT * FROM usage_events WHERE tenant_id = $1'],
          ['notification_rules', 'SELECT id, rule_type, channels, config, enabled FROM notification_rules WHERE tenant_id = $1'],
          ['activity_log', 'SELECT * FROM activity_log WHERE tenant_id = $1'],
        ];
        for (const [name, sql] of tables) {
          const exists = await query(`SELECT to_regclass($1) AS cls`, [`public.${name}`]);
          if (!exists.rows[0]?.cls) continue;
          const r = await query(sql, [tenantId]);
          dump[name] = r.rows;
        }
        await logActivity(tenantId, { userId: u(req), action: 'account.exported' });
        return reply
          .header('Content-Type', 'application/json')
          .header('Content-Disposition', `attachment; filename="beyonix-seo-export-${tenantId}.json"`)
          .send(dump);
      },
    );
  });
}
