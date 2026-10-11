import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import { pool, query, type QueryFn } from '../db.js';
import { ApiError, validationError } from '../errors.js';
import { authPlugin, signToken, setAuthCookie, setCsrfCookie } from '../middleware/auth.js';
import { issueCsrfToken } from '../middleware/csrf.js';
import { actorUserId, canAssignRole, humanUserId, requireHumanSession, requireRole, requireRoleOrScope, requireScope } from '../middleware/access.js';
import { DEFAULT_RETENTION_POLICIES, softDeleteSite } from '../services/retention.js';
import { recomputeReadOnly } from '../services/billing.js';
import { getQueue, QUEUES } from '../queues.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { getNotify } from '../providers/notify.js';
import { createSession } from '../services/sessions.js';
import { getPlan, type PlanId } from '../plans.js';
import { logActivity } from '../services/activityLog.js';
import { paginate, assertUuid } from '../pagination.js';
import { config, hasSmtp } from '../config.js';

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

/**
 * NEW-1: every tenant-scoped table whose rows would be destroyed (or
 * orphaned) by `DELETE FROM tenants`. Curated from the migrations by
 * grepping for `REFERENCES tenants` / `tenant_id` columns
 * (001, 010–019, 020–029) — keep this list in sync when a migration adds a
 * tenant-scoped table. A shell tenant may be dissolved on invite accept
 * ONLY when it has zero rows across ALL of these.
 *
 * Excluded on purpose:
 * - `users` — the shell's sole user IS the person moving; the accept
 *   flow checks for OTHER users separately.
 * - `admin_audit_log` — references tenants via actor/target columns
 *   with ON DELETE SET NULL by design (the audit trail must survive).
 * - `email_verification_tokens` / `user_sessions` — scoped to the user,
 *   not the tenant; the user (and their rows) move, nothing is lost.
 * - Backend-B globals (migrations 020–029): `serp_snapshots`,
 *   `pagespeed_cache`, `daily_quotas` — shared caches/quotas with no
 *   tenant_id; nothing tenant-owned is lost when they survive a dissolve.
 * - `rank_tracking_configs` (021) — no tenant_id column (PK is
 *   keyword_id → keywords ON DELETE CASCADE); it cannot exist without a
 *   keywords row, and `keywords` IS guarded below, so a dissolve can
 *   never silently destroy it.
 */
export const SHELL_TENANT_TABLES = [
  'sites',
  'audits',
  'audit_issues',
  'keywords',
  'rank_checks',
  'content_pieces',
  'geo_checks',
  'backlinks',
  'usage_events',
  'subscriptions',
  'reports',
  'stripe_webhook_events',
  'invoices',
  'usage_reservations',
  'usage_alert_state',
  'provider_spend',
  'dead_letter_jobs',
  'idempotency_keys',
  'workspaces',
  'team_invitations',
  'activity_log',
  'notification_rules',
  'notification_digests',
  'webhook_endpoints',
  'webhook_deliveries',
  'notification_log',
  'api_keys',
  'tenant_credits',
  'onboarding_state',
  // Backend-B Wave 2 (migrations 020–029): every tenant_id-bearing table.
  'audit_pages',
  'audit_diffs',
  'rank_alerts',
  'alert_events',
  'competitors',
  'keyword_lists',
  'keyword_list_members',
  'keyword_gaps',
  'content_versions',
  'content_profiles',
  'geo_prompts',
  'link_opportunities',
  'tenant_branding',
  'report_schedules',
  'share_tokens',
] as const;

/**
 * NEW-2: the invite token may ride in the API response ONLY when mail
 * is in mock mode — i.e. no real SMTP is configured (the settings
 * providers view reports notify mode as `hasSmtp() ? 'real' : 'mock'`),
 * mirroring the signup precedent of returning `verifyToken` only in
 * test/dev (`testVerifyTokenField` in routes/auth.ts). In test mode the
 * token is always exposed so integration tests can complete the flow.
 * With real SMTP configured the token travels by email ONLY.
 */
function inviteDebugFields(fields: Record<string, unknown>): Record<string, unknown> {
  const mailMock = !hasSmtp() || config.nodeEnv === 'test' || config.nodeEnv === 'development';
  // In production WITH real SMTP, mailMock must be false even if a
  // stray NODE_ENV slips through: production + SMTP is the real path.
  if (config.nodeEnv === 'production' && hasSmtp()) return {};
  return mailMock ? fields : {};
}

async function requireWorkspace(tenantId: string, workspaceId: string) {
  assertUuid(workspaceId, 'workspaceId');
  const r = await query(`SELECT id, name, limits FROM workspaces WHERE id = $1 AND tenant_id = $2`, [
    workspaceId,
    tenantId,
  ]);
  if (r.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Workspace not found');
  return r.rows[0];
}

const EXPORT_REDACTED = '[REDACTED]';

/**
 * Redaction rule for exported notification config objects:
 * redact ONLY the value of a key that looks like a webhook bearer
 * secret — key matching /webhook|hook_url/i (case-insensitive), e.g.
 * slack_webhook_url, webhook_url, hook_url, discord_webhook. Non-secret
 * keys (threshold, channels, drop_positions, digest settings, labels)
 * are never touched. The walk recurses into nested objects and arrays
 * at arbitrary depth (e.g. config.slack.slack_webhook_url), but only
 * key-matched VALUES are replaced — never structural content.
 */
const WEBHOOK_KEY_RE = /webhook|hook_url/i;

function redactWebhookKeys(config: unknown): unknown {
  if (Array.isArray(config)) return config.map(redactWebhookKeys);
  if (!config || typeof config !== 'object') return config;
  const out: Record<string, unknown> = { ...(config as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    out[key] = WEBHOOK_KEY_RE.test(key) ? EXPORT_REDACTED : redactWebhookKeys(out[key]);
  }
  return out;
}

/**
 * Redaction rule for webhook_endpoints.url values:
 * third-party webhook hosts below hand out bearer URLs where the PATH
 * itself is the secret (Slack services URLs, Discord webhook URLs,
 * Zapier catch hooks, Google Chat webhooks, Teams workflow URLs,
 * webhook-ingest hosts). Redacting query params only would leave the
 * bearer secret fully visible, so the whole URL value is replaced with
 * [REDACTED]. Host list (conservative — only where a bearer-secret
 * shape is expected):
 *   hooks.slack.com, discord.com, discordapp.com, hooks.zapier.com,
 *   chat.googleapis.com, teams.office.com / *.office.com, and any host
 *   containing "webhook".
 * Customer-owned hosts are NOT on this list: their URLs stay intact
 * and only query-param tokens (token=, secret=, api_key=, ...) are
 * redacted, so the export remains understandable.
 */
const BEARER_URL_HOSTS = [
  'hooks.slack.com',
  'discord.com',
  'discordapp.com',
  'hooks.zapier.com',
  'chat.googleapis.com',
  'teams.office.com',
  'office.com',
];

function isBearerUrlHost(url: string): boolean {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (BEARER_URL_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return true;
  if (host.includes('webhook')) return true;
  return false;
}

/** Redact bearer tokens embedded in a URL's query string (Slack bridge
 * tokens, api keys, ...). The URL itself stays so the config remains
 * understandable. */
function redactUrlTokens(url: unknown): unknown {
  if (typeof url !== 'string') return url;
  return url.replace(/([?&])(token|secret|api[_-]?key|access[_-]?token|auth[_-]?token|password)=[^&#\s]*/gi, '$1$2=' + EXPORT_REDACTED);
}

function redactWebhookEndpointUrl(url: unknown): unknown {
  if (typeof url !== 'string') return url;
  if (isBearerUrlHost(url)) return EXPORT_REDACTED; // path-embedded secret on a bearer host
  return redactUrlTokens(url); // customer host: keep URL, redact query tokens
}

function redactExportSection(section: string, rows: any[]): any[] {
  if (section === 'notification_rules') {
    return rows.map((r) => ({ ...r, config: redactWebhookKeys(r.config) }));
  }
  if (section === 'webhook_endpoints') {
    return rows.map((r) => ({ ...r, url: redactWebhookEndpointUrl(r.url) }));
  }
  return rows;
}

export async function registerAccountRoutes(fastify: FastifyInstance) {
  await fastify.register(async (authed) => {
    await authPlugin(authed);
    const t = (req: any) => (req.tenant.tenantId as string);
    // B1-R1: null for API-key callers (keys have no user). User-scoped
    // queries then match nothing instead of 500ing on UUID columns;
    // user-scoped MUTATIONS carry requireHumanSession instead.
    const u = (req: any) => (req.tenant.userId as string | null);

    // ---- Team members (F-09) ----
    // B1-M1: API keys need account:read (session users pass through).
    authed.get('/account/members', { preHandler: requireScope('account:read') }, async (req) => {
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
          userId: actorUserId(req),
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
        userId: actorUserId(req),
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
      async (req, reply) => {
        const { email, role } = req.body as { email: string; role: string };
        if (!EMAIL_RE.test(email)) throw validationError('Invalid email address');
        if (!canAssignRole((req as any).tenant.role, role)) {
          throw new ApiError(403, 'FORBIDDEN', 'You cannot invite a role equal to or above your own');
        }
        // F-09 enumeration fix + NEW-2: an email registered in ANOTHER
        // tenant must be indistinguishable at this endpoint — never 409
        // USER_EXISTS (that leaked platform-wide registration to any
        // owner/admin/editor). The first fix still returned 200 with a
        // token payload for brand-new emails vs a generic 202 for
        // cross-tenant ones — status+shape remained a registration
        // oracle. NOW both cases return the SAME 202 generic body (see
        // the tail of this handler). An email that is already a member
        // of THIS tenant is different: the caller can already see the
        // member list, so the 409 below leaks nothing cross-tenant.
        const existing = await query(`SELECT id, tenant_id FROM users WHERE email = $1`, [email]);
        const sameTenantExisting =
          existing.rows.length > 0 && (existing.rows[0].tenant_id as string) === t(req);
        if (sameTenantExisting) {
          throw new ApiError(409, 'USER_EXISTS', 'This email is already a member of your workspace');
        }
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const inv = await query(
          `INSERT INTO team_invitations (id, tenant_id, email, role, token_hash, invited_by, expires_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now() + interval '7 days')
           RETURNING id, expires_at`,
          [t(req), email, role, tokenHash, actorUserId(req)],
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
          userId: actorUserId(req),
          action: 'invite.sent',
          entityType: 'invitation',
          entityId: inv.rows[0].id as string,
          meta: { email, role },
        });
        // NEW-2: ALWAYS the same 202 + shape, whether the email is
        // brand-new or registered to another tenant — nothing in the
        // status or body distinguishes the two. The debug fields
        // (id/expires_at/token) are included in BOTH cases identically,
        // and only when mail is in mock mode (inviteDebugFields); with
        // real SMTP the token travels by email only.
        return reply.status(202).send({
          ok: true,
          message: 'If this email can be invited, an invitation has been sent.',
          ...inviteDebugFields({
            id: inv.rows[0].id,
            email,
            role,
            expires_at: inv.rows[0].expires_at,
            token: rawToken,
          }),
        });
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
      await logActivity(t(req), { userId: actorUserId(req), action: 'invite.revoked', entityType: 'invitation', entityId: id });
      return { ok: true };
    });

    // B1-R1: accepting an invitation moves the USER between tenants and
    // mints them a session token — API keys have no user to move.
    authed.post('/account/invitations/accept', { schema: acceptInviteSchema, preHandler: requireHumanSession }, async (req, reply) => {
      const { token } = req.body as { token: string };
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      // B1-R1: this flow moves the human user between tenants — resolve
      // the user id once (throws for API keys even if the gate is lost).
      const uid = humanUserId(req);
      // NEW-1: the whole accept flow — invitation/user reads, shell
      // guards, invitation claim, user move, shell dissolve, activity
      // log — runs in ONE transaction on a single pooled client. The
      // old flow used sequential pool queries, so a tenant-scoped row
      // landing between the guard reads and the DELETE was silently
      // destroyed by the cascade. Inside the transaction the shell
      // tenant row is also locked FOR UPDATE (below): an INSERT into
      // any tenant-scoped table takes a KEY SHARE lock on the tenant
      // row for its FK check, which conflicts with FOR UPDATE — so a
      // concurrent insert either committed BEFORE our guard reads (and
      // is counted) or waits until we commit (and then hits a missing
      // tenant if we dissolved). Never in between.
      const client = await pool.connect();
      let inTx = false;
      let acceptedTenantId = '';
      let acceptedRole = '';
      let acceptedTokenVersion = 0;
      try {
        await client.query('BEGIN');
        inTx = true;
        const cq: QueryFn = (text, params) => client.query(text, params as any[]) as any;
      const inv = await cq(
        `SELECT id, tenant_id, email, role, expires_at, accepted_at, revoked_at
         FROM team_invitations WHERE token_hash = $1`,
        [tokenHash],
      );
      if (inv.rows.length === 0) throw new ApiError(404, 'NOT_FOUND', 'Invitation not found');
      const row = inv.rows[0];
      if (row.revoked_at || row.accepted_at || new Date(row.expires_at).getTime() < Date.now()) {
        throw new ApiError(410, 'INVITE_EXPIRED', 'This invitation has expired or was revoked');
      }
      const me = await cq(`SELECT id, email, tenant_id, role FROM users WHERE id = $1`, [uid]);
      if (me.rows.length === 0) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
      if (me.rows[0].email.toLowerCase() !== (row.email as string).toLowerCase()) {
        throw new ApiError(403, 'FORBIDDEN', 'This invitation was sent to a different email address');
      }
      // Wave-2 model: one email = one tenant (users.email is globally
      // unique). Accepting MOVES the user into the inviting tenant:
      // - sole user of an empty shell tenant -> the shell is dissolved;
      // - sole user of a tenant WITH data -> refused (no silent data loss);
      // - last owner of a shared tenant -> refused (would orphan it).
      // "Empty" (NEW-1) means zero rows across EVERY tenant-scoped
      // table (SHELL_TENANT_TABLES): DELETE FROM tenants cascade-deletes
      // far more than sites + billing — usage_events, provider_spend,
      // workspaces, api_keys, webhook rows, invitations, activity, …
      // would all be silently erased by a dissolve. Any row anywhere
      // refuses the move with 409 (guard runs before the claim, inside
      // this transaction, so the invitation is NOT burned).
      const oldTenantId = me.rows[0].tenant_id as string;
      // Guards first (pure reads), claim second, writes last — so a refused
      // accept never burns the invitation.
      let dissolveShell = false;
      if (oldTenantId !== row.tenant_id) {
        // Serialize against concurrent tenant-scoped inserts into the
        // shell (see the transaction comment above).
        await cq(`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`, [oldTenantId]);
        const others = await cq(
          `SELECT COUNT(*)::int c FROM users WHERE tenant_id = $1 AND id <> $2`,
          [oldTenantId, uid],
        );
        if (Number(others.rows[0].c) === 0) {
          // Complete shell guard: one UNION ALL count per curated
          // table (table names come from the frozen constant above,
          // never from input). Existence is checked per table so a
          // not-yet-migrated table cannot crash the accept flow.
          let shellRows = 0;
          for (const table of SHELL_TENANT_TABLES) {
            const exists = await cq(`SELECT to_regclass($1) AS cls`, [`public.${table}`]);
            if (!exists.rows[0]?.cls) continue;
            const c = await cq(`SELECT COUNT(*)::int c FROM ${table} WHERE tenant_id = $1`, [oldTenantId]);
            shellRows += Number(c.rows[0].c);
            if (shellRows > 0) break;
          }
          if (shellRows > 0) {
            throw new ApiError(
              409,
              'INVITE_WOULD_ORPHAN_DATA',
              'You own a workspace with data — delete or transfer it before joining another workspace',
            );
          }
          dissolveShell = true;
        } else if (me.rows[0].role === 'owner') {
          const owners = await cq(
            `SELECT COUNT(*)::int c FROM users WHERE tenant_id = $1 AND role = 'owner' AND id <> $2`,
            [oldTenantId, uid],
          );
          if (Number(owners.rows[0].c) === 0) {
            throw new ApiError(
              409,
              'INVITE_WOULD_ORPHAN_TENANT',
              'You are the last owner of your current workspace — transfer ownership first',
            );
          }
        }
      }
      // F-09 fix: claim the invitation with a SINGLE conditional UPDATE.
      // A concurrent double-submit (double-click, retry, two tabs) — both
      // requests can pass the read check above, but only the one whose
      // UPDATE lands first proceeds; the loser gets 410 with NO writes.
      const claim = await cq(
        `UPDATE team_invitations SET accepted_at = now()
         WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [row.id],
      );
      if ((claim.rowCount ?? 0) === 0) {
        throw new ApiError(410, 'INVITE_EXPIRED', 'This invitation has expired or was revoked');
      }
      if (oldTenantId !== row.tenant_id) {
        await cq(`UPDATE users SET tenant_id = $1, role = $2 WHERE id = $3`, [
          row.tenant_id,
          row.role,
          uid,
        ]);
        if (dissolveShell) {
          await cq(`DELETE FROM tenants WHERE id = $1`, [oldTenantId]);
        }
      }
      await logActivity(
        row.tenant_id as string,
        {
          userId: actorUserId(req),
          action: 'invite.accepted',
          entityType: 'invitation',
          entityId: row.id as string,
        },
        cq,
      );
      // The move changes the token's tenant binding — issue a fresh session
      // token for the new tenant (the old one 401s by design).
      const tv = await cq(`SELECT token_version FROM users WHERE id = $1`, [uid]);
      acceptedTenantId = row.tenant_id as string;
      acceptedRole = row.role as string;
      acceptedTokenVersion = Number(tv.rows[0]?.token_version ?? 0);
        await client.query('COMMIT');
        inTx = false;
      } catch (err) {
        if (inTx) {
          try {
            await client.query('ROLLBACK');
          } catch {
            /* ignore rollback errors */
          }
        }
        throw err;
      } finally {
        client.release();
      }
      const fresh = signToken(uid, acceptedTenantId, acceptedTokenVersion);
      const dj = jwt.decode(fresh) as { jti?: string } | null;
      if (dj?.jti) await createSession(uid, dj.jti, 'invite-accept');
      // Browser parity with login (issueAuthSession in routes/auth.ts):
      // the pre-move cookie 401s after the move (tenant binding), so the
      // fresh token MUST also land in the httpOnly session cookie (+ CSRF
      // cookie), or browser users would have to re-login after accepting.
      // The body token stays for API clients.
      setAuthCookie(reply, fresh);
      setCsrfCookie(reply, issueCsrfToken());
      return { ok: true, tenantId: acceptedTenantId, role: acceptedRole, token: fresh };
    });

    // ---- Client workspaces (F-09) ----
    // B1-M1: API keys need account:read.
    authed.get('/account/workspaces', { preHandler: requireScope('account:read') }, async (req) => {
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
            [t(req), name.trim(), limits ? JSON.stringify(limits) : null, actorUserId(req)],
          );
          await logActivity(t(req), {
            userId: actorUserId(req),
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
          userId: actorUserId(req),
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
        userId: actorUserId(req),
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
          userId: actorUserId(req),
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
    // B1-M1: API keys need account:read.
    authed.get('/account/alert-rules', { preHandler: requireScope('account:read') }, async (req) => {
      const r = await query(
        `SELECT id, rule_type, channels, config, enabled, created_at
         FROM notification_rules WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at ASC`,
        [t(req), u(req)],
      );
      return { data: r.rows };
    });

    // B1-R1: per-user mutations — API keys have no user (userId is null),
    // so these need a human session (otherwise the INSERT hits the
    // user_id NOT NULL column with null → 500).
    authed.post('/account/alert-rules', { schema: alertRuleSchema, preHandler: requireHumanSession }, async (req) => {
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

    // B1-R1: human-only (see POST above).
    authed.delete('/account/alert-rules/:id', { preHandler: requireHumanSession }, async (req) => {
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
    // B1-M1: API keys need account:read.
    authed.get('/account/digest', { preHandler: requireScope('account:read') }, async (req) => {
      const r = await query(`SELECT frequency, channels, last_sent_at FROM notification_digests WHERE tenant_id = $1 AND user_id = $2`, [
        t(req),
        u(req),
      ]);
      return r.rows[0] ?? { frequency: 'weekly', channels: ['email'], last_sent_at: null };
    });

    // B1-R1: human-only — a null user_id would never match the
    // (tenant_id, user_id) upsert key and would insert junk rows.
    authed.put('/account/digest', { schema: digestSchema, preHandler: requireHumanSession }, async (req) => {
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
    // B1-M1: API keys need account:read.
    authed.get('/account/notifications', { preHandler: requireScope('account:read') }, async (req) => {
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
    // B1-M1: API keys need account:read.
    authed.get('/account/sites/:siteId/onboarding', { preHandler: requireScope('account:read') }, async (req) => {
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

    // C1-L-1: this was the only account write with no gate — any viewer
    // session or zero-scope API key could write onboarding state. Writes
    // deserve the role gate: owner/admin/editor sessions, account:read for
    // API keys (matching the GET endpoint's scope).
    authed.put(
      '/account/sites/:siteId/onboarding',
      { schema: onboardingSchema, preHandler: requireRoleOrScope(['owner', 'admin', 'editor'], 'account:read') },
      async (req) => {
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
      },
    );

    // ---- Tenant data export (C-06 / GDPR) ----
    authed.get(
      '/account/export',
      { preHandler: [requireRole('owner', 'admin'), requireScope('sites:read')] },
      async (req, reply) => {
        const tenantId = t(req);
        const dump: Record<string, unknown> = { exported_at: new Date().toISOString(), tenant_id: tenantId };
        // [dump section, actual table, sql] — table is used for the
        // to_regclass existence guard; section is the dump key.
        const tables: Array<[string, string, string]> = [
          ['users', 'users', 'SELECT id, email, name, role, created_at FROM users WHERE tenant_id = $1'],
          // W-07: tenant row itself (no secrets: no llm_api_key_enc).
          ['tenant', 'tenants', 'SELECT id, name, plan_id, notify_email, telegram_chat_id, llm_provider, llm_cost_cap_words, created_at FROM tenants WHERE id = $1'],
          ['sites', 'sites', 'SELECT id, domain, verified, workspace_id, created_at FROM sites WHERE tenant_id = $1'],
          ['workspaces', 'workspaces', 'SELECT id, name, limits, created_at FROM workspaces WHERE tenant_id = $1'],
          ['audits', 'audits', 'SELECT * FROM audits WHERE tenant_id = $1'],
          ['audit_issues', 'audit_issues', 'SELECT * FROM audit_issues WHERE tenant_id = $1'],
          ['keywords', 'keywords', 'SELECT * FROM keywords WHERE tenant_id = $1'],
          ['rank_checks', 'rank_checks', 'SELECT * FROM rank_checks WHERE tenant_id = $1'],
          // W-07: Wave-2 data completeness (metadata only for keys: no hashes).
          ['api_keys', 'api_keys', 'SELECT id, name, key_prefix, scopes, rate_limit_per_min, created_by, last_used_at, revoked_at, created_at FROM api_keys WHERE tenant_id = $1'],
          ['webhook_endpoints', 'webhook_endpoints', 'SELECT id, url, events, enabled, created_at FROM webhook_endpoints WHERE tenant_id = $1'],
          ['webhook_deliveries', 'webhook_deliveries', 'SELECT id, endpoint_id, event, status, attempts, last_error, delivered_at, created_at FROM webhook_deliveries WHERE tenant_id = $1'],
          ['notification_rules', 'notification_rules', 'SELECT id, rule_type, channels, config, enabled, created_at FROM notification_rules WHERE tenant_id = $1'],
          ['notification_digests', 'notification_digests', 'SELECT * FROM notification_digests WHERE tenant_id = $1'],
          ['notification_log', 'notification_log', 'SELECT * FROM notification_log WHERE tenant_id = $1'],
          ['report_schedules', 'report_schedules', 'SELECT * FROM report_schedules WHERE tenant_id = $1'],
          ['competitors', 'competitors', 'SELECT * FROM competitors WHERE tenant_id = $1'],
          ['keyword_gaps', 'keyword_gaps', 'SELECT * FROM keyword_gaps WHERE tenant_id = $1'],
          ['tenant_branding', 'tenant_branding', 'SELECT * FROM tenant_branding WHERE tenant_id = $1'],
          ['content_versions', 'content_versions', 'SELECT * FROM content_versions WHERE tenant_id = $1'],
          ['content_profiles', 'content_profiles', 'SELECT * FROM content_profiles WHERE tenant_id = $1'],
          ['geo_prompts', 'geo_prompts', 'SELECT * FROM geo_prompts WHERE tenant_id = $1'],
          ['rank_alerts', 'rank_alerts', 'SELECT * FROM rank_alerts WHERE tenant_id = $1'],
          ['onboarding_state', 'onboarding_state', 'SELECT * FROM onboarding_state WHERE tenant_id = $1'],
          ['content_pieces', 'content_pieces', 'SELECT * FROM content_pieces WHERE tenant_id = $1'],
          ['geo_checks', 'geo_checks', 'SELECT * FROM geo_checks WHERE tenant_id = $1'],
          ['backlinks', 'backlinks', 'SELECT * FROM backlinks WHERE tenant_id = $1'],
          ['reports', 'reports', 'SELECT * FROM reports WHERE tenant_id = $1'],
          ['subscriptions', 'subscriptions', 'SELECT * FROM subscriptions WHERE tenant_id = $1'],
          ['invoices', 'invoices', 'SELECT * FROM invoices WHERE tenant_id = $1'],
          ['usage_events', 'usage_events', 'SELECT * FROM usage_events WHERE tenant_id = $1'],
          ['activity_log', 'activity_log', 'SELECT * FROM activity_log WHERE tenant_id = $1'],
        ];
        for (const [section, table, sql] of tables) {
          const exists = await query(`SELECT to_regclass($1) AS cls`, [`public.${table}`]);
          if (!exists.rows[0]?.cls) continue;
          const r = await query(sql, [tenantId]);
          dump[section] = redactExportSection(section, r.rows);
        }
        await logActivity(tenantId, { userId: actorUserId(req), action: 'account.exported' });
        return reply
          .header('Content-Type', 'application/json')
          .header('Content-Disposition', `attachment; filename="beyonix-seo-export-${tenantId}.json"`)
          .send(dump);
      },
    );

    // W-07: audit-log retention controls — read the effective retention
    // windows (DB policies override built-in defaults; see C-06).
    authed.get(
      '/account/retention',
      { preHandler: [requireRole('owner', 'admin'), requireScope('sites:read')] },
      async (req) => {
        // keep_for is a Postgres interval; cast to text for a stable JSON shape.
        const dbRows = (await query(`SELECT entity, keep_for::text AS keep_for FROM retention_policies`)).rows as Array<{ entity: string; keep_for: string }>;
        const effective: Record<string, string> = { ...DEFAULT_RETENTION_POLICIES };
        for (const r of dbRows) effective[r.entity] = r.keep_for;
        return { defaults: DEFAULT_RETENTION_POLICIES, overrides: dbRows, effective };
      },
    );

    // C5-M-5: read-only self-recovery. A read-only tenant (downgraded with
    // excess usage) is told to "remove excess resources", but product
    // DELETEs are blocked by enforceTenantState — so this explicit recovery
    // path lives under /account/* (allowlisted for read-only tenants) and
    // trims usage down to the current plan's limits, then clears read-only
    // when back under limits. Chosen over punching DELETE holes through
    // enforceTenantState (middleware/auth.ts, B1-owned): one auditable
    // endpoint instead of re-opening every destructive route.
    authed.post('/account/recover', { preHandler: requireRole('owner', 'admin') }, async (req) => {
      const tenantId = t(req);
      const planId = req.tenant.plan as PlanId;
      const plan = getPlan(planId);
      const removed = { sites: [] as string[], keywordsUntracked: 0 };

      // Newest extras are trimmed first — the tenant's original resources
      // are kept.
      const sitesR = await query(
        `SELECT id, domain FROM sites WHERE tenant_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC`,
        [tenantId],
      );
      const excessSites = sitesR.rows.slice(plan.max_sites);
      for (const s of excessSites) {
        const ok = await softDeleteSite(tenantId, s.id as string, query);
        if (ok) removed.sites.push(s.domain as string);
      }

      const kwsR = await query(
        `SELECT id FROM keywords WHERE tenant_id = $1 AND tracked = TRUE ORDER BY created_at ASC`,
        [tenantId],
      );
      const excessKws = kwsR.rows.slice(plan.max_keywords_tracked);
      if (excessKws.length > 0) {
        const ids = excessKws.map((k: any) => k.id as string);
        const u = await query(`UPDATE keywords SET tracked = FALSE WHERE tenant_id = $1 AND id = ANY($2)`, [
          tenantId,
          ids,
        ]);
        removed.keywordsUntracked = u.rowCount ?? 0;
      }

      const stillOver = await recomputeReadOnly(tenantId, planId, query);
      await logActivity(tenantId, {
        userId: actorUserId(req),
        action: 'account.recovered',
        entityType: 'tenant',
        entityId: tenantId,
        meta: { removed, readOnly: stillOver },
      });
      return { ok: true, removed, read_only: stillOver };
    });

    // W-07: GDPR ERASE — hard-deletes the tenant and every row it owns.
    // Guardrails: owner/admin human session ONLY (no API keys — a stolen key
    // must never be able to erase the account), explicit {confirm:'ERASE'}
    // body, tenant-scoped tables enumerated from SHELL_TENANT_TABLES (the
    // frozen maintenance obligation — ANY new tenant table must be added
    // there), plus user-scoped rows, the users, and best-effort purge of
    // queued BullMQ jobs carrying this tenantId.
    authed.delete(
      '/account/erase',
      {
        preHandler: [requireHumanSession, requireRole('owner', 'admin')],
        schema: { body: { type: 'object', required: ['confirm'], properties: { confirm: { type: 'string', const: 'ERASE' } }, additionalProperties: false } },
      },
      async (req) => {
        const tenantId = t(req);
        const userId = u(req);
        // C1-H-2: cancel the Stripe subscription(s) BEFORE any rows are
        // deleted. On failure cancelTenantBilling throws 502 and the erase
        // aborts — the customer is never left being charged with no
        // account. tenant_credits (money owed) are tombstoned in the
        // surviving audit row below, never silently hard-deleted.
        const { cancelTenantBilling } = await import('../providers/stripe.js');
        const { canceled, creditsCents } = await cancelTenantBilling(tenantId);
        const deleted: Record<string, number> = {};
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const q: QueryFn = (text, params) => client.query(text, params as any[]);
          // The audit trail survives the erase: write the row BEFORE deleting
          // users/tenants (FKs are ON DELETE SET NULL, but the insert itself
          // needs the actor/user + tenant rows to exist).
          await q(
            `INSERT INTO admin_audit_log (id, actor_user_id, actor_tenant_id, action, target_tenant_id, meta)
             VALUES (gen_random_uuid(), $1, $2, 'account.erased', $2, $3)`,
            [
              userId,
              tenantId,
              JSON.stringify({
                erasedTenantId: tenantId,
                subscriptionsCanceled: canceled,
                creditsForfeitedCents: creditsCents,
                ...(creditsCents > 0
                  ? {
                      creditNote:
                        'outstanding credit balance forfeited on erase; contact support to claim a refund',
                    }
                  : {}),
              }),
            ],
          );
          for (const table of SHELL_TENANT_TABLES) {
            const exists = await q(`SELECT to_regclass($1) AS cls`, [`public.${table}`]);
            if (!exists.rows[0]?.cls) continue;
            const r = await q(`DELETE FROM "${table}" WHERE tenant_id = $1`, [tenantId]);
            deleted[table] = r.rowCount ?? 0;
          }
          // User-scoped rows (the shell's users move/delete with the tenant).
          const userIds = (await q(`SELECT id FROM users WHERE tenant_id = $1`, [tenantId])).rows.map((x: any) => x.id as string);
          if (userIds.length > 0) {
            // TOTP lives on users.* columns (cascade-deleted); sessions and
            // verification tokens are explicit user-scoped tables.
            for (const ut of ['user_sessions', 'email_verification_tokens']) {
              const exists = await q(`SELECT to_regclass($1) AS cls`, [`public.${ut}`]);
              if (!exists.rows[0]?.cls) continue;
              const r = await q(`DELETE FROM "${ut}" WHERE user_id = ANY($1)`, [userIds]);
              deleted[ut] = r.rowCount ?? 0;
            }
          }
          const uDel = await q(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
          deleted['users'] = uDel.rowCount ?? 0;
          const tDel = await q(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
          deleted['tenants'] = tDel.rowCount ?? 0;
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally {
          client.release();
        }
        // Queues: best-effort removal of queued jobs for this tenant (outside
        // the DB transaction; a leftover job's processor no-ops on missing tenant).
        const purged: Record<string, number> = {};
        for (const name of Object.values(QUEUES)) {
          try {
            const queue = getQueue(name);
            const jobs = await queue.getJobs(['waiting', 'delayed', 'paused', 'prioritized'] as any, 0, -1);
            let n = 0;
            for (const j of jobs) {
              if ((j.data as any)?.tenantId === tenantId) { await j.remove(); n++; }
            }
            purged[name] = n;
          } catch {
            purged[name] = -1; // Redis unavailable in this path — job rows age out via BullMQ retention
          }
        }
        return {
          ok: true,
          erasedTenantId: tenantId,
          deleted,
          queuesPurged: purged,
          subscriptionsCanceled: canceled.length,
          creditsForfeitedCents: creditsCents,
        };
      },
    );
  });
}
