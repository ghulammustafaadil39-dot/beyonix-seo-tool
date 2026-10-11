// W-04: insights engine — prioritized actions from seeded audit/rank data,
// drop diagnosis correlates, forecast honestly labeled as projection.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { pool, query, runMigrations } from '../src/db.js';
import { signupVerified, tenantCollector, auth } from './helpers-ba.js';
import { linearSlope } from '../src/services/insights.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

describe.runIf(HAS_TEST_DB)('W-04 insights engine', () => {
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

  it('linearSlope is correct on a simple series', () => {
    expect(linearSlope([1, 2, 3, 4])).toBeCloseTo(1, 5);
    expect(linearSlope([5, 5, 5])).toBeCloseTo(0, 5);
    expect(linearSlope([5])).toBe(0);
  });

  it('ranks critical issues + rank drops with diagnosis, forecast labeled projection', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const s = await app.inject({ method: 'POST', url: '/api/v1/sites', headers: auth(u.token), payload: { domain: `insights-${Date.now()}.com` } });
    const siteId = (s.json() as any).id as string;
    // Audit with 2 open error issues.
    const audit = (await query(`INSERT INTO audits (id,tenant_id,site_id,status,finished_at) VALUES (gen_random_uuid(),$1,$2,'done',now()) RETURNING id`, [u.tenantId, siteId])).rows[0].id as string;
    for (let i = 0; i < 2; i++) {
      await query(`INSERT INTO audit_issues (id,tenant_id,audit_id,site_id,type,severity,url,detail,fix_suggestion,status) VALUES (gen_random_uuid(),$1,$2,$3,'missing_title','error','https://x/','d','f','open')`, [u.tenantId, audit, siteId]);
    }
    // Three keywords: prev 5 -> now 25 (site-wide drop), one stable.
    const mk = async (name: string, prev: number, now: number | null, url: string) => {
      const kw = (await query(`INSERT INTO keywords (id,tenant_id,site_id,keyword,tracked,volume) VALUES (gen_random_uuid(),$1,$2,$3,TRUE,2000) RETURNING id`, [u.tenantId, siteId, name])).rows[0].id as string;
      await query(`INSERT INTO rank_checks (id,tenant_id,keyword_id,position,url,checked_at) VALUES (gen_random_uuid(),$1,$2,$3,$4, now() - interval '2 days')`, [u.tenantId, kw, prev, url]);
      await query(`INSERT INTO rank_checks (id,tenant_id,keyword_id,position,url,checked_at) VALUES (gen_random_uuid(),$1,$2,$3,$4, now())`, [u.tenantId, kw, now, url]);
      return kw;
    };
    await mk('insights drop a', 5, 25, 'https://x/a');
    await mk('insights drop b', 6, 26, 'https://x/b');
    await mk('insights drop c', 4, 24, 'https://x/c');
    await mk('insights stable', 3, 3, 'https://x/d');
    // Visibility history so the forecast has data: declining positions -> negative slope.
    for (let d = 0; d < 10; d++) {
      const kw = (await query(`INSERT INTO keywords (id,tenant_id,site_id,keyword,tracked) VALUES (gen_random_uuid(),$1,$2,$3,TRUE) RETURNING id`, [u.tenantId, siteId, `hist-${d}`])).rows[0].id as string;
      await query(`INSERT INTO rank_checks (id,tenant_id,keyword_id,position,checked_at) VALUES (gen_random_uuid(),$1,$2,$3, now() - ($4 || ' days')::interval)`, [u.tenantId, kw, 5 + d, String(d)]);
    }

    const res = await app.inject({ method: 'GET', url: `/api/v1/sites/${siteId}/insights`, headers: auth(u.token) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.engine).toBe('rules-v1');
    // All actions honestly labeled computed.
    for (const a of body.actions) expect(a.source).toBe('computed');
    // Ranking: rank drops outrank the audit-issue action? (drops: priority 70+20; issues 82+2)
    // With 3 keywords dropping 20 -> 90/91; issues -> 84-94. Either order is
    // deterministic: check types present + sorted desc by priority.
    const types = body.actions.map((a: any) => a.type);
    expect(types).toContain('rank_drop');
    expect(types).toContain('critical_audit_issue');
    const prios = body.actions.map((a: any) => a.priority);
    for (let i = 1; i < prios.length; i++) expect(prios[i - 1]).toBeGreaterThanOrEqual(prios[i]);
    const drops = body.actions.filter((a: any) => a.type === 'rank_drop');
    expect(drops.length).toBe(3);
    // Diagnosis correlates: 3 drops same check -> site-wide pattern text.
    const ev = drops[0].evidence;
    expect(ev.from).toBeLessThan(ev.to);
    expect(JSON.stringify(ev.correlates)).toMatch(/site-wide/i);
    // Forecast: labeled projection, never a promise.
    expect(body.forecast.kind).toBe('projection');
    expect(body.forecast.label).toMatch(/NOT a guarantee/i);
    expect(body.forecast.method.length).toBeGreaterThan(10);
  });

  it('tenant isolation: other tenant gets 404', async () => {
    const a = await signupVerified(app); tc.add(a.tenantId);
    const b = await signupVerified(app); tc.add(b.tenantId);
    const s = await app.inject({ method: 'POST', url: '/api/v1/sites', headers: auth(a.token), payload: { domain: `iso-${Date.now()}.com` } });
    const siteId = (s.json() as any).id as string;
    const res = await app.inject({ method: 'GET', url: `/api/v1/sites/${siteId}/insights`, headers: auth(b.token) });
    expect(res.statusCode).toBe(404);
  });

  it('unauthenticated access is 401', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/sites/00000000-0000-0000-0000-000000000000/insights` });
    expect(res.statusCode).toBe(401);
  });
});
