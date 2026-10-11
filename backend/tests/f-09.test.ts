import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import type { FastifyInstance } from 'fastify';
import { pool, query, runMigrations } from '../src/db.js';
import { auth, signupVerified, tenantCollector, uniqueEmail, uniquePassword } from './helpers-ba.js';

/**
 * F-09 (agency/team) backend: roles, invitations, client workspaces,
 * per-client limits, activity log. SECURITY-SENSITIVE (authz boundaries) —
 * Security Lead review required before marking done.
 *
 * Needs DATABASE_URL at a test database (bseo_test_ba).
 */
const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

describe.runIf(HAS_TEST_DB)('F-09 agency & team', () => {
  let app: FastifyInstance;
  const tc = tenantCollector();

  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
  }, 60000);

  afterAll(async () => {
    await app?.close();
    if (tc.ids.length) await query('DELETE FROM tenants WHERE id = ANY($1)', [tc.ids]);
    await pool.end();
  });

  it('invitation flow: owner invites -> invitee signs up -> accepts -> member with role', async () => {
    const owner = await signupVerified(app);
    tc.add(owner.tenantId);
    const inviteEmail = uniqueEmail('invitee');

    const inv = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations',
      headers: auth(owner.token),
      payload: { email: inviteEmail, role: 'editor' },
    });
    // NEW-2: invite create is ALWAYS 202 generic (mock mode adds the
    // debug token fields — see inviteDebugFields in routes/account.ts).
    expect(inv.statusCode).toBe(202);
    const invBody = inv.json() as any;
    expect(invBody.token).toMatch(/^[0-9a-f]{64}$/);

    // Invitee signs up fresh, then accepts.
    const invitee = await signupVerified(app, inviteEmail);
    tc.add(invitee.tenantId); // their throwaway tenant (accept moves them)
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations/accept',
      headers: auth(invitee.token),
      payload: { token: invBody.token },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json()).toMatchObject({ role: 'editor', tenantId: owner.tenantId });

    const members = await app.inject({
      method: 'GET',
      url: '/api/v1/account/members',
      headers: auth(owner.token),
    });
    const emails = (members.json() as any).data.map((m: any) => `${m.email}:${m.role}`);
    expect(emails).toContain(`${inviteEmail}:editor`);

    // Re-accepting the same token is rejected (use the fresh session token).
    const freshToken = (accept.json() as any).token as string;
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations/accept',
      headers: auth(freshToken),
      payload: { token: invBody.token },
    });
    expect(again.statusCode).toBe(410);
  });

  it('REGRESSION: invite accept sets a fresh bseo_token cookie bound to the NEW tenant (no re-login)', async () => {
    const owner = await signupVerified(app);
    tc.add(owner.tenantId);
    const inviteEmail = uniqueEmail('cookieaccept');

    const inv = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations',
      headers: auth(owner.token),
      payload: { email: inviteEmail, role: 'editor' },
    });
    expect(inv.statusCode).toBe(202);
    const invToken = (inv.json() as any).token as string;

    // Invitee signs up RAW so we keep the real browser cookie jar
    // (pre-move bseo_token + bseo_csrf) instead of a Bearer token.
    const jarFrom = (res: { headers: any }): Record<string, string> => {
      const raw = res.headers['set-cookie'];
      const list: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const pairs = list.map((c: string) => c.split(';')[0]);
      const csrf = pairs.find((p) => p.startsWith('bseo_csrf='))?.slice('bseo_csrf='.length) ?? '';
      return { cookie: pairs.join('; '), 'x-csrf-token': csrf };
    };
    const cookieValue = (res: { headers: any }, name: string): string | null => {
      const raw = res.headers['set-cookie'];
      const list: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
      const hit = list.find((c: string) => c.startsWith(`${name}=`));
      return hit ? hit.split(';')[0].slice(name.length + 1) : null;
    };

    const s = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: inviteEmail, password: uniquePassword(), name: 'Cookie' },
    });
    expect(s.statusCode).toBe(201);
    const sBody = s.json() as any;
    tc.add(sBody.tenant.id as string);
    const preMoveJar = jarFrom(s);
    const preMoveCookie = cookieValue(s, 'bseo_token');
    expect(preMoveCookie).toBeTruthy();
    const v = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify',
      payload: { token: sBody.verifyToken },
    });
    expect(v.statusCode).toBe(200);

    // Accept authenticated ONLY by the pre-move cookie (browser flow).
    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations/accept',
      headers: preMoveJar,
      payload: { token: invToken },
    });
    expect(accept.statusCode).toBe(200);
    const acceptBody = accept.json() as any;
    expect(acceptBody.tenantId).toBe(owner.tenantId);
    // Body token kept for API clients…
    expect(typeof acceptBody.token).toBe('string');
    // …and the SAME fresh token must arrive as the httpOnly session cookie.
    const setCookieRaw = accept.headers['set-cookie'];
    const setCookieList: string[] = Array.isArray(setCookieRaw) ? setCookieRaw : setCookieRaw ? [setCookieRaw] : [];
    const authCookie = setCookieList.find((c: string) => c.startsWith('bseo_token='));
    expect(authCookie).toBeTruthy();
    expect(authCookie!.toLowerCase()).toContain('httponly');
    const newCookie = cookieValue(accept, 'bseo_token');
    expect(newCookie).toBe(acceptBody.token);
    expect(newCookie).not.toBe(preMoveCookie);

    // A subsequent cookie-only request succeeds WITHOUT re-login and is
    // bound to the NEW tenant.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: jarFrom(accept),
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as any).tenant.id).toBe(owner.tenantId);

    // The pre-move cookie is dead after the move (tenant binding).
    const stale = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: preMoveJar,
    });
    expect(stale.statusCode).toBe(401);
  });

  it('invitations: editor cannot invite admin; same-tenant member re-invite is 409', async () => {
    const owner = await signupVerified(app);
    tc.add(owner.tenantId);

    // Seed an editor member.
    const editorEmail = uniqueEmail('ed');
    const invEd = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations',
      headers: auth(owner.token),
      payload: { email: editorEmail, role: 'editor' },
    });
    const editor = await signupVerified(app, editorEmail);
    tc.add(editor.tenantId);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations/accept',
      headers: auth(editor.token),
      payload: { token: (invEd.json() as any).token },
    });
    expect(accepted.statusCode).toBe(200);
    const editorToken = (accepted.json() as any).token as string;

    // Editor inviting an admin (above own role) -> 403.
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations',
      headers: auth(editorToken),
      payload: { email: uniqueEmail('x'), role: 'admin' },
    });
    expect(denied.statusCode).toBe(403);

    // Editor CAN invite a viewer.
    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations',
      headers: auth(editorToken),
      payload: { email: uniqueEmail('y'), role: 'viewer' },
    });
    expect(ok.statusCode).toBe(202);

    // Inviting an email that is ALREADY A MEMBER OF THIS TENANT -> 409.
    // (Changed expectation context, F-09 enumeration fix: this 409 is kept
    // ONLY for same-tenant members, whom the caller can already see in the
    // member list. Cross-tenant existence must NOT be revealed — see the
    // enumeration regression test below, which now expects a generic 202
    // where the old code returned 409 USER_EXISTS.)
    const dupe = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations',
      headers: auth(owner.token),
      payload: { email: editorEmail, role: 'viewer' },
    });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.code).toBe('USER_EXISTS');
  });

  it('SECURITY regression (F-09): inviting an email registered in ANOTHER tenant does not enumerate it', async () => {
    const owner = await signupVerified(app);
    tc.add(owner.tenantId);
    // A user who exists platform-wide but belongs to a different tenant.
    const stranger = await signupVerified(app);
    tc.add(stranger.tenantId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations',
      headers: auth(owner.token),
      payload: { email: stranger.email, role: 'viewer' },
    });
    // Generic 202 — NOT the old 409 USER_EXISTS, no hint in the body.
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ ok: true });
    expect(res.body).not.toContain('USER_EXISTS');
    expect(res.body).not.toContain('already has an account');

    // The invitation WAS created (and emailed) so the accept flow still
    // works for the invitee via the emailed link.
    const inv = await query(`SELECT COUNT(*)::int c FROM team_invitations WHERE tenant_id = $1 AND email = $2`, [
      owner.tenantId,
      stranger.email,
    ]);
    expect(inv.rows[0].c).toBe(1);

    // NEW-2 regression: a genuinely new email gets the IDENTICAL 202
    // status and IDENTICAL body shape (the old code returned 200 +
    // {id,email,role,expires_at,token} for new emails vs a bare 202
    // for cross-tenant ones — status+shape was still an oracle). In
    // mock mail mode both carry the same debug fields (incl. token);
    // with real SMTP neither would.
    const fresh = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations',
      headers: auth(owner.token),
      payload: { email: uniqueEmail('fresh'), role: 'viewer' },
    });
    expect(fresh.statusCode).toBe(202);
    expect((fresh.json() as any).token).toMatch(/^[0-9a-f]{64}$/);
    expect((res.json() as any).token).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(fresh.json() as any).sort()).toEqual(Object.keys(res.json() as any).sort());
    expect((fresh.json() as any).message).toBe((res.json() as any).message);
  });

  it('SECURITY regression (F-09): concurrent double-accept of one invitation succeeds exactly once', async () => {
    const owner = await signupVerified(app);
    tc.add(owner.tenantId);
    const inviteEmail = uniqueEmail('dbl');
    const inv = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations',
      headers: auth(owner.token),
      payload: { email: inviteEmail, role: 'editor' },
    });
    expect(inv.statusCode).toBe(202);
    const invitee = await signupVerified(app, inviteEmail);
    tc.add(invitee.tenantId);

    const results = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/account/invitations/accept',
        headers: auth(invitee.token),
        payload: { token: (inv.json() as any).token },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/account/invitations/accept',
        headers: auth(invitee.token),
        payload: { token: (inv.json() as any).token },
      }),
    ]);
    const successes = results.filter((r) => r.statusCode === 200);
    expect(successes).toHaveLength(1);
    const loser = results.find((r) => r.statusCode !== 200)!;
    // Loser: 410 (lost the atomic accepted_at claim) or 401 (its pre-move
    // token no longer binds to the moved user) — never a second success.
    expect([401, 410]).toContain(loser.statusCode);

    const members = await query(`SELECT COUNT(*)::int c FROM users WHERE tenant_id = $1 AND email = $2`, [
      owner.tenantId,
      inviteEmail,
    ]);
    expect(members.rows[0].c).toBe(1);
    const invRow = await query(`SELECT accepted_at FROM team_invitations WHERE tenant_id = $1 AND email = $2`, [
      owner.tenantId,
      inviteEmail,
    ]);
    expect(invRow.rows[0].accepted_at).not.toBeNull();
  });

  it('REGRESSION: shell tenant with a billing footprint is NOT dissolved on invite accept (409, billing rows survive)', async () => {
    const owner = await signupVerified(app);
    tc.add(owner.tenantId);
    const inviteEmail = uniqueEmail('billed');
    const inv = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations',
      headers: auth(owner.token),
      payload: { email: inviteEmail, role: 'editor' },
    });
    expect(inv.statusCode).toBe(202);

    // Invitee signs up fresh: sole user of a shell tenant with ZERO sites
    // (the old guard's only check) — but with a paid billing footprint.
    const invitee = await signupVerified(app, inviteEmail);
    tc.add(invitee.tenantId);
    await query(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, plan_id, status)
       VALUES (gen_random_uuid(), $1, $2, 'pro', 'active')`,
      [invitee.tenantId, `sub_billed_${Date.now()}`],
    );
    await query(
      `INSERT INTO invoices (tenant_id, stripe_invoice_id, status, amount_due_cents)
       VALUES ($1, $2, 'paid', 4900)`,
      [invitee.tenantId, `in_billed_${Date.now()}`],
    );
    await query(
      `INSERT INTO tenant_credits (tenant_id, amount_cents, reason) VALUES ($1, 1000, 'goodwill')`,
      [invitee.tenantId],
    );

    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations/accept',
      headers: auth(invitee.token),
      payload: { token: (inv.json() as any).token },
    });
    // Move refused — dissolving the shell would cascade-delete the
    // billing rows, so the accept is blocked like any other orphan guard.
    expect(accept.statusCode).toBe(409);
    expect(accept.json().error.code).toBe('INVITE_WOULD_ORPHAN_DATA');

    // Shell tenant + every billing row survive; the user did not move
    // and the invitation was not burned (guards run before the claim).
    const shell = await query(`SELECT COUNT(*)::int c FROM tenants WHERE id = $1`, [invitee.tenantId]);
    expect(shell.rows[0].c).toBe(1);
    const subs = await query(`SELECT COUNT(*)::int c FROM subscriptions WHERE tenant_id = $1`, [invitee.tenantId]);
    expect(subs.rows[0].c).toBe(1);
    const invs = await query(`SELECT COUNT(*)::int c FROM invoices WHERE tenant_id = $1`, [invitee.tenantId]);
    expect(invs.rows[0].c).toBe(1);
    const credits = await query(`SELECT COUNT(*)::int c FROM tenant_credits WHERE tenant_id = $1`, [invitee.tenantId]);
    expect(credits.rows[0].c).toBe(1);
    const me = await query(`SELECT tenant_id FROM users WHERE id = $1`, [invitee.userId]);
    expect(me.rows[0].tenant_id).toBe(invitee.tenantId);
    const invRow = await query(`SELECT accepted_at FROM team_invitations WHERE tenant_id = $1 AND email = $2`, [
      owner.tenantId,
      inviteEmail,
    ]);
    expect(invRow.rows[0].accepted_at).toBeNull();
  });

  it('REGRESSION (NEW-1): shell with ONLY usage_events + a workspace is NOT dissolved (complete guard, transactional)', async () => {
    const owner = await signupVerified(app);
    tc.add(owner.tenantId);
    const inviteEmail = uniqueEmail('shelldata');
    const inv = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations',
      headers: auth(owner.token),
      payload: { email: inviteEmail, role: 'editor' },
    });
    expect(inv.statusCode).toBe(202);
    const inviteToken = (inv.json() as any).token as string;

    // Invitee's shell: NO sites, NO billing rows — only a usage_events
    // row and a workspace. The old guard (subscriptions/invoices/
    // credits + sites only) dissolved this shell and cascade-lost both.
    const invitee = await signupVerified(app, inviteEmail);
    tc.add(invitee.tenantId);
    await query(
      `INSERT INTO usage_events (id, tenant_id, event_type, units) VALUES (gen_random_uuid(), $1, 'serp_check', 3)`,
      [invitee.tenantId],
    );
    await query(
      `INSERT INTO workspaces (id, tenant_id, name) VALUES (gen_random_uuid(), $1, 'Shell Client')`,
      [invitee.tenantId],
    );

    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations/accept',
      headers: auth(invitee.token),
      payload: { token: inviteToken },
    });
    expect(accept.statusCode).toBe(409);
    expect(accept.json().error.code).toBe('INVITE_WOULD_ORPHAN_DATA');

    // Everything intact: shell tenant, both rows, user unmoved, and the
    // invitation NOT burned (transaction rolled back before the claim).
    const shell = await query(`SELECT COUNT(*)::int c FROM tenants WHERE id = $1`, [invitee.tenantId]);
    expect(shell.rows[0].c).toBe(1);
    const usage = await query(`SELECT COUNT(*)::int c FROM usage_events WHERE tenant_id = $1`, [invitee.tenantId]);
    expect(usage.rows[0].c).toBe(1);
    const wss = await query(`SELECT COUNT(*)::int c FROM workspaces WHERE tenant_id = $1`, [invitee.tenantId]);
    expect(wss.rows[0].c).toBe(1);
    const me = await query(`SELECT tenant_id FROM users WHERE id = $1`, [invitee.userId]);
    expect(me.rows[0].tenant_id).toBe(invitee.tenantId);
    const invRow = await query(`SELECT accepted_at FROM team_invitations WHERE tenant_id = $1 AND email = $2`, [
      owner.tenantId,
      inviteEmail,
    ]);
    expect(invRow.rows[0].accepted_at).toBeNull();

    // Once the shell is genuinely emptied, the SAME invitation accepts
    // (proving it stayed usable) and the now-empty shell dissolves.
    await query(`DELETE FROM usage_events WHERE tenant_id = $1`, [invitee.tenantId]);
    await query(`DELETE FROM workspaces WHERE tenant_id = $1`, [invitee.tenantId]);
    const retry = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations/accept',
      headers: auth(invitee.token),
      payload: { token: inviteToken },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ tenantId: owner.tenantId, role: 'editor' });
    const gone = await query(`SELECT COUNT(*)::int c FROM tenants WHERE id = $1`, [invitee.tenantId]);
    expect(gone.rows[0].c).toBe(0);
  });

  it('members: role change, removal, last-owner protection', async () => {
    const owner = await signupVerified(app);
    tc.add(owner.tenantId);
    const memberEmail = uniqueEmail('member');
    const inv = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations',
      headers: auth(owner.token),
      payload: { email: memberEmail, role: 'viewer' },
    });
    const member = await signupVerified(app, memberEmail);
    tc.add(member.tenantId);
    const accepted = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations/accept',
      headers: auth(member.token),
      payload: { token: (inv.json() as any).token },
    });
    expect(accepted.statusCode).toBe(200);
    const memberToken = (accepted.json() as any).token as string;

    // Promote viewer -> editor.
    const members = (await app.inject({
      method: 'GET',
      url: '/api/v1/account/members',
      headers: auth(owner.token),
    })).json() as any;
    const memberId = members.data.find((m: any) => m.email === memberEmail).id;
    const promote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/account/members/${memberId}`,
      headers: auth(owner.token),
      payload: { role: 'editor' },
    });
    expect(promote.statusCode).toBe(200);

    // Editor cannot change roles (needs owner/admin).
    const denied = await app.inject({
      method: 'PATCH',
      url: `/api/v1/account/members/${memberId}`,
      headers: auth(memberToken),
      payload: { role: 'viewer' },
    });
    expect(denied.statusCode).toBe(403);

    // Removing the last owner is blocked.
    const ownerRow = members.data.find((m: any) => m.role === 'owner');
    const rmOwner = await app.inject({
      method: 'DELETE',
      url: `/api/v1/account/members/${ownerRow.id}`,
      headers: auth(owner.token),
    });
    expect(rmOwner.statusCode).toBe(400);
    expect(rmOwner.json().error.code).toBe('LAST_OWNER');

    // Removing the editor works.
    const rm = await app.inject({
      method: 'DELETE',
      url: `/api/v1/account/members/${memberId}`,
      headers: auth(owner.token),
    });
    expect(rm.statusCode).toBe(200);
  });

  it('workspaces: create, assign site, per-client limits, activity log', async () => {
    const owner = await signupVerified(app);
    tc.add(owner.tenantId);

    const ws = await app.inject({
      method: 'POST',
      url: '/api/v1/account/workspaces',
      headers: auth(owner.token),
      payload: { name: 'Client A', limits: { max_sites: 1 } },
    });
    expect(ws.statusCode).toBe(200);
    const wsId = (ws.json() as any).id as string;

    // Duplicate name -> 409.
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/account/workspaces',
      headers: auth(owner.token),
      payload: { name: 'Client A' },
    });
    expect(dup.statusCode).toBe(409);

    // Create two sites (starter plan allows 1 at tenant level — bump the
    // tenant to pro for this test so plan limits don't interfere).
    await query(`UPDATE tenants SET plan_id = 'pro' WHERE id = $1`, [owner.tenantId]);
    const mkSite = async (domain: string) => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/v1/sites',
        headers: auth(owner.token),
        payload: { domain },
      });
      expect(r.statusCode).toBe(201);
      return (r.json() as any).id as string;
    };
    const s1 = await mkSite(`ws1-${Date.now()}.test`);
    const s2 = await mkSite(`ws2-${Date.now()}.test`);

    const a1 = await app.inject({
      method: 'POST',
      url: `/api/v1/account/workspaces/${wsId}/sites`,
      headers: auth(owner.token),
      payload: { siteId: s1 },
    });
    expect(a1.statusCode).toBe(200);

    // Second site exceeds the workspace's max_sites: 1 -> 402.
    const a2 = await app.inject({
      method: 'POST',
      url: `/api/v1/account/workspaces/${wsId}/sites`,
      headers: auth(owner.token),
      payload: { siteId: s2 },
    });
    expect(a2.statusCode).toBe(402);
    expect(a2.json().error.code).toBe('LIMIT_EXCEEDED');

    // Activity log captured the workspace + assignment events.
    const act = await app.inject({
      method: 'GET',
      url: '/api/v1/account/activity',
      headers: auth(owner.token),
    });
    expect(act.statusCode).toBe(200);
    const actions = (act.json() as any).data.map((a: any) => a.action);
    expect(actions).toContain('workspace.created');
    expect(actions).toContain('workspace.site_assigned');

    // Cross-tenant workspace access is 404 (no existence leak).
    const stranger = await signupVerified(app);
    tc.add(stranger.tenantId);
    const x = await app.inject({
      method: 'PATCH',
      url: `/api/v1/account/workspaces/${wsId}`,
      headers: auth(stranger.token),
      payload: { name: 'Hacked' },
    });
    expect(x.statusCode).toBe(404);
  });

  it('workspace isolation: tenant B cannot touch tenant A workspaces', async () => {
    const a = await signupVerified(app);
    const b = await signupVerified(app);
    tc.add(a.tenantId, b.tenantId);
    const ws = await app.inject({
      method: 'POST',
      url: '/api/v1/account/workspaces',
      headers: auth(a.token),
      payload: { name: 'Secret Client' },
    });
    const wsId = (ws.json() as any).id as string;
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/account/workspaces/${wsId}`,
      headers: auth(b.token),
    });
    expect(del.statusCode).toBe(404);
  });
});
