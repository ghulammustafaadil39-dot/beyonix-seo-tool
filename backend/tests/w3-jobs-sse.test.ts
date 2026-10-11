// W-05 backend: SSE job stream — cookie auth, tenant scoping, snapshot
// events, terminal `done` event + close. Progress comes from existing
// audit/report/rank_checks state (no parallel store).
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { pool, query, runMigrations } from '../src/db.js';
import { signupVerified, tenantCollector, auth } from './helpers-ba.js';
import { collectJobsSnapshot, snapshotHash } from '../src/services/jobStream.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

describe.runIf(HAS_TEST_DB)('W-05 SSE job stream', () => {
  let app: FastifyInstance;
  const tc = tenantCollector();
  beforeAll(async () => {
    process.env.SSE_POLL_MS = '250'; // fast tests
    await runMigrations();
    app = await buildApp();
  }, 60000);
  afterAll(async () => {
    delete process.env.SSE_POLL_MS;
    await app?.close();
    if (tc.ids.length) await query('DELETE FROM tenants WHERE id = ANY($1)', [tc.ids]);
    await pool.end();
  });

  it('snapshot service reports settled when no audit is running', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const s = await app.inject({ method: 'POST', url: '/api/v1/sites', headers: auth(u.token), payload: { domain: `sse-${Date.now()}.com` } });
    const siteId = (s.json() as any).id as string;
    const snap = await collectJobsSnapshot(u.tenantId, siteId);
    expect(snap.settled).toBe(true);
    expect(snapshotHash(snap)).toBe(snapshotHash(await collectJobsSnapshot(u.tenantId, siteId)));
    // A running audit un-settles it.
    await query(`INSERT INTO audits (id,tenant_id,site_id,status,started_at) VALUES (gen_random_uuid(),$1,$2,'running',now())`, [u.tenantId, siteId]);
    const snap2 = await collectJobsSnapshot(u.tenantId, siteId);
    expect(snap2.settled).toBe(false);
    expect(snap2.audits[0].progressPct).toBe(50);
  });

  it('stream: settled site returns snapshot + terminal done and ends', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const s = await app.inject({ method: 'POST', url: '/api/v1/sites', headers: auth(u.token), payload: { domain: `ssedone-${Date.now()}.com` } });
    const siteId = (s.json() as any).id as string;
    await query(`INSERT INTO audits (id,tenant_id,site_id,status,score,finished_at) VALUES (gen_random_uuid(),$1,$2,'done',80,now())`, [u.tenantId, siteId]);
    // Bearer <redacted> the same handler path (EventSource itself would use the cookie).
    const res = await app.inject({ method: 'GET', url: `/api/v1/sites/${siteId}/jobs/stream`, headers: auth(u.token), timeout: 20000 } as any);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.body).toMatch(/event: snapshot/);
    expect(res.body).toMatch(/event: done/);
    const data = JSON.parse(res.body.match(/event: done\ndata: ([^\n]+)/)![1]);
    expect(data.settled).toBe(true);
  });

  it('stream: cross-tenant site -> 404', async () => {
    const a = await signupVerified(app); tc.add(a.tenantId);
    const b = await signupVerified(app); tc.add(b.tenantId);
    const s = await app.inject({ method: 'POST', url: '/api/v1/sites', headers: auth(a.token), payload: { domain: `ssex-${Date.now()}.com` } });
    const siteId = (s.json() as any).id as string;
    const res = await app.inject({ method: 'GET', url: `/api/v1/sites/${siteId}/jobs/stream`, headers: auth(b.token), timeout: 20000 } as any);
    expect(res.statusCode).toBe(404);
  });

  it('stream: unauthenticated -> 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/sites/00000000-0000-0000-0000-000000000000/jobs/stream', timeout: 20000 } as any);
    expect(res.statusCode).toBe(401);
  });

  it('stream: cookie auth works (the EventSource path)', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const s = await app.inject({ method: 'POST', url: '/api/v1/sites', headers: auth(u.token), payload: { domain: `ssecookie-${Date.now()}.com` } });
    const siteId = (s.json() as any).id as string;
    const res = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/jobs/stream`,
      headers: { cookie: `bseo_token=${u.token}` }, timeout: 20000,
    } as any);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  });
});
