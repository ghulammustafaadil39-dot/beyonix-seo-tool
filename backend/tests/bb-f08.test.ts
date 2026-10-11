// Backend-B Wave 2 — F-08 white-label reports tests.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { query } from '../src/db.js';
import {
  ensureTestDb, truncateAll, createTestUser, loginAs, authHeaders,
} from './helpers.js';

let app: FastifyInstance;
let token: string;
let siteId: string;

beforeAll(async () => {
  await ensureTestDb();
  await truncateAll();
  app = await buildApp();
  const u = await createTestUser('bb-f08@example.com', { verified: true });
  token = await loginAs(app, 'bb-f08@example.com');
  const s = await query(
    `INSERT INTO sites (id, tenant_id, domain, verified) VALUES (gen_random_uuid(), $1, 'acme8.com', TRUE) RETURNING id`,
    [u.tenantId],
  );
  siteId = s.rows[0].id as string;
}, 60000);

afterAll(async () => {
  await app.close();
});

describe('F-08 white-label reports', () => {
  it('CRUDs tenant branding with hex validation', async () => {
    const bad = await app.inject({
      method: 'PUT', url: '/api/v1/branding',
      headers: authHeaders(token), payload: { primary_color: 'red' },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: 'PUT', url: '/api/v1/branding',
      headers: authHeaders(token),
      payload: { company_name: 'Acme Reports', primary_color: '#123456', accent_color: '#abcdef' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().company_name).toBe('Acme Reports');
    const get = await app.inject({ method: 'GET', url: '/api/v1/branding', headers: authHeaders(token) });
    expect(get.json().primary_color).toBe('#123456');
  });

  let reportId: string;

  it('builds a report synchronously with section selection', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/reports/build`,
      headers: authHeaders(token),
      payload: { sections: ['executive', 'audit'], periodDays: 7 },
    });
    expect(res.statusCode).toBe(200);
    reportId = res.json().id;
    expect(res.json().sections).toEqual(['executive', 'audit']);
    expect(res.json().summary.length).toBeGreaterThan(20);
    expect(res.json().branding.company_name).toBe('Acme Reports');
  });

  it('exports branded PDF and HTML', async () => {
    const pdf = await app.inject({
      method: 'GET', url: `/api/v1/reports/${reportId}/pdf`, headers: authHeaders(token),
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const buf = pdf.rawBody ?? Buffer.from(pdf.body ?? '', 'binary');
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
    const html = await app.inject({
      method: 'GET', url: `/api/v1/reports/${reportId}/html`, headers: authHeaders(token),
    });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('Acme Reports');
    expect(html.body).toContain('#123456');
    expect(html.body).not.toContain('Keyword movements'); // section not selected
  });

  it('compares with the previous period', async () => {
    const first = await app.inject({
      method: 'GET', url: `/api/v1/reports/${reportId}/compare`, headers: authHeaders(token),
    });
    expect(first.json().previous).toBeNull();
    const second = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/reports/build`,
      headers: authHeaders(token), payload: { sections: ['executive'], periodDays: 30 },
    });
    expect(second.statusCode).toBe(200);
    const cmp = await app.inject({
      method: 'GET', url: `/api/v1/reports/${second.json().id}/compare`, headers: authHeaders(token),
    });
    expect(cmp.statusCode).toBe(200);
    expect(cmp.json().previous.id).toBe(reportId);
    expect(cmp.json().deltas).toHaveProperty('auditScore');
  });

  it('creates and resolves a signed share link', async () => {
    const share = await app.inject({
      method: 'POST', url: `/api/v1/reports/${reportId}/share`,
      headers: authHeaders(token), payload: { expiresInDays: 7 },
    });
    expect(share.statusCode).toBe(201);
    expect(share.json().url).toContain('/shared/reports/');
    const pub = await app.inject({ method: 'GET', url: `/api/v1/shared/reports/${share.json().token}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.body).toContain('Acme Reports');
    const bad = await app.inject({ method: 'GET', url: `/api/v1/shared/reports/${share.json().token.slice(0, -4)}AAAA` });
    expect(bad.statusCode).toBe(404);
  });

  it('CRUDs the report schedule', async () => {
    const put = await app.inject({
      method: 'PUT', url: `/api/v1/sites/${siteId}/reports/schedule`,
      headers: authHeaders(token),
      payload: { frequency: 'weekly', recipients: ['owner@acme8.com'], sections: ['executive', 'geo'] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().schedule.recipients).toContain('owner@acme8.com');
    const get = await app.inject({
      method: 'GET', url: `/api/v1/sites/${siteId}/reports/schedule`, headers: authHeaders(token),
    });
    expect(get.json().schedule.frequency).toBe('weekly');
    const del = await app.inject({
      method: 'DELETE', url: `/api/v1/sites/${siteId}/reports/schedule`, headers: authHeaders(token),
    });
    expect(del.statusCode).toBe(204);
  });
});
