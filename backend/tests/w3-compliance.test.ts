// W-07: GDPR export completeness, account ERASE, retention controls, security.txt.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { pool, query, runMigrations } from '../src/db.js';
import { signupVerified, tenantCollector, auth } from './helpers-ba.js';
import { securityTxtBody } from '../src/routes/wellKnown.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

describe.runIf(HAS_TEST_DB)('W-07 compliance backend', () => {
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

  it('export: complete incl. Wave-2 data (workspaces, api key metadata, reports), no secret columns', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const s = await app.inject({ method: 'POST', url: '/api/v1/sites', headers: auth(u.token), payload: { domain: `exp-${Date.now()}.com` } });
    const siteId = (s.json() as any).id as string;
    await app.inject({ method: 'POST', url: '/api/v1/account/workspaces', headers: auth(u.token), payload: { name: 'WS' } });
    await app.inject({ method: 'POST', url: '/api/v1/apikeys', headers: auth(u.token), payload: { name: 'k', scopes: ['sites:read'] } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/account/export', headers: auth(u.token) });
    expect(res.statusCode).toBe(200);
    const dump = res.json() as any;
    for (const section of ['tenant', 'sites', 'workspaces', 'api_keys', 'webhook_endpoints', 'rank_alerts', 'onboarding_state', 'usage_events', 'activity_log']) {
      expect(dump).toHaveProperty(section);
    }
    // Metadata only for keys — never hashes; no secrets anywhere.
    const keys = dump.api_keys as any[];
    expect(keys.length).toBe(1);
    expect(keys[0]).not.toHaveProperty('key_hash');
    expect(JSON.stringify(dump)).not.toMatch(/llm_api_key_enc|key_hash|secret_enc|gsc_refresh_token_enc|verify_token/);
    expect(dump.tenant[0].id).toBe(u.tenantId);
  });

  it('erase: hard-deletes the tenant and every owned row; other tenants untouched', async () => {
    const a = await signupVerified(app); // kept out of tc: erase removes it
    const b = await signupVerified(app); tc.add(b.tenantId);
    const s = await app.inject({ method: 'POST', url: '/api/v1/sites', headers: auth(a.token), payload: { domain: `erase-${Date.now()}.com` } });
    const siteId = (s.json() as any).id as string;
    await query(`INSERT INTO keywords (id,tenant_id,site_id,keyword,tracked) VALUES (gen_random_uuid(),$1,$2,'erase kw',TRUE)`, [a.tenantId, siteId]);
    await query(`INSERT INTO reports (id,tenant_id,site_id,period_start,period_end,summary) VALUES (gen_random_uuid(),$1,$2,'2026-01-01','2026-01-07','x')`, [a.tenantId, siteId]);
    const bs = await app.inject({ method: 'POST', url: '/api/v1/sites', headers: auth(b.token), payload: { domain: `keep-${Date.now()}.com` } });
    const bSiteId = (bs.json() as any).id as string;

    const bad = await app.inject({ method: 'DELETE', url: '/api/v1/account/erase', headers: auth(a.token), payload: { confirm: 'NO' } });
    expect(bad.statusCode).toBe(400); // explicit confirmation required
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/account/erase', headers: auth(a.token), payload: { confirm: 'ERASE' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.ok).toBe(true);
    expect(body.deleted.sites).toBeGreaterThanOrEqual(1);
    const t = (await query(`SELECT id FROM tenants WHERE id=$1`, [a.tenantId])).rows;
    expect(t.length).toBe(0);
    const kw = (await query(`SELECT COUNT(*)::int c FROM keywords WHERE tenant_id=$1`, [a.tenantId])).rows[0].c;
    expect(Number(kw)).toBe(0);
    const rep = (await query(`SELECT COUNT(*)::int c FROM reports WHERE tenant_id=$1`, [a.tenantId])).rows[0].c;
    expect(Number(rep)).toBe(0);
    // Other tenant untouched.
    const bsites = (await query(`SELECT COUNT(*)::int c FROM sites WHERE tenant_id=$1`, [b.tenantId])).rows[0].c;
    expect(Number(bsites)).toBe(1);
    void bSiteId;
    // And the erased tenant can no longer log in.
    const stillUser = (await query(`SELECT id FROM users WHERE tenant_id=$1`, [a.tenantId])).rows;
    expect(stillUser.length).toBe(0);
  });

  it('erase requires a human session (API keys rejected)', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const k = await app.inject({ method: 'POST', url: '/api/v1/apikeys', headers: auth(u.token), payload: { name: 'k', scopes: ['admin'] } });
    // admin scope is not grantable to keys (400) — use a plain scoped key and expect HUMAN_SESSION_REQUIRED.
    expect(k.statusCode).toBe(400);
    const k2 = await app.inject({ method: 'POST', url: '/api/v1/apikeys', headers: auth(u.token), payload: { name: 'k2', scopes: ['sites:read'] } });
    const raw = (k2.json() as any).key as string;
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/account/erase', headers: { 'x-api-key': raw }, payload: { confirm: 'ERASE' } });
    expect(res.statusCode).toBe(403);
    expect((res.json() as any).error.code).toBe('HUMAN_SESSION_REQUIRED');
  });

  it('retention controls: effective windows readable', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/v1/account/retention', headers: auth(u.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    // Postgres normalizes interval '24 months' to '2 years' in text form.
    expect(String(body.effective['activity_log'])).toMatch(/2 years|24 months/);
    expect(String(body.effective['webhook_deliveries'])).toMatch(/90 days/);
  });

  it('/.well-known/security.txt serves the contact', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/security.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toMatch(/Contact: mailto:security@beyonixsolutions\.com/);
    expect(securityTxtBody(new Date())).toMatch(/Canonical:/);
  });
});
