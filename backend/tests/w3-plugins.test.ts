// W-06: plugin interface, reference plugin, webhook catalog vs OpenAPI.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { pool, query, runMigrations } from '../src/db.js';
import { signupVerified, tenantCollector, auth } from './helpers-ba.js';
import { registerPlugin, runPluginHooks, listPlugins, clearPluginsForTests, slackAuditNotifyPlugin } from '../src/services/plugins.js';
import { WEBHOOK_EVENT_CATALOG } from '../src/routes/webhooks.js';
import { signWebhookDelivery, verifyWebhookSignature } from '../src/services/webhookDelivery.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

describe.runIf(HAS_TEST_DB)('W-06 plugin interface', () => {
  let app: FastifyInstance;
  const tc = tenantCollector();
  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
  }, 60000);
  afterAll(async () => {
    clearPluginsForTests();
    await app?.close();
    if (tc.ids.length) await query('DELETE FROM tenants WHERE id = ANY($1)', [tc.ids]);
    await pool.end();
  });

  it('registry: hooks run, a failing plugin never breaks the caller', async () => {
    clearPluginsForTests();
    const seen: string[] = [];
    registerPlugin({ name: 'good', onAuditComplete: async (ctx) => { seen.push(ctx.tenantId); } });
    registerPlugin({ name: 'bad', onAuditComplete: async () => { throw new Error('boom'); } });
    registerPlugin({ name: 'report-only', onReportGenerated: async () => { seen.push('report'); } });
    const out = await runPluginHooks('audit.completed', { tenantId: 't1', payload: {} });
    expect(out.ran).toEqual(['good']);
    expect(out.failed).toEqual(['bad']);
    expect(seen).toEqual(['t1']);
    expect(listPlugins()).toEqual(expect.arrayContaining(['good', 'bad', 'report-only']));
  });

  it('reference plugin: slack-notify emits through the existing webhook system', async () => {
    clearPluginsForTests();
    registerPlugin(slackAuditNotifyPlugin);
    const u = await signupVerified(app); tc.add(u.tenantId);
    // Register a webhook endpoint subscribed to audit.completed (test endpoint).
    const create = await app.inject({
      method: 'POST', url: '/api/v1/webhooks', headers: auth(u.token),
      payload: { url: 'http://127.0.0.1:9/slack-bridge', events: ['audit.completed'] },
    });
    expect(create.statusCode).toBe(200);
    await runPluginHooks('audit.completed', { tenantId: u.tenantId, siteId: 's1', resourceId: 'a1', payload: { score: 90 } });
    const rows = (await query(`SELECT event, status FROM webhook_deliveries WHERE tenant_id=$1 AND event='audit.completed'`, [u.tenantId])).rows;
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('pending'); // pending -> signed delivery + retries handled by the existing pipeline
    // Signing is still HMAC sha256 of "<ts>.<body>" (verify, don't rebuild).
    const sig = signWebhookDelivery('s3cret', 123, '{"a":1}');
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(verifyWebhookSignature('s3cret', 123, '{"a":1}', sig)).toBe(true);
    expect(verifyWebhookSignature('wrong', 123, '{"a":1}', sig)).toBe(false);
  });

  it('webhook catalog: route list matches the exported catalog, and OpenAPI documents the route', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const res = await app.inject({ method: 'GET', url: '/api/v1/webhooks/events', headers: auth(u.token) });
    expect(res.statusCode).toBe(200);
    expect((res.json() as any).events).toEqual([...WEBHOOK_EVENT_CATALOG]);
    expect(WEBHOOK_EVENT_CATALOG).toContain('audit.completed');
    expect(WEBHOOK_EVENT_CATALOG).toContain('report.ready');
    expect(WEBHOOK_EVENT_CATALOG).toContain('rank.changed');
    const spec = await app.inject({ method: 'GET', url: '/api/v1/openapi.json', headers: auth(u.token) });
    expect(spec.statusCode).toBe(200);
    const body = JSON.stringify(spec.json());
    expect(body).toMatch(/webhooks/);
  });
});
