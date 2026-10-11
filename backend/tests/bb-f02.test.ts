// Backend-B Wave 2 — F-02 audit v2 engine API tests (DB-backed).
// Covers: grouped fixes, issue states, diff history, per-page detail,
// signed share links (create + public resolve), CSV/PDF export,
// crawl-schedule. Cross-tenant isolation is asserted on the share endpoint.
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
let auditId: string;

async function seedAudit(): Promise<void> {
  const s = await query(
    `INSERT INTO sites (id, tenant_id, domain, verified) VALUES (gen_random_uuid(), $1, 'example.com', TRUE) RETURNING id`,
    [tenantId],
  );
  siteId = s.rows[0].id as string;
  const a = await query(
    `INSERT INTO audits (id, tenant_id, site_id, status, started_at, finished_at, score, issues_count, pages_crawled)
     VALUES (gen_random_uuid(), $1, $2, 'done', now(), now(), 82, 3, 5) RETURNING id`,
    [tenantId, siteId],
  );
  auditId = a.rows[0].id as string;
  const issues = [
    ['missing-title', 'error', 'https://example.com/a', 'No title', 'Add title', 45],
    ['missing-title', 'error', 'https://example.com/b', 'No title', 'Add title', 30],
    ['slow-page', 'warning', 'https://example.com/a', 'Slow', 'Compress', 12],
  ];
  for (const [type, sev, url, detail, fix, impact] of issues) {
    await query(
      `INSERT INTO audit_issues (id, tenant_id, audit_id, site_id, type, severity, url, detail, fix_suggestion, impact, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 'open')`,
      [tenantId, auditId, siteId, type, sev, url, detail, fix, impact],
    );
  }
  await query(
    `INSERT INTO audit_pages (id, tenant_id, audit_id, site_id, url, status_code, title, word_count, inlinks)
     VALUES (gen_random_uuid(), $1, $2, $3, 'https://example.com/a', 200, 'Page A', 400, 3)`,
    [tenantId, auditId, siteId],
  );
  await query(
    `INSERT INTO audit_diffs (id, tenant_id, audit_id, site_id, new_issues, resolved_issues, new_errors, by_type)
     VALUES (gen_random_uuid(), $1, $2, $3, 2, 1, 1, '{"missing-title":{"new":2,"resolved":0}}')`,
    [tenantId, auditId, siteId],
  );
}

beforeAll(async () => {
  await ensureTestDb();
  await truncateAll();
  app = await buildApp();
  const u = await createTestUser('bb-f02@example.com', { verified: true });
  tenantId = u.tenantId;
  token = await loginAs(app, 'bb-f02@example.com');
  await seedAudit();
});

afterAll(async () => {
  await app.close();
});

describe('F-02 audit v2', () => {
  it('groups issues by type with impact ordering', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/audits/${auditId}/groups`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    const groups = res.json().data;
    expect(groups).toHaveLength(2);
    expect(groups[0].type).toBe('missing-title');
    expect(groups[0].count).toBe(2);
    expect(groups[0].total_impact).toBe(75);
    expect(groups[0].urls).toHaveLength(2);
  });

  it('supports the new issue states (resolved / wont-fix)', async () => {
    const issue = (await query(`SELECT id FROM audit_issues WHERE audit_id = $1 LIMIT 1`, [auditId])).rows[0];
    for (const status of ['resolved', 'wont-fix', 'ignored', 'open']) {
      const res = await app.inject({
        method: 'PATCH', url: `/api/v1/issues/${issue.id}`,
        headers: authHeaders(token), payload: { status },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().issue.status).toBe(status);
    }
    // legacy 'fixed' is rejected by validation
    const bad = await app.inject({
      method: 'PATCH', url: `/api/v1/issues/${issue.id}`,
      headers: authHeaders(token), payload: { status: 'fixed' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('returns change history between crawls', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/audits/${auditId}/diff`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().diff.new_issues).toBe(2);
    expect(res.json().diff.new_errors).toBe(1);
  });

  it('serves per-page detail with its issues', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/audits/${auditId}/pages?url=https://example.com/a`,
      headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().page.title).toBe('Page A');
    expect(res.json().issues.length).toBeGreaterThanOrEqual(2);
  });

  it('lists pages ordered by inlinks', async () => {
    const res = await app.inject({
      method: 'GET', url: `/api/v1/audits/${auditId}/pages`, headers: authHeaders(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
  });

  it('creates a signed share link and resolves it publicly', async () => {
    const create = await app.inject({
      method: 'POST', url: `/api/v1/audits/${auditId}/share`,
      headers: authHeaders(token), payload: { expiresInDays: 7 },
    });
    expect(create.statusCode).toBe(201);
    const { token: shareToken, url } = create.json();
    expect(shareToken.split('.')).toHaveLength(3);
    expect(url).toContain('/shared/audits/');

    // Public resolution: no auth header.
    const pub = await app.inject({ method: 'GET', url: `/api/v1/shared/audits/${shareToken}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.json().audit.id).toBe(auditId);
    expect(pub.json().issues.length).toBeGreaterThanOrEqual(1);

    // Tampered token is rejected.
    const bad = await app.inject({ method: 'GET', url: `/api/v1/shared/audits/${shareToken.slice(0, -4)}AAAA` });
    expect(bad.statusCode).toBe(404);
  });

  it('exports CSV and PDF', async () => {
    const csv = await app.inject({
      method: 'GET', url: `/api/v1/audits/${auditId}/export?format=csv`, headers: authHeaders(token),
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toBe('type,severity,impact,status,url,detail,fix_suggestion');
    expect(csv.body).toContain('missing-title');

    const pdf = await app.inject({
      method: 'GET', url: `/api/v1/audits/${auditId}/export?format=pdf`, headers: authHeaders(token),
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const pdfBuf = pdf.rawBody ?? Buffer.from(pdf.body ?? '', 'binary');
    expect(pdfBuf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('sets the crawl schedule per site', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/sites/${siteId}/crawl-schedule`,
      headers: authHeaders(token), payload: { frequency: 'monthly' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().crawl_schedule).toBe('monthly');
    const bad = await app.inject({
      method: 'PATCH', url: `/api/v1/sites/${siteId}/crawl-schedule`,
      headers: authHeaders(token), payload: { frequency: 'hourly' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('does not leak audits across tenants', async () => {
    const other = await createTestUser('bb-f02-other@example.com', { verified: true });
    const otherToken = await loginAs(app, 'bb-f02-other@example.com');
    expect(other.tenantId).not.toBe(tenantId);
    const res = await app.inject({
      method: 'GET', url: `/api/v1/audits/${auditId}/groups`, headers: authHeaders(otherToken),
    });
    expect(res.statusCode).toBe(404);
  });
});
