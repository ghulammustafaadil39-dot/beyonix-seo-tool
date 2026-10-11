import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import type { FastifyInstance } from 'fastify';
import { pool, query, runMigrations } from '../src/db.js';
import { auth, signupVerified, tenantCollector } from './helpers-ba.js';

/**
 * F-14 (admin back-office) backend: tenant list/detail, suspend/unsuspend,
 * impersonate (WITH audit log), feature flags, manual plan override,
 * refund/credit helper, failed jobs + replay, provider spend.
 * Admin-only; 404 (not 403) for non-admins. SECURITY-SENSITIVE — Security
 * Lead review required.
 *
 * Needs DATABASE_URL at a test database (bseo_test_ba) + Redis.
 */
const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

describe.runIf(HAS_TEST_DB)('F-14 admin back-office', () => {
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

  async function platformAdmin() {
    const admin = await signupVerified(app);
    tc.add(admin.tenantId);
    await query(`UPDATE users SET is_platform_admin = TRUE WHERE id = $1`, [admin.userId]);
    return admin;
  }

  it('non-admins get 404 (back-office not discoverable)', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);
    for (const url of ['/api/v1/admin/tenants', '/api/v1/admin/spend', '/api/v1/admin/feature-flags']) {
      const r = await app.inject({ method: 'GET', url, headers: auth(u.token) });
      expect(r.statusCode).toBe(404);
    }
    const unauth = await app.inject({ method: 'GET', url: '/api/v1/admin/tenants' });
    expect(unauth.statusCode).toBe(401);
  });

  it('tenants list + detail; suspend blocks the tenant; unsuspend restores', async () => {
    const admin = await platformAdmin();
    const victim = await signupVerified(app);
    tc.add(victim.tenantId);

    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/tenants', headers: auth(admin.token) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as any).data.some((t: any) => t.id === victim.tenantId)).toBe(true);

    const search = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/tenants?search=${victim.tenantId.slice(0, 8)}`,
      headers: auth(admin.token),
    });
    expect((search.json() as any).data.length).toBeGreaterThanOrEqual(1);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/tenants/${victim.tenantId}`,
      headers: auth(admin.token),
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as any).users.length).toBeGreaterThanOrEqual(1);

    const suspend = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${victim.tenantId}/suspend`,
      headers: auth(admin.token),
      payload: { reason: 'test suspension' },
    });
    expect(suspend.statusCode).toBe(200);

    // Suspended tenant: every authed call is blocked.
    const blocked = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: auth(victim.token) });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('TENANT_SUSPENDED');

    const unsuspend = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${victim.tenantId}/unsuspend`,
      headers: auth(admin.token),
    });
    expect(unsuspend.statusCode).toBe(200);
    const restored = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: auth(victim.token) });
    expect(restored.statusCode).toBe(200);

    // Audit log captured suspend + unsuspend.
    const log = await app.inject({ method: 'GET', url: '/api/v1/admin/audit-log', headers: auth(admin.token) });
    const actions = (log.json() as any).data.map((l: any) => l.action);
    expect(actions).toContain('tenant.suspend');
    expect(actions).toContain('tenant.unsuspend');
  });

  it('manual plan override + credit note helper', async () => {
    const admin = await platformAdmin();
    const u = await signupVerified(app);
    tc.add(u.tenantId);

    const override = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${u.tenantId}/plan`,
      headers: auth(admin.token),
      payload: { planId: 'pro', reason: 'test comp' },
    });
    expect(override.statusCode).toBe(200);
    const t = await query(`SELECT plan_id FROM tenants WHERE id = $1`, [u.tenantId]);
    expect(t.rows[0].plan_id).toBe('pro');

    const badPlan = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${u.tenantId}/plan`,
      headers: auth(admin.token),
      payload: { planId: 'enterprise', reason: 'x' },
    });
    expect(badPlan.statusCode).toBe(400);

    const credit = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/tenants/${u.tenantId}/credit`,
      headers: auth(admin.token),
      payload: { amountCents: 1500, reason: 'goodwill' },
    });
    expect(credit.statusCode).toBe(200);
    expect((credit.json() as any).amount_cents).toBe(1500);
  });

  it('impersonate mints a short-lived token and audit-logs it', async () => {
    const admin = await platformAdmin();
    const u = await signupVerified(app);
    tc.add(u.tenantId);

    const imp = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/impersonate',
      headers: auth(admin.token),
      payload: { tenantId: u.tenantId },
    });
    expect(imp.statusCode).toBe(200);
    const { token } = imp.json() as any;

    // The impersonation token works as the tenant owner (short-lived).
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(token) });
    expect(me.statusCode).toBe(200);
    expect((me.json() as any).tenant.id).toBe(u.tenantId);

    const log = await app.inject({ method: 'GET', url: '/api/v1/admin/audit-log', headers: auth(admin.token) });
    const entry = (log.json() as any).data.find((l: any) => l.action === 'impersonate');
    expect(entry).toBeTruthy();
    expect(entry.target_tenant_id).toBe(u.tenantId);
  });

  it('feature flags get/set', async () => {
    const admin = await platformAdmin();
    const set = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/feature-flags/geo_v2',
      headers: auth(admin.token),
      payload: { enabled: true, description: 'test flag' },
    });
    expect(set.statusCode).toBe(200);
    expect((set.json() as any).enabled).toBe(true);
    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/feature-flags', headers: auth(admin.token) });
    expect((list.json() as any).data.some((f: any) => f.key === 'geo_v2' && f.enabled)).toBe(true);
  });

  it('failed jobs: list, replay re-enqueues, discard closes', async () => {
    const admin = await platformAdmin();
    const r = await query(
      `INSERT INTO dead_letter_jobs (id, queue, job_name, payload, attempts, error, status)
       VALUES (gen_random_uuid(), 'crawl', 'crawl-site', '{"siteId":"s1"}', 3, 'boom', 'pending')
       RETURNING id`,
    );
    const dlId = r.rows[0].id as string;
    const r2 = await query(
      `INSERT INTO dead_letter_jobs (id, queue, job_name, payload, attempts, error, status)
       VALUES (gen_random_uuid(), 'crawl', 'crawl-site', '{"siteId":"s2"}', 3, 'boom', 'pending')
       RETURNING id`,
    );
    const dlId2 = r2.rows[0].id as string;

    const list = await app.inject({ method: 'GET', url: '/api/v1/admin/jobs/failed', headers: auth(admin.token) });
    expect(list.statusCode).toBe(200);
    expect((list.json() as any).data.length).toBeGreaterThanOrEqual(2);

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/jobs/failed/${dlId}/replay`,
      headers: auth(admin.token),
    });
    expect(replay.statusCode).toBe(200);
    const st = await query(`SELECT status FROM dead_letter_jobs WHERE id = $1`, [dlId]);
    expect(st.rows[0].status).toBe('replayed');

    const discard = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/jobs/failed/${dlId2}/discard`,
      headers: auth(admin.token),
    });
    expect(discard.statusCode).toBe(200);

    await query(`DELETE FROM dead_letter_jobs WHERE id = ANY($1)`, [[dlId, dlId2]]);
    // Drain the re-enqueued fake job from Redis.
    const { getQueue } = await import('../src/queues.js');
    await getQueue('crawl').obliterate({ force: true });
  });

  it('provider spend is visible in the admin', async () => {
    const admin = await platformAdmin();
    const u = await signupVerified(app);
    tc.add(u.tenantId);
    const { recordProviderSpend } = await import('../src/metering.js');
    await recordProviderSpend(u.tenantId, 'dataforseo', 'serp', 10, 500);

    const spend = await app.inject({ method: 'GET', url: '/api/v1/admin/spend', headers: auth(admin.token) });
    expect(spend.statusCode).toBe(200);
    const body = spend.json() as any;
    expect(body.data.some((s: any) => s.tenant_id === u.tenantId && s.provider === 'dataforseo')).toBe(true);
    expect(body.totals.some((s: any) => s.provider === 'dataforseo')).toBe(true);
  });
});
