/**
 * A1-H1 regression (concurrency half): two concurrent POST
 * /sites/:id/audits → exactly one 201 and one 409, and exactly ONE audit
 * row in the DB. (Real enqueue — Redis DB 1.)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, query, authz, signupOwner, createSite } from './helpers.js';
import { resetDb } from '../integration/helpers/db.js';
import { getTestRedis } from '../integration/helpers/redis.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  await getTestRedis().flushdb();
});

describe('A1-H1: concurrent double-submit', () => {
  it('one 201 + one 409, single audit row, no orphan', async () => {
    const owner = await signupOwner(app);
    const siteId = await createSite(app, owner);

    const fire = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/sites/${siteId}/audits`,
        headers: authz(owner),
        payload: {},
      });
    const [r1, r2] = await Promise.all([fire(), fire()]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const okBody = r1.statusCode === 201 ? r1.json() : r2.json();
    const errBody = r1.statusCode === 409 ? r1.json() : r2.json();
    expect((errBody as any).error.code).toBe('AUDIT_RUNNING');

    const rows = (
      await query(`SELECT id, status FROM audits WHERE site_id = $1`, [siteId])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(['queued', 'running', 'completed']).toContain(rows[0].status);

    // A second, later trigger still sees exactly one active audit (409),
    // never a permanent orphan pile-up.
    const again = await fire();
    expect(again.statusCode).toBe(409);
    expect((await query(`SELECT COUNT(*)::int AS n FROM audits WHERE site_id = $1`, [siteId])).rows[0].n).toBe(1);
    expect(okBody).toBeDefined();
  });
});
