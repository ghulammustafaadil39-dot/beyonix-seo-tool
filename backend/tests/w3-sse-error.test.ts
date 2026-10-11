// W-05 SSE SEC-FIX (Wave-3): the error event must never echo internal
// error text (Postgres internals) to the wire, and a failing emit must
// close the stream cleanly instead of throwing on a dead socket.
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../src/services/jobStream.js', () => ({
  collectJobsSnapshot: async () => {
    // A pg-flavored failure, as it would arrive from a real DB blowup.
    const e = new Error('relation "geo_checks" does not exist') as Error & { code: string };
    e.code = '42P01';
    throw e;
  },
  snapshotHash: () => 'mocked',
}));

import { buildApp } from '../src/index.js';
import { pool, query, runMigrations } from '../src/db.js';
import { signupVerified, tenantCollector, auth } from './helpers-ba.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

describe.runIf(HAS_TEST_DB)('W-05 SSE error surface (SEC-FIX)', () => {
  let app: FastifyInstance;
  const tc = tenantCollector();
  beforeAll(async () => {
    process.env.SSE_POLL_MS = '250';
    await runMigrations();
    app = await buildApp();
  }, 60000);
  afterAll(async () => {
    delete process.env.SSE_POLL_MS;
    await app?.close();
    if (tc.ids.length) await query('DELETE FROM tenants WHERE id = ANY($1)', [tc.ids]);
    await pool.end();
  });

  it('error event carries a generic message — no pg internals on the wire', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const s = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: auth(u.token),
      payload: { domain: `sseerr-${Date.now()}.com` },
    });
    const siteId = (s.json() as any).id as string;

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${siteId}/jobs/stream`,
      headers: auth(u.token),
      timeout: 20000,
    } as any);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const body = res.body as string;
    expect(body).toMatch(/event: error/);
    const data = JSON.parse(body.match(/event: error\ndata: ([^\n]+)/)![1]);
    // Generic message; the pg relation/code must not leak.
    expect(data.message).toBe('internal error');
    expect(body).not.toContain('geo_checks');
    expect(body).not.toContain('42P01');
    // The stream terminated cleanly after the error (no hang, no throw).
  });
});
