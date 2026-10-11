// Backend-B Wave 2 — F-05 GEO v2 tests.
// Pure helpers + DB-backed route tests (mock LLM).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { query } from '../src/db.js';
import {
  analyzeSentiment, extractCitations, detectMention, generateLlmsTxt,
} from '../src/services/geoService.js';
import {
  ensureTestDb, truncateAll, createTestUser, loginAs, authHeaders,
} from './helpers.js';

describe('GEO helpers (pure)', () => {
  it('scores sentiment', () => {
    expect(analyzeSentiment('The best trusted service, highly recommended')).toBe('positive');
    expect(analyzeSentiment('Avoid this terrible scam')).toBe('negative');
    expect(analyzeSentiment('Here are some options to consider')).toBe('neutral');
  });
  it('detects mentions and extracts citations', () => {
    expect(detectMention('Try AcmeCorp for plumbing', 'acmecorp.com')).toBe(true);
    expect(detectMention('Try someone else', 'acmecorp.com')).toBe(false);
    expect(extractCitations('See https://example.org/guide and www.testsite.io for more')).toContain('testsite.io');
  });
  it('generates a valid llms.txt', () => {
    const txt = generateLlmsTxt({
      domain: 'acme.com', siteName: 'Acme', summary: 'Plumbing co.',
      pages: [{ title: 'Services', url: 'https://acme.com/services', description: 'What we do' }],
    });
    expect(txt).toContain('# Acme');
    expect(txt).toContain('- [Services](https://acme.com/services): What we do');
    expect(txt).toContain('Contact: https://acme.com');
  });
});

let app: FastifyInstance;
let token: string;
let siteId: string;

beforeAll(async () => {
  await ensureTestDb();
  await truncateAll();
  app = await buildApp();
  const u = await createTestUser('bb-f05@example.com', { verified: true });
  token = await loginAs(app, 'bb-f05@example.com');
  const s = await query(
    `INSERT INTO sites (id, tenant_id, domain, verified) VALUES (gen_random_uuid(), $1, 'acmetest.com', TRUE) RETURNING id`,
    [u.tenantId],
  );
  siteId = s.rows[0].id as string;
}, 60000);

afterAll(async () => {
  await app.close();
});

describe('F-05 GEO v2 routes', () => {
  it('CRUDs prompt sets', async () => {
    const create = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/geo/prompts`,
      headers: authHeaders(token), payload: { prompt: 'best plumber in town' },
    });
    expect(create.statusCode).toBe(200);
    const pid = create.json().id;
    const dup = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/geo/prompts`,
      headers: authHeaders(token), payload: { prompt: 'best plumber in town' },
    });
    expect(dup.statusCode).toBe(400);
    const list = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/geo/prompts`, headers: authHeaders(token),
    });
    expect(list.json().total).toBe(1);
    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/sites/${siteId}/geo/prompts/${pid}`, headers: authHeaders(token),
    });
    expect(del.statusCode).toBe(204);
    // re-add for the run-set test below
    await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/geo/prompts`,
      headers: authHeaders(token), payload: { prompt: 'best plumber in town' },
    });
  });

  it('runs a check across all 5 engines, labeled simulated', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/geo/check`,
      headers: authHeaders(token),
      payload: { query: 'who is the best plumber', platforms: ['chatgpt', 'perplexity', 'gemini', 'claude', 'ai_overview'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.simulated).toBe(true);
    expect(body.disclaimer).toContain('Simulated estimate');
    expect(body.results).toHaveLength(5);
    for (const r of body.results) {
      expect(r.simulated).toBe(true);
      expect(['positive', 'neutral', 'negative']).toContain(r.sentiment);
    }
    const rows = await query(
      `SELECT sentiment, citations, simulated, engine_version FROM geo_checks WHERE site_id = $1`,
      [siteId],
    );
    expect(rows.rows.length).toBe(5);
    expect(rows.rows[0].simulated).toBe(true);
    expect(typeof rows.rows[0].engine_version).toBe('string');
  });

  it('runs the whole prompt set and returns history', async () => {
    const run = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/geo/run-set`,
      headers: authHeaders(token), payload: { engines: ['chatgpt'], maxPrompts: 2 },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().results).toHaveLength(1);
    const hist = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/geo/history?days=7`, headers: authHeaders(token),
    });
    expect(hist.statusCode).toBe(200);
    expect(hist.json().simulated).toBe(true);
    expect(hist.json().points.length).toBeGreaterThan(0);
  });

  it('computes share-of-voice vs competitors', async () => {
    const u = await query(`SELECT tenant_id FROM sites WHERE id = $1`, [siteId]);
    await query(
      `INSERT INTO competitors (tenant_id, site_id, domain) VALUES ($1, $2, 'rivalco.com')`,
      [u.rows[0].tenant_id, siteId],
    );
    // one more check so the competitor is in the brand map
    await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/geo/check`,
      headers: authHeaders(token), payload: { query: 'compare plumbers', platforms: ['chatgpt'] },
    });
    const res = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/geo/share-of-voice`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().simulated).toBe(true);
    const domains = res.json().rows.map((r: { domain: string }) => r.domain);
    expect(domains).toContain('acmetest.com');
    expect(domains).toContain('rivalco.com');
  });

  it('returns recommendations and generates llms.txt', async () => {
    const recs = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/geo/recommendations`, headers: authHeaders(token),
    });
    expect(recs.statusCode).toBe(200);
    expect(recs.json().simulated).toBe(true);
    expect(recs.json().recommendations.length).toBeGreaterThan(0);
    const txt = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/geo/llms-txt`, headers: authHeaders(token),
    });
    expect(txt.statusCode).toBe(200);
    expect(txt.headers['content-type']).toContain('text/plain');
    expect(txt.body).toContain('Contact: https://acmetest.com');
  });
});
