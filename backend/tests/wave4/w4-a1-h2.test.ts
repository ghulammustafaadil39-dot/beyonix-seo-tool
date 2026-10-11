/**
 * A1-H2 regression: F-09 team roles are enforced on product-domain mutations.
 *
 * - viewer: 403 on mutations, 200 on reads
 * - editor: 200 on mutations (where decided)
 * - editor: 403 on DELETE /sites/:id (owner/admin-only by design decision)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, authz, signupOwner, addTeamMember, createSite, type W4User } from './helpers.js';
import { resetDb } from '../integration/helpers/db.js';

let app: FastifyInstance;
let owner: W4User;
let editor: W4User;
let viewer: W4User;
let siteId: string;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDb();
  owner = await signupOwner(app);
  editor = await addTeamMember(app, owner.tenantId, 'editor');
  viewer = await addTeamMember(app, owner.tenantId, 'viewer');
  siteId = await createSite(app, owner);
});

describe('A1-H2: role gates on product mutations', () => {
  it('viewer gets 403 on mutations but 200 on reads', async () => {
    // Mutation: trigger audit
    const auditRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/audits`,
      headers: authz(viewer),
      payload: {},
    });
    expect(auditRes.statusCode).toBe(403);

    // Mutation: triage an audit issue — need an issue row; create via owner audit first.
    // (Skip the issue row: cover another mutation instead — geo prompt create.)
    const geoRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/geo/prompts`,
      headers: authz(viewer),
      payload: { prompt: 'best crm for startups' },
    });
    expect(geoRes.statusCode).toBe(403);

    // Mutation: create keyword list
    const listRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/keyword-lists`,
      headers: authz(viewer),
      payload: { name: 'x' },
    });
    expect(listRes.statusCode).toBe(403);

    // Mutation: patch site
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sites/${siteId}`,
      headers: authz(viewer),
      payload: { serp_location_code: 2840 },
    });
    expect(patchRes.statusCode).toBe(403);

    // Reads still work for viewer
    const readRes = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${siteId}/audits`,
      headers: authz(viewer),
    });
    expect(readRes.statusCode).toBe(200);
    const siteRead = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${siteId}`,
      headers: authz(viewer),
    });
    expect(siteRead.statusCode).toBe(200);
  });

  it('editor is allowed on mutations', async () => {
    const geoRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/geo/prompts`,
      headers: authz(editor),
      payload: { prompt: 'best crm for startups' },
    });
    expect(geoRes.statusCode).toBe(200);

    const listRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/keyword-lists`,
      headers: authz(editor),
      payload: { name: 'editor list' },
    });
    expect(listRes.statusCode).toBe(201);

    const compRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/competitors`,
      headers: authz(editor),
      payload: { domain: 'competitor.example.com' },
    });
    expect(compRes.statusCode).toBe(200);
  });

  it('editor cannot delete a site (owner/admin only), owner can', async () => {
    const ed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/sites/${siteId}`,
      headers: authz(editor),
    });
    expect(ed.statusCode).toBe(403);

    const vw = await app.inject({
      method: 'DELETE',
      url: `/api/v1/sites/${siteId}`,
      headers: authz(viewer),
    });
    expect(vw.statusCode).toBe(403);

    const ow = await app.inject({
      method: 'DELETE',
      url: `/api/v1/sites/${siteId}`,
      headers: authz(owner),
    });
    expect(ow.statusCode).toBe(200);
  });
});
