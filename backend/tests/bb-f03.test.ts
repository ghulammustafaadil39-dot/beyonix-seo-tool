// Backend-B Wave 2 — F-03 keyword v2 API tests (DB-backed, mock provider).
// Covers: seed expansion, clusters, question filter, cannibalization,
// keyword gap (mock-labeled), lists/tags CRUD, bulk import/export.
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

beforeAll(async () => {
  await ensureTestDb();
  await truncateAll();
  app = await buildApp();
  const u = await createTestUser('bb-f03@example.com', { verified: true });
  tenantId = u.tenantId;
  token = await loginAs(app, 'bb-f03@example.com');
  const s = await query(
    `INSERT INTO sites (id, tenant_id, domain, verified) VALUES (gen_random_uuid(), $1, 'example.com', TRUE) RETURNING id`,
    [tenantId],
  );
  siteId = s.rows[0].id as string;
}, 60000);

afterAll(async () => {
  await app.close();
});

describe('F-03 keyword v2', () => {
  it('expands seeds into long-tail/question variants with metrics', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/keywords/expand`,
      headers: authHeaders(token), payload: { seeds: ['seo audit'] },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.length).toBeGreaterThan(5);
    expect(data.every((k: any) => k.added_from === 'expansion')).toBe(true);
    expect(data.some((k: any) => k.keyword.includes('seo audit'))).toBe(true);
    expect(data[0].volume).not.toBeNull();
  });

  it('clusters keywords by topic with intent mix', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/keywords/clusters`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    const clusters = res.json().data;
    expect(clusters.length).toBeGreaterThan(0);
    expect(clusters[0].keywords.length).toBeGreaterThan(0);
    expect(typeof clusters[0].total_volume).toBe('number');
  });

  it('filters question keywords', async () => {
    await query(
      `INSERT INTO keywords (id, tenant_id, site_id, keyword, intent, priority_score, added_from)
       VALUES (gen_random_uuid(), $1, $2, 'how to do a seo audit', 'informational', 80, 'manual'),
              (gen_random_uuid(), $1, $2, 'best seo tools', 'commercial', 70, 'manual')`,
      [tenantId, siteId],
    );
    const res = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/keywords/questions`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    const kws = res.json().data.map((k: any) => k.keyword);
    expect(kws).toContain('how to do a seo audit');
    expect(kws).not.toContain('best seo tools');
  });

  it('detects same-URL cannibalization across tracked keywords', async () => {
    const k1 = (await query(
      `INSERT INTO keywords (id, tenant_id, site_id, keyword, tracked) VALUES (gen_random_uuid(), $1, $2, 'cannibal one', TRUE) RETURNING id`,
      [tenantId, siteId])).rows[0].id;
    const k2 = (await query(
      `INSERT INTO keywords (id, tenant_id, site_id, keyword, tracked) VALUES (gen_random_uuid(), $1, $2, 'cannibal two', TRUE) RETURNING id`,
      [tenantId, siteId])).rows[0].id;
    for (const kid of [k1, k2]) {
      await query(
        `INSERT INTO rank_checks (id, tenant_id, keyword_id, position, url) VALUES (gen_random_uuid(), $1, $2, 3, 'https://example.com/same-page')`,
        [tenantId, kid]);
    }
    const res = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/keywords/cannibalization`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    const hits = res.json().data;
    expect(hits.some((h: any) => h.kind === 'same-url-multiple-keywords')).toBe(true);
  });

  it('computes keyword gap vs a competitor (honestly labeled mock)', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/keywords/gap?competitor=rival.com`,
      headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dataSource).toBe('mock');
    expect(body.gaps.length).toBeGreaterThan(0);
    expect(body.gaps[0].competitor_position).toBeGreaterThan(0);
    // second call is served from cache
    const res2 = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/keywords/gap?competitor=rival.com`,
      headers: authHeaders(token),
    });
    expect(res2.json().dataSource).toBe('mock');
    expect(res2.json().gaps.length).toBe(body.gaps.length);
  });

  it('CRUDs keyword lists with tags and members', async () => {
    const create = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/keyword-lists`,
      headers: authHeaders(token), payload: { name: 'Prio', tags: ['SEO', ' q1 '] },
    });
    expect(create.statusCode).toBe(201);
    const listId = create.json().list.id;
    expect(create.json().list.tags).toEqual(['seo', 'q1']);

    const kw = (await query(`SELECT id FROM keywords WHERE site_id = $1 LIMIT 1`, [siteId])).rows[0];
    const add = await app.inject({
      method: 'POST', url: `/api/v1/keyword-lists/${listId}/keywords`,
      headers: authHeaders(token), payload: { keywordIds: [kw.id] },
    });
    expect(add.json().added).toBe(1);

    const members = await app.inject({
      method: 'GET', url: `/api/v1/keyword-lists/${listId}/keywords`, headers: authHeaders(token),
    });
    expect(members.json().total).toBe(1);

    const patch = await app.inject({
      method: 'PATCH', url: `/api/v1/keyword-lists/${listId}`,
      headers: authHeaders(token), payload: { tags: ['updated'] },
    });
    expect(patch.json().list.tags).toEqual(['updated']);

    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/keyword-lists/${listId}`, headers: authHeaders(token),
    });
    expect(del.json().deleted).toBe(true);
  });

  it('bulk-imports and exports keywords as CSV', async () => {
    const imp = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/keywords/import`,
      headers: authHeaders(token), payload: { csv: 'bulk kw one\nbulk kw two, bulk kw three\n\nbulk kw one' },
    });
    expect(imp.statusCode).toBe(200);
    expect(imp.json().imported).toBe(3);

    const exp = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/keywords/export`, headers: authHeaders(token),
    });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-type']).toContain('text/csv');
    expect(exp.body).toContain('bulk kw one');
  });
});
