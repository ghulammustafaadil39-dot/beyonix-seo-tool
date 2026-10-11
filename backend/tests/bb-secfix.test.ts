// Backend-B Wave 2 — SECURITY FIX regression tests.
// FIX 1 [HIGH, F-04] CMS publish SSRF: tenant-supplied WordPress siteUrl now
//   requires https, is delivered via safeFetch (redirect hops re-validated),
//   and upstream bodies are never reflected (status only).
// FIX 2 [MEDIUM, F-02/F-08] share-link revocation: list + revoke endpoints
//   for audit and report shares, tenant-scoped, no token/hash leakage.
// LOW: rescoreToxicLinks UPDATE is tenant-scoped (query-spy).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { query } from '../src/db.js';
import { config } from '../src/config.js';
import { publishPiece } from '../src/services/publishConnector.js';
import { rescoreToxicLinks } from '../src/services/toxicLinks.js';
import {
  ensureTestDb, truncateAll, createTestUser, loginAs, authHeaders,
} from './helpers.js';

const MARKER = 'INTERNAL_MARKER_XYZ_SECRET';

let app: FastifyInstance;
let token: string;
let tenantId: string;
let siteId: string;
let auditId: string;
let pieceId: string;

// "Internal" service the attacker wants us to hit (hit counter must stay 0).
let internalServer: http.Server;
let internalPort = 0;
let internalHits = 0;
// Tenant-controlled "WordPress" HTTPS site (self-signed fixture cert).
let wpServer: https.Server;
let wpPort = 0;

beforeAll(async () => {
  await ensureTestDb();
  await truncateAll();
  app = await buildApp();
  const u = await createTestUser('bb-secfix@example.com', { verified: true });
  tenantId = u.tenantId;
  token = await loginAs(app, 'bb-secfix@example.com');
  const s = await query(
    `INSERT INTO sites (id, tenant_id, domain, verified) VALUES (gen_random_uuid(), $1, 'secfix.example.com', TRUE) RETURNING id`,
    [tenantId],
  );
  siteId = s.rows[0].id as string;
  const a = await query(
    `INSERT INTO audits (id, tenant_id, site_id, status, started_at, finished_at, score, issues_count, pages_crawled)
     VALUES (gen_random_uuid(), $1, $2, 'done', now(), now(), 77, 1, 3) RETURNING id`,
    [tenantId, siteId],
  );
  auditId = a.rows[0].id as string;
  const p = await query(
    `INSERT INTO content_pieces (id, tenant_id, site_id, title, draft, status)
     VALUES (gen_random_uuid(), $1, $2, 'Secfix piece', '<p>hello</p>', 'approved') RETURNING id`,
    [tenantId, siteId],
  );
  pieceId = p.rows[0].id as string;

  internalServer = http.createServer((_req, res) => {
    internalHits += 1;
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end(MARKER);
  });
  await new Promise<void>((r) => internalServer.listen(0, '127.0.0.1', r));
  internalPort = (internalServer.address() as { port: number }).port;

  const tlsOpts = {
    key: fs.readFileSync(fileURLToPath(new URL('./fixtures/ssrf/key.pem', import.meta.url))),
    cert: fs.readFileSync(fileURLToPath(new URL('./fixtures/ssrf/cert.pem', import.meta.url))),
  };
  wpServer = https.createServer(tlsOpts, (req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/fail/')) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ code: 'rest_internal_error', message: MARKER }));
    } else if (url.startsWith('/redir/')) {
      // Open-redirector shape: public https URL bouncing to loopback.
      res.writeHead(302, { Location: `http://localhost:${internalPort}/secret` }).end();
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ link: 'https://wp.example.com/published-post' }));
    }
  });
  await new Promise<void>((r) => wpServer.listen(0, '127.0.0.1', r));
  wpPort = (wpServer.address() as { port: number }).port;

  // The fixture cert is self-signed: relax verification for THIS process
  // only (test env), and enable real publishing for the fix-1 tests.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  config.cmsPublishEnabled = true;
}, 60000);

afterAll(async () => {
  config.cmsPublishEnabled = false;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  internalServer.close();
  wpServer.close();
  await app.close();
});

describe('FIX 1 — publish SSRF (service level)', () => {
  const wp = { target: 'wordpress' as const, title: 'T', html: '<p>x</p>', username: 'u', appPassword: 'p' };

  it('refuses a plain-http siteUrl before any network call', async () => {
    const res = await publishPiece({ ...wp, siteUrl: `http://127.0.0.1:${internalPort}` });
    expect(res.ok).toBe(false);
    expect(res.mock).toBe(false);
    expect(res.message).toContain('https');
    expect(internalHits).toBe(0);
  });

  it('blocks a direct loopback target (localhost) — internal service untouched', async () => {
    const res = await publishPiece({ ...wp, siteUrl: `https://localhost:${internalPort}` });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('SSRF blocked');
    expect(internalHits).toBe(0);
  });

  it('does NOT follow a redirect from a public https URL to loopback', async () => {
    const res = await publishPiece({ ...wp, siteUrl: `https://127.0.0.1:${wpPort}/redir` });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('SSRF blocked');
    expect(internalHits).toBe(0);
  });

  it('never reflects the upstream body: 500 surfaces status only', async () => {
    const res = await publishPiece({ ...wp, siteUrl: `https://127.0.0.1:${wpPort}/fail` });
    expect(res.ok).toBe(false);
    expect(res.message).toBe('WordPress API error: 500');
    expect(res.message).not.toContain(MARKER);
  });

  it('still publishes successfully to a legit https WordPress via safeFetch', async () => {
    const res = await publishPiece({ ...wp, siteUrl: `https://127.0.0.1:${wpPort}/ok` });
    expect(res.ok).toBe(true);
    expect(res.mock).toBe(false);
    expect(res.url).toBe('https://wp.example.com/published-post');
  });

  it('disabled path is unchanged (honest mock, no network)', async () => {
    config.cmsPublishEnabled = false;
    try {
      const res = await publishPiece({ ...wp, siteUrl: `https://127.0.0.1:${wpPort}/ok` });
      expect(res.mock).toBe(true);
      expect(res.ok).toBe(true);
      expect(res.message).toContain('mock mode');
    } finally {
      config.cmsPublishEnabled = true;
    }
  });
});

describe('FIX 1 — publish SSRF (route level)', () => {
  it('rejects an http siteUrl with a clear 400', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/publish`,
      headers: authHeaders(token),
      payload: {
        pieceId, target: 'wordpress', siteUrl: `http://127.0.0.1:${internalPort}`,
        username: 'u', appPassword: 'p',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
    expect(res.json().error.message).toContain('https');
    expect(internalHits).toBe(0);
  });

  it('upstream 500 body marker is NOT present in the API response', async () => {
    const res = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/publish`,
      headers: authHeaders(token),
      payload: {
        pieceId, target: 'wordpress', siteUrl: `https://127.0.0.1:${wpPort}/fail`,
        username: 'u', appPassword: 'p',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().message).toBe('WordPress API error: 500');
    expect(res.body).not.toContain(MARKER);
  });
});

describe('FIX 2 — audit share list + revoke', () => {
  let shareToken: string;
  let shareId: string;
  let shareHash: string;

  it('create → resolve 200 → list (no token/hash) → revoke → resolve 404', async () => {
    const create = await app.inject({
      method: 'POST', url: `/api/v1/audits/${auditId}/share`,
      headers: authHeaders(token), payload: { expiresInDays: 7 },
    });
    expect(create.statusCode).toBe(201);
    shareToken = create.json().token;

    const pub = await app.inject({ method: 'GET', url: `/api/v1/shared/audits/${shareToken}` });
    expect(pub.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET', url: `/api/v1/audits/${auditId}/shares`, headers: authHeaders(token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    const item = list.json().data[0];
    shareId = item.id;
    expect(item.resource_type).toBe('audit');
    expect(item.resource_id).toBe(auditId);
    expect(item.created_at).toBeTruthy();
    expect(item.expires_at).toBeTruthy();
    // The list must never expose the bearer token or its hash.
    shareHash = (await query(`SELECT token_hash FROM share_tokens WHERE id = $1`, [shareId])).rows[0].token_hash;
    expect(list.body).not.toContain(shareToken);
    expect(list.body).not.toContain(shareHash);
    expect(item).not.toHaveProperty('token');
    expect(item).not.toHaveProperty('token_hash');

    const revoke = await app.inject({
      method: 'DELETE', url: `/api/v1/audits/${auditId}/shares/${shareId}`,
      headers: authHeaders(token),
    });
    expect(revoke.statusCode).toBe(204);

    const gone = await app.inject({ method: 'GET', url: `/api/v1/shared/audits/${shareToken}` });
    expect(gone.statusCode).toBe(404);
    const listAfter = await app.inject({
      method: 'GET', url: `/api/v1/audits/${auditId}/shares`, headers: authHeaders(token),
    });
    expect(listAfter.json().data).toHaveLength(0);
    // Second revoke of the same id 404s.
    const again = await app.inject({
      method: 'DELETE', url: `/api/v1/audits/${auditId}/shares/${shareId}`,
      headers: authHeaders(token),
    });
    expect(again.statusCode).toBe(404);
  });

  it("another tenant cannot list or revoke (404) and the link survives", async () => {
    const create = await app.inject({
      method: 'POST', url: `/api/v1/audits/${auditId}/share`,
      headers: authHeaders(token), payload: { expiresInDays: 7 },
    });
    const t2 = create.json().token as string;
    const list = await app.inject({
      method: 'GET', url: `/api/v1/audits/${auditId}/shares`, headers: authHeaders(token),
    });
    const id2 = list.json().data[0].id as string;

    const other = await createTestUser('bb-secfix-other@example.com', { verified: true });
    const otherToken = await loginAs(app, 'bb-secfix-other@example.com');
    expect(other.tenantId).not.toBe(tenantId);

    const oList = await app.inject({
      method: 'GET', url: `/api/v1/audits/${auditId}/shares`, headers: authHeaders(otherToken),
    });
    expect(oList.statusCode).toBe(404);
    const oRevoke = await app.inject({
      method: 'DELETE', url: `/api/v1/audits/${auditId}/shares/${id2}`, headers: authHeaders(otherToken),
    });
    expect(oRevoke.statusCode).toBe(404);

    // Not revoked by the attempt: still resolves.
    const pub = await app.inject({ method: 'GET', url: `/api/v1/shared/audits/${t2}` });
    expect(pub.statusCode).toBe(200);
  });
});

describe('FIX 2 — report share list + revoke', () => {
  let reportId: string;

  beforeAll(async () => {
    const build = await app.inject({
      method: 'POST', url: `/api/v1/sites/${siteId}/reports/build`,
      headers: authHeaders(token), payload: { sections: ['executive'], periodDays: 7 },
    });
    expect(build.statusCode).toBe(200);
    reportId = build.json().id as string;
  });

  it('create → resolve 200 → list (no token/hash) → revoke → resolve 404', async () => {
    const create = await app.inject({
      method: 'POST', url: `/api/v1/reports/${reportId}/share`,
      headers: authHeaders(token), payload: { expiresInDays: 7 },
    });
    expect(create.statusCode).toBe(201);
    const shareToken = create.json().token as string;

    const pub = await app.inject({ method: 'GET', url: `/api/v1/shared/reports/${shareToken}` });
    expect(pub.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET', url: `/api/v1/reports/${reportId}/shares`, headers: authHeaders(token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);
    const item = list.json().data[0];
    expect(item.resource_type).toBe('report');
    expect(item.resource_id).toBe(reportId);
    const hash = (await query(`SELECT token_hash FROM share_tokens WHERE id = $1`, [item.id])).rows[0].token_hash;
    expect(list.body).not.toContain(shareToken);
    expect(list.body).not.toContain(hash);
    expect(item).not.toHaveProperty('token');
    expect(item).not.toHaveProperty('token_hash');

    const revoke = await app.inject({
      method: 'DELETE', url: `/api/v1/reports/${reportId}/shares/${item.id}`,
      headers: authHeaders(token),
    });
    expect(revoke.statusCode).toBe(204);
    const gone = await app.inject({ method: 'GET', url: `/api/v1/shared/reports/${shareToken}` });
    expect(gone.statusCode).toBe(404);
  });

  it("another tenant cannot list or revoke a report share (404)", async () => {
    const create = await app.inject({
      method: 'POST', url: `/api/v1/reports/${reportId}/share`,
      headers: authHeaders(token), payload: { expiresInDays: 7 },
    });
    const shareToken = create.json().token as string;
    const list = await app.inject({
      method: 'GET', url: `/api/v1/reports/${reportId}/shares`, headers: authHeaders(token),
    });
    const id = list.json().data[0].id as string;

    const otherToken = await loginAs(app, 'bb-secfix-other@example.com');
    const oList = await app.inject({
      method: 'GET', url: `/api/v1/reports/${reportId}/shares`, headers: authHeaders(otherToken),
    });
    expect(oList.statusCode).toBe(404);
    const oRevoke = await app.inject({
      method: 'DELETE', url: `/api/v1/reports/${reportId}/shares/${id}`, headers: authHeaders(otherToken),
    });
    expect(oRevoke.statusCode).toBe(404);
    const pub = await app.inject({ method: 'GET', url: `/api/v1/shared/reports/${shareToken}` });
    expect(pub.statusCode).toBe(200);
  });
});

describe('LOW — toxicLinks tenant scoping', () => {
  it('rescoreToxicLinks UPDATE carries tenant_id (query spy)', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const q = async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (sql.trimStart().startsWith('SELECT')) {
        return {
          rows: [{ id: 'bl-1', source_url: 'https://spam.example.net/x', anchor_text: 'cheap meds' }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    };
    const out = await rescoreToxicLinks('tenant-9', 'site-1', 'example.com', q as never);
    expect(out.rescored).toBe(1);
    const upd = calls.find((c) => c.sql.includes('UPDATE backlinks'));
    expect(upd).toBeDefined();
    expect(upd!.sql).toContain('tenant_id = $5');
    expect(upd!.params).toContain('tenant-9');
  });
});
