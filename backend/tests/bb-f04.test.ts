// Backend-B Wave 2 — F-04 content v2 tests.
// Pure workflow transitions + DB-backed route tests (mock LLM).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { query } from '../src/db.js';
import { canTransition, normalizeStatus } from '../src/services/contentWorkflow.js';
import { markdownToDocx } from '../src/services/docxExport.js';
import { publishPiece } from '../src/services/publishConnector.js';
import {
  ensureTestDb, truncateAll, createTestUser, loginAs, authHeaders,
} from './helpers.js';

describe('content workflow transitions (pure)', () => {
  it('validates the approval flow', () => {
    expect(canTransition('brief', 'outline')).toBe(true);
    expect(canTransition('review', 'approved')).toBe(true);
    expect(canTransition('review', 'changes_requested')).toBe(true);
    expect(canTransition('changes_requested', 'draft')).toBe(true);
    expect(canTransition('approved', 'published')).toBe(true);
    expect(canTransition('brief', 'approved')).toBe(false);
    expect(canTransition('published', 'draft')).toBe(false);
    expect(canTransition('draft', 'nonsense')).toBe(false);
    expect(normalizeStatus('draft')).toBe('draft');
    expect(() => normalizeStatus('bogus')).toThrow();
  });
});

describe('markdownToDocx', () => {
  it('produces a valid zip (PK magic)', async () => {
    const buf = await markdownToDocx('Hello', '# Hi\n\nSome **bold** text\n\n- item one');
    expect(buf.subarray(0, 2).toString()).toBe('PK');
    expect(buf.length).toBeGreaterThan(1000);
  });
});

describe('publishConnector', () => {
  it('runs in honest mock mode when the flag is off', async () => {
    const res = await publishPiece({ target: 'wordpress', title: 'T', html: '<p>x</p>' });
    expect(res.mock).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.message).toContain('mock mode');
  });
});

let app: FastifyInstance;
let token: string;
let tenantId: string;
let siteId: string;

beforeAll(async () => {
  await ensureTestDb();
  await truncateAll();
  app = await buildApp();
  const u = await createTestUser('bb-f04@example.com', { verified: true });
  tenantId = u.tenantId;
  token = await loginAs(app, 'bb-f04@example.com');
  const s = await query(
    `INSERT INTO sites (id, tenant_id, domain, verified) VALUES (gen_random_uuid(), $1, 'example.com', TRUE) RETURNING id`,
    [tenantId],
  );
  siteId = s.rows[0].id as string;
}, 60000);

afterAll(async () => {
  await app.close();
});

describe('F-04 content v2 routes', () => {
  let pieceId: string;

  it('creates a piece in brief status when a brief is given', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/content`,
      headers: authHeaders(token),
      payload: { title: 'SEO Audit Guide', brief: 'A practical guide for small businesses covering the basics of SEO audits.' },
    });
    expect(res.statusCode).toBe(201);
    pieceId = res.json().id;
    expect(res.json().status).toBe('brief');
    expect(res.json().brief).toContain('practical guide');
  });

  it('generates an outline from the brief (mock LLM, metered)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/content/${pieceId}/outline`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('outline');
    expect(res.json().outline.length).toBeGreaterThan(50);
    const usage = await query(
      `SELECT COALESCE(SUM(units),0)::int AS u FROM usage_events WHERE tenant_id = $1 AND event_type = 'ai_words'`,
      [tenantId]);
    expect(Number(usage.rows[0].u)).toBeGreaterThan(0);
  });

  it('records version history on edits and transitions', async () => {
    await app.inject({
      method: 'PATCH', url: `/api/v1/content/${pieceId}`,
      headers: authHeaders(token), payload: { title: 'SEO Audit Guide v2' },
    });
    const ok = await app.inject({
      method: 'PATCH', url: `/api/v1/content/${pieceId}/status`,
      headers: authHeaders(token), payload: { status: 'draft' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe('draft');
    const bad = await app.inject({
      method: 'PATCH', url: `/api/v1/content/${pieceId}/status`,
      headers: authHeaders(token), payload: { status: 'published' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_TRANSITION');
    const versions = await app.inject({
      method: 'GET', url: `/api/v1/content/${pieceId}/versions`, headers: authHeaders(token),
    });
    expect(versions.json().total).toBeGreaterThanOrEqual(2);
  });

  it('CRUDs the brand-voice profile', async () => {
    const put = await app.inject({
      method: 'PUT', url: `/api/v1/sites/${siteId}/content-profile`,
      headers: authHeaders(token), payload: { tone: 'friendly expert', dont_rules: 'no jargon' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().profile.tone).toBe('friendly expert');
    const get = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/content-profile`, headers: authHeaders(token),
    });
    expect(get.json().profile.dont_rules).toBe('no jargon');
  });

  it('scores term coverage gracefully without a keyword', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/content/${pieceId}/optimize`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sourcesAnalyzed).toBe(0);
    expect(res.json().keyword).toBeNull();
  });

  it('checks duplication against other pieces', async () => {
    const other = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/content`,
      headers: authHeaders(token),
      // brief flow: no background generation job overwrites our fixture draft
      payload: { title: 'Other piece', brief: 'A fixture brief used to test duplication detection between pieces.' },
    });
    const otherId = other.json().id;
    await query(`UPDATE content_pieces SET draft = $2 WHERE id = $1`, [otherId,
      'Search engine optimization helps websites rank higher with quality content and audits.']);
    const res = await app.inject({
      method: 'POST', url: `/api/v1/content/${pieceId}/duplication`,
      headers: authHeaders(token),
      payload: { text: 'Search engine optimization helps websites rank higher with quality content and audits indeed.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeGreaterThan(0);
    expect(res.json().data[0].similarityPct).toBeGreaterThan(80);
  });

  it('generates SEO assets (mock LLM fallback)', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/content/${pieceId}/seo-assets`,
      headers: authHeaders(token), payload: { topics: ['audits'], imageCount: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().metaTitle).toBe('string');
  });

  it('exports docx with PK magic', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/content/${pieceId}/export?format=docx`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('officedocument.wordprocessingml');
    const buf = res.rawBody ?? Buffer.from(res.body ?? '', 'binary');
    expect(buf.subarray(0, 2).toString()).toBe('PK');
  });

  it('publish runs in honest mock mode by default', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/publish`,
      headers: authHeaders(token),
      payload: { pieceId, target: 'wordpress', siteUrl: 'https://example.com', username: 'u', appPassword: 'p' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mock).toBe(true);
  });
});
