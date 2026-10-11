// Backend-B Wave 2 — F-07 competitor analysis tests.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { query } from '../src/db.js';
import {
  ensureTestDb, truncateAll, createTestUser, loginAs, authHeaders,
} from './helpers.js';

let app: FastifyInstance;
let token: string;
let tenantId: string;
let siteId: string;

async function seedRankData(): Promise<void> {
  const kw = await query(
    `INSERT INTO keywords (id, tenant_id, site_id, keyword, volume) VALUES (gen_random_uuid(), $1, $2, 'plumber austin', 1200) RETURNING id`,
    [tenantId, siteId],
  );
  const kwId = kw.rows[0].id as string;
  const snap = await query(
    `INSERT INTO serp_snapshots (id, cache_key, keyword, items, features)
     VALUES (gen_random_uuid(), 'f07-snap-1', 'plumber austin',
       '[{"position":3,"domain":"rivalco.com"},{"position":25,"domain":"acme7.com"}]',
       '[]') RETURNING id`,
  );
  const snapId = snap.rows[0].id as string;
  await query(
    `INSERT INTO rank_checks (id, tenant_id, keyword_id, position, snapshot_id)
     VALUES (gen_random_uuid(), $1, $2, 25, $3)`,
    [tenantId, kwId, snapId],
  );
}

beforeAll(async () => {
  await ensureTestDb();
  await truncateAll();
  app = await buildApp();
  const u = await createTestUser('bb-f07@example.com', { verified: true });
  tenantId = u.tenantId;
  token = await loginAs(app, 'bb-f07@example.com');
  const s = await query(
    `INSERT INTO sites (id, tenant_id, domain, verified) VALUES (gen_random_uuid(), $1, 'acme7.com', TRUE) RETURNING id`,
    [tenantId],
  );
  siteId = s.rows[0].id as string;
  await seedRankData();
}, 60000);

afterAll(async () => {
  await app.close();
});

describe('F-07 competitor analysis', () => {
  it('CRUDs competitors', async () => {
    const create = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/competitors`,
      headers: authHeaders(token), payload: { domain: 'RivalCo.com', label: 'main rival' },
    });
    expect(create.statusCode).toBe(200);
    expect(create.json().domain).toBe('rivalco.com');
    const cid = create.json().id;
    const dup = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/competitors`,
      headers: authHeaders(token), payload: { domain: 'rivalco.com' },
    });
    expect(dup.statusCode).toBe(400);
    const selfAdd = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/competitors`,
      headers: authHeaders(token), payload: { domain: 'acme7.com' },
    });
    expect(selfAdd.statusCode).toBe(400);
    const list = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/competitors`, headers: authHeaders(token),
    });
    expect(list.json().total).toBe(1);
    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/sites/${siteId}/competitors/${cid}`, headers: authHeaders(token),
    });
    expect(del.statusCode).toBe(204);
    // re-add for the comparison tests
    await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/competitors`,
      headers: authHeaders(token), payload: { domain: 'rivalco.com' },
    });
  });

  it('compares visibility against competitors', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/competitors/compare`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.competitors).toContain('rivalco.com');
    expect(body.keywords[0].competitors['rivalco.com']).toBe(3);
    expect(body.keywords[0].sitePosition).toBe(25);
    const summary = Object.fromEntries(body.summary.map((s: { domain: string; visibilitySharePct: number }) => [s.domain, s.visibilitySharePct]));
    expect(summary['rivalco.com']).toBeGreaterThan(summary['acme7.com']);
  });

  it('finds keyword gaps', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/competitors/keyword-gaps`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().gaps[0].competitor).toBe('rivalco.com');
    expect(res.json().gaps[0].keyword).toBe('plumber austin');
  });

  it('finds content gaps for uncovered keywords', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/competitors/content-gaps`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().gaps[0].suggestion).toContain('plumber austin');
  });

  it('compares backlinks honestly', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/competitors/backlinks`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().competitors[0].data).toBe('unavailable');
    expect(res.json().note).toContain('not wired');
  });
});
