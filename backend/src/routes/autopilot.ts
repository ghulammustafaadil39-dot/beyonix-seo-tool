// Autopilot v2.0: WordPress connection, fix proposals, approval flow, change log.
// Two modes: copilot (user approves each fix) and autopilot (auto-apply safe fixes).

import type { FastifyInstance } from 'fastify';
import { authPlugin } from '../middleware/auth.js';
import { requireVerifiedEmail } from '../middleware/requireVerified.js';
import { requireActiveSubscriptionOrTrial } from '../middleware/requireSubscription.js';
import { requireRoleOrScope } from '../middleware/access.js';
import { query } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { requireSite } from '../services/sites.js';
import { encrypt } from '../crypto.js';
import {
  verifyConnection,
  detectSeoPlugin,
  listContent,
  writePostMeta,
  writePostTitle,
  type WpConnection,
} from '../providers/wordpress.js';
import { proposeFix, type FixProposal } from '../services/autopilot/fixEngine.js';

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

async function getWpConn(tenantId: string, siteId: string): Promise<WpConnection & { seoPlugin: string }> {
  const r = await query(
    `SELECT site_url, wp_username, app_password_enc, seo_plugin, status FROM wp_connections
     WHERE site_id = $1 AND tenant_id = $2`,
    [siteId, tenantId],
  );
  if (r.rows.length === 0) throw notFound('WordPress not connected for this site');
  const row = r.rows[0];
  if (row.status !== 'active') throw badRequest('WordPress connection is not active: ' + (row.status));
  return {
    siteUrl: row.site_url,
    username: row.wp_username,
    appPasswordEnc: row.app_password_enc,
    seoPlugin: row.seo_plugin,
  };
}

export async function registerAutopilotRoutes(fastify: FastifyInstance) {
  await fastify.register(async (app) => {
    await authPlugin(app);

    // ---- Connect WordPress ----
    app.post(
      '/sites/:id/wp-connect',
      {
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'sites:write')],
        schema: {
          params: idParams,
          body: {
            type: 'object',
            properties: {
              siteUrl: { type: 'string', minLength: 1 },
              username: { type: 'string', minLength: 1 },
              appPassword: { type: 'string', minLength: 1 },
            },
            required: ['siteUrl', 'username', 'appPassword'],
            additionalProperties: false,
          },
        },
      },
      async (req) => {
        const { id } = req.params as { id: string };
        const tenantId = req.tenant!.tenantId;
        await requireSite(tenantId, id);
        const { siteUrl, username, appPassword } = req.body as {
          siteUrl: string; username: string; appPassword: string;
        };
        const cleanUrl = siteUrl.trim().replace(/\/$/, '');
        if (!/^https?:\/\//i.test(cleanUrl)) throw badRequest('Site URL must start with http(s)://');

        const conn: WpConnection = {
          siteUrl: cleanUrl,
          username: username.trim(),
          appPasswordEnc: encrypt(appPassword),
        };
        const check = await verifyConnection(conn);
        if (!check.ok) throw badRequest('WordPress connection failed: ' + check.error);
        const seoPlugin = await detectSeoPlugin(conn);

        await query(
          `INSERT INTO wp_connections (site_id, tenant_id, site_url, wp_username, app_password_enc, seo_plugin, status, last_check_at)
           VALUES ($1,$2,$3,$4,$5,$6,'active',now())
           ON CONFLICT (site_id) DO UPDATE SET
             site_url=EXCLUDED.site_url, wp_username=EXCLUDED.wp_username,
             app_password_enc=EXCLUDED.app_password_enc, seo_plugin=EXCLUDED.seo_plugin,
             status='active', last_check_at=now(), last_error=NULL, updated_at=now()`,
          [id, tenantId, cleanUrl, username.trim(), conn.appPasswordEnc, seoPlugin],
        );
        // Ensure settings row exists
        await query(
          `INSERT INTO autopilot_settings (site_id, tenant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [id, tenantId],
        );
        return { ok: true, seoPlugin, siteName: check.siteName };
      },
    );

    // ---- Connection status ----
    app.get(
      '/sites/:id/wp-status',
      { preHandler: [requireRoleOrScope(['owner', 'admin', 'editor', 'viewer'], 'sites:read')], schema: { params: idParams } },
      async (req) => {
        const { id } = req.params as { id: string };
        const tenantId = req.tenant!.tenantId;
        await requireSite(tenantId, id);
        const r = await query(
          `SELECT site_url, seo_plugin, status, last_check_at, last_error FROM wp_connections
           WHERE site_id=$1 AND tenant_id=$2`,
          [id, tenantId],
        );
        if (r.rows.length === 0) return { connected: false };
        const s = await query(`SELECT mode, enabled FROM autopilot_settings WHERE site_id=$1`, [id]);
        return { connected: true, ...r.rows[0], ...(s.rows[0] ?? { mode: 'copilot', enabled: true }) };
      },
    );

    // ---- Settings (mode switch) ----
    app.put(
      '/sites/:id/autopilot/settings',
      {
        preHandler: [requireRoleOrScope(['owner', 'admin', 'editor'], 'sites:write')],
        schema: {
          params: idParams,
          body: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['copilot', 'autopilot'] },
              enabled: { type: 'boolean' },
              maxChangesPerRun: { type: 'integer', minimum: 1, maximum: 100 },
              maxChangesPerDay: { type: 'integer', minimum: 1, maximum: 200 },
              maxPostsPerWeek: { type: 'integer', minimum: 1, maximum: 7 },
            },
            additionalProperties: false,
          },
        },
      },
      async (req) => {
        const { id } = req.params as { id: string };
        const tenantId = req.tenant!.tenantId;
        await requireSite(tenantId, id);
        const b = req.body as Record<string, unknown>;
        const sets: string[] = [];
        const vals: unknown[] = [];
        for (const [k, col] of [
          ['mode', 'mode'], ['enabled', 'enabled'],
          ['maxChangesPerRun', 'max_changes_per_run'], ['maxChangesPerDay', 'max_changes_per_day'],
          ['maxPostsPerWeek', 'max_posts_per_week'],
        ] as const) {
          if (b[k] !== undefined) { vals.push(b[k]); sets.push(`${col}=$${vals.length}`); }
        }
        if (sets.length === 0) throw badRequest('Nothing to update');
        vals.push(id, tenantId);
        const r = await query(
          `UPDATE autopilot_settings SET ${sets.join(', ')}, updated_at=now()
           WHERE site_id=$${vals.length - 1} AND tenant_id=$${vals.length} RETURNING *`,
          vals,
        );
        if (r.rows.length === 0) {
          await query(`INSERT INTO autopilot_settings (site_id, tenant_id) VALUES ($1,$2)`, [id, tenantId]);
          return (await query(`SELECT * FROM autopilot_settings WHERE site_id=$1`, [id])).rows[0];
        }
        return r.rows[0];
      },
    );

    // ---- Scan: audit issues → fix proposals ----
    // (v2.0: generates proposals from the latest audit + live WP content check)
    app.post(
      '/sites/:id/autopilot/scan',
      {
        preHandler: [requireVerifiedEmail, requireActiveSubscriptionOrTrial, requireRoleOrScope(['owner', 'admin', 'editor'], 'sites:write')],
        schema: { params: idParams },
      },
      async (req) => {
        const { id } = req.params as { id: string };
        const tenantId = req.tenant!.tenantId;
        await requireSite(tenantId, id);
        const conn = await getWpConn(tenantId, id);
        const settings = (await query(`SELECT * FROM autopilot_settings WHERE site_id=$1`, [id])).rows[0];

        // Daily cap check
        const today = await query(
          `SELECT COUNT(*)::int c FROM site_changes
           WHERE site_id=$1 AND status='applied' AND applied_at > now() - interval '24 hours'`,
          [id],
        );
        const usedToday = today.rows[0].c as number;
        const remaining = Math.max(0, settings.max_changes_per_day - usedToday);

        // Pull live WP content and find missing meta descriptions (additive fixes)
        const posts = await listContent(conn, 'posts', 20, 1);
        const pages = await listContent(conn, 'pages', 20, 1);
        const all = [...posts, ...pages];
        const existingTitles = new Set(all.map((p) => (p.yoastTitle || p.title).toLowerCase()));

        const proposals: FixProposal[] = [];
        for (const post of all) {
          if (proposals.length >= Math.min(settings.max_changes_per_run, remaining)) break;
          // Missing meta description → auto-safe fix
          const metaKey = conn.seoPlugin === 'yoast' ? '_yoast_wpseo_metadesc'
            : conn.seoPlugin === 'rankmath' ? 'rank_math_description' : null;
          const hasDesc = metaKey && post.meta[metaKey];
          if (!hasDesc && metaKey) {
            const p = await proposeFix({
              tenantId, siteId: id,
              issueType: 'missing-meta-description',
              issueDetail: 'Meta description missing',
              post, seoPlugin: conn.seoPlugin, existingTitles,
            });
            if (p) proposals.push(p);
          }
        }

        // Store proposals for approval flow
        for (const p of proposals) {
          await query(
            `INSERT INTO autopilot_proposals
             (site_id, tenant_id, change_type, field_key, wp_post_id, page_url, previous_value, proposed_value, reason, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
             ON CONFLICT DO NOTHING`,
            [id, tenantId, p.changeType, p.fieldKey, p.wpPostId, p.pageUrl,
             p.previousValue, p.proposedValue, p.reason],
          );
        }

        // In autopilot mode: auto-apply the safe ones immediately
        let applied = 0;
        if (settings.mode === 'autopilot' && settings.enabled) {
          for (const p of proposals.filter((x) => x.autoSafe)) {
            try {
              const prev = await writePostMeta(conn, p.wpPostId, p.fieldKey, p.proposedValue);
              await query(
                `INSERT INTO site_changes
                 (site_id, tenant_id, wp_post_id, change_type, field_key, previous_value, new_value, page_url, status, mode, applied_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'applied','autopilot',now())`,
                [id, tenantId, p.wpPostId, p.changeType, p.fieldKey,
                 String(prev.previous ?? ''), p.proposedValue, p.pageUrl],
              );
              applied++;
            } catch (e: any) {
              await query(
                `INSERT INTO site_changes
                 (site_id, tenant_id, wp_post_id, change_type, field_key, previous_value, new_value, page_url, status, mode, error)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'failed','autopilot',$9)`,
                [id, tenantId, p.wpPostId, p.changeType, p.fieldKey,
                 p.previousValue, p.proposedValue, p.pageUrl, String(e?.message ?? e)],
              );
            }
          }
          // Mark auto-applied proposals as approved
          await query(
            `UPDATE autopilot_proposals SET status='approved', decided_at=now()
             WHERE site_id=$1 AND status='pending'`,
            [id],
          );
        }

        return {
          scanned: all.length,
          proposals: proposals.length,
          autoApplied: applied,
          mode: settings.mode,
          remainingToday: remaining - applied,
        };
      },
    );

    // ---- List pending proposals (co-pilot approval queue) ----
    app.get(
      '/sites/:id/autopilot/proposals',
      { preHandler: [requireRoleOrScope(['owner', 'admin', 'editor', 'viewer'], 'sites:read')], schema: { params: idParams } },
      async (req) => {
        const { id } = req.params as { id: string };
        await requireSite(req.tenant!.tenantId, id);
        const r = await query(
          `SELECT * FROM autopilot_proposals WHERE site_id=$1 AND status='pending'
           ORDER BY created_at DESC LIMIT 100`,
          [id],
        );
        return { data: r.rows };
      },
    );

    // ---- Approve a proposal → executes the fix ----
    app.post(
      '/sites/:id/autopilot/proposals/:proposalId/approve',
      {
        preHandler: [requireVerifiedEmail, requireRoleOrScope(['owner', 'admin', 'editor'], 'sites:write')],
        schema: {
          params: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              proposalId: { type: 'string', format: 'uuid' },
            },
            required: ['id', 'proposalId'],
          },
        },
      },
      async (req) => {
        const { id, proposalId } = req.params as { id: string; proposalId: string };
        const tenantId = req.tenant!.tenantId;
        await requireSite(tenantId, id);
        const pr = await query(
          `SELECT * FROM autopilot_proposals WHERE id=$1 AND site_id=$2 AND status='pending'`,
          [proposalId, id],
        );
        if (pr.rows.length === 0) throw notFound('Proposal not found or already decided');
        const p = pr.rows[0];
        const conn = await getWpConn(tenantId, id);

        try {
          let prev: unknown;
          if (p.change_type === 'title') {
            const r = await writePostTitle(conn, p.wp_post_id, p.proposed_value);
            prev = r.previous;
          } else {
            const r = await writePostMeta(conn, p.wp_post_id, p.field_key, p.proposed_value);
            prev = r.previous;
          }
          await query(
            `INSERT INTO site_changes
             (site_id, tenant_id, wp_post_id, change_type, field_key, previous_value, new_value, page_url, status, mode, applied_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'applied','copilot',now())`,
            [id, tenantId, p.wp_post_id, p.change_type, p.field_key,
             String(prev ?? p.previous_value ?? ''), p.proposed_value, p.page_url],
          );
          await query(
            `UPDATE autopilot_proposals SET status='approved', decided_at=now() WHERE id=$1`,
            [proposalId],
          );
          return { ok: true };
        } catch (e: any) {
          await query(
            `UPDATE autopilot_proposals SET status='expired', decided_at=now() WHERE id=$1`,
            [proposalId],
          );
          throw badRequest('Fix failed: ' + String(e?.message ?? e));
        }
      },
    );

    // ---- Reject a proposal ----
    app.post(
      '/sites/:id/autopilot/proposals/:proposalId/reject',
      {
        preHandler: [requireRoleOrScope(['owner', 'admin', 'editor'], 'sites:write')],
        schema: {
          params: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              proposalId: { type: 'string', format: 'uuid' },
            },
            required: ['id', 'proposalId'],
          },
        },
      },
      async (req) => {
        const { id, proposalId } = req.params as { id: string; proposalId: string };
        await requireSite(req.tenant!.tenantId, id);
        await query(
          `UPDATE autopilot_proposals SET status='rejected', decided_at=now()
           WHERE id=$1 AND site_id=$2 AND status='pending'`,
          [proposalId, id],
        );
        return { ok: true };
      },
    );

    // ---- Change history ----
    app.get(
      '/sites/:id/autopilot/history',
      { preHandler: [requireRoleOrScope(['owner', 'admin', 'editor', 'viewer'], 'sites:read')], schema: { params: idParams } },
      async (req) => {
        const { id } = req.params as { id: string };
        await requireSite(req.tenant!.tenantId, id);
        const r = await query(
          `SELECT id, wp_post_id, change_type, field_key, previous_value, new_value,
                  page_url, status, mode, error, created_at, applied_at, reverted_at
           FROM site_changes WHERE site_id=$1 ORDER BY created_at DESC LIMIT 100`,
          [id],
        );
        return { data: r.rows };
      },
    );

    // ---- Revert (one-click undo) ----
    app.post(
      '/sites/:id/autopilot/changes/:changeId/revert',
      {
        preHandler: [requireVerifiedEmail, requireRoleOrScope(['owner', 'admin', 'editor'], 'sites:write')],
        schema: {
          params: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              changeId: { type: 'string', format: 'uuid' },
            },
            required: ['id', 'changeId'],
          },
        },
      },
      async (req) => {
        const { id, changeId } = req.params as { id: string; changeId: string };
        const tenantId = req.tenant!.tenantId;
        await requireSite(tenantId, id);
        const cr = await query(
          `SELECT * FROM site_changes WHERE id=$1 AND site_id=$2 AND status='applied'`,
          [changeId, id],
        );
        if (cr.rows.length === 0) throw notFound('Change not found or not revertible');
        const c = cr.rows[0];
        const conn = await getWpConn(tenantId, id);
        const prevVal = c.previous_value ?? '';

        try {
          if (c.change_type === 'title') {
            await writePostTitle(conn, c.wp_post_id, prevVal);
          } else if (c.field_key) {
            await writePostMeta(conn, c.wp_post_id, c.field_key, prevVal);
          } else {
            throw new Error('Cannot revert this change type automatically');
          }
          await query(
            `UPDATE site_changes SET status='reverted', reverted_at=now() WHERE id=$1`,
            [changeId],
          );
          return { ok: true };
        } catch (e: any) {
          throw badRequest('Revert failed: ' + String(e?.message ?? e));
        }
      },
    );
  });
}
