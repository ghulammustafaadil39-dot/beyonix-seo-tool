// Backend-B Wave 2 — F-06 backlinks v2 tests.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { query } from '../src/db.js';
import { buildDisavowFile } from '../src/services/linkOpportunities.js';
import { analyzeToxicity, TOXIC_THRESHOLD } from '../src/services/toxicLinks.js';
import {
  ensureTestDb, truncateAll, createTestUser, loginAs, authHeaders,
} from './helpers.js';

describe('disavow builder (pure)', () => {
  it('emits domain: directives with a heuristic header', () => {
    const txt = buildDisavowFile([
      { source_url: 'https://spammy.xyz/post', toxic_score: 90 },
      { source_url: 'https://www.spammy.xyz/other', toxic_score: 80 },
    ]);
    expect(txt).toContain('domain:spammy.xyz');
    expect(txt).toContain('HEURISTIC');
    expect(txt.match(/domain:spammy\.xyz/g)).toHaveLength(1); // deduped
  });
  it('flags suspicious patterns', () => {
    const r = analyzeToxicity('https://cheap-backlinks.xyz/buy', 'buy cheap viagra', 'acme.com');
    expect(r.score).toBeGreaterThanOrEqual(TOXIC_THRESHOLD);
    expect(r.flags.length).toBeGreaterThan(0);
  });
});

let app: FastifyInstance;
let token: string;
let siteId: string;

beforeAll(async () => {
  await ensureTestDb();
  await truncateAll();
  app = await buildApp();
  const u = await createTestUser('bb-f06@example.com', { verified: true });
  token = await loginAs(app, 'bb-f06@example.com');
  const s = await query(
    `INSERT INTO sites (id, tenant_id, domain, verified) VALUES (gen_random_uuid(), $1, 'acme6.com', TRUE) RETURNING id`,
    [u.tenantId],
  );
  siteId = s.rows[0].id as string;
}, 60000);

afterAll(async () => {
  await app.close();
});

describe('F-06 backlinks v2 routes', () => {
  it('scores uploads with the heuristic and reports anchors', async () => {
    const csv = [
      'source_url,target_url',
      'https://goodblog.com/post,https://acme6.com/',
      'https://cheap-backlinks.xyz/buy,https://acme6.com/pricing',
    ].join('\n');
    const up = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/backlinks/upload`,
      headers: authHeaders(token), payload: { csv },
    });
    expect(up.statusCode).toBe(200);
    expect(up.json().imported).toBe(2);
    expect(up.json().toxic_heuristic).toBe(true);
    const tox = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/backlinks/toxic`, headers: authHeaders(token),
    });
    expect(tox.statusCode).toBe(200);
    expect(tox.json().heuristic).toBe(true);
    expect(tox.json().links.some((l: { source_url: string }) => l.source_url.includes('cheap-backlinks.xyz'))).toBe(true);
    const anchors = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/backlinks/anchors`, headers: authHeaders(token),
    });
    expect(anchors.statusCode).toBe(200);
    expect(anchors.json().anchors.length).toBeGreaterThan(0);
  });

  it('finds reclaim opportunities from lost links', async () => {
    await query(
      `UPDATE backlinks SET status = 'lost', last_seen = CURRENT_DATE - interval '40 days'
       WHERE site_id = $1 AND source_url LIKE '%goodblog%'`,
      [siteId],
    );
    const res = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/backlinks/opportunities/refresh`,
      headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().heuristic).toBe(true);
    const kinds = res.json().opportunities.map((o: { kind: string }) => o.kind);
    expect(kinds).toContain('reclaim');
  });

  it('downloads a disavow file', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/backlinks/disavow`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('domain:cheap-backlinks.xyz');
    expect(res.body).toContain('HEURISTIC');
  });
});
