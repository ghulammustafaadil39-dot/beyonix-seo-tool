import http from 'node:http';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import type { FastifyInstance } from 'fastify';
import { pool, query, runMigrations } from '../src/db.js';
import { auth, signupVerified, tenantCollector } from './helpers-ba.js';
import { processWebhookRetries, signWebhookDelivery } from '../src/services/webhookDelivery.js';
import { dispatchNotification } from '../src/services/notifications.js';

/**
 * F-10 (notifications) backend: alert rules, digests, webhook endpoints
 * with SIGNED delivery + retries + replay. SECURITY-SENSITIVE (webhook URL
 * SSRF validation, HMAC signing) — Security Lead review required.
 *
 * Needs DATABASE_URL at a test database (bseo_test_ba) + Redis.
 */
const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

describe.runIf(HAS_TEST_DB)('F-10 notifications', () => {
  let app: FastifyInstance;
  const tc = tenantCollector();

  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
  }, 60000);

  afterAll(async () => {
    await app?.close();
    if (tc.ids.length) await query('DELETE FROM tenants WHERE id = ANY($1)', [tc.ids]);
    await pool.end();
  });

  it('alert rules CRUD + digest settings', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/account/alert-rules',
      headers: auth(u.token),
      payload: { ruleType: 'rank_drop', channels: ['email', 'inapp'], config: { drop_positions: 5 } },
    });
    expect(create.statusCode).toBe(200);
    const ruleId = (create.json() as any).id as string;

    // Same ruleType upserts (one row per user+type).
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/account/alert-rules',
      headers: auth(u.token),
      payload: { ruleType: 'rank_drop', channels: ['email'], config: {} },
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as any).id).toBe(ruleId);

    // Slack channel requires a webhook URL in config.
    const badSlack = await app.inject({
      method: 'POST',
      url: '/api/v1/account/alert-rules',
      headers: auth(u.token),
      payload: { ruleType: 'site_down', channels: ['slack'], config: {} },
    });
    expect(badSlack.statusCode).toBe(400);

    const list = await app.inject({ method: 'GET', url: '/api/v1/account/alert-rules', headers: auth(u.token) });
    expect((list.json() as any).data).toHaveLength(1);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/account/alert-rules/${ruleId}`,
      headers: auth(u.token),
    });
    expect(del.statusCode).toBe(200);

    const digest = await app.inject({
      method: 'PUT',
      url: '/api/v1/account/digest',
      headers: auth(u.token),
      payload: { frequency: 'daily' },
    });
    expect(digest.statusCode).toBe(200);
    expect((digest.json() as any).frequency).toBe('daily');
  });

  it('webhook endpoint: SSRF-blocked URLs rejected; loopback allowed in test', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);

    const evil = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: auth(u.token),
      payload: { url: 'http://169.254.169.254/latest/meta-data/', events: ['limit.near'] },
    });
    expect(evil.statusCode).toBe(400);
    expect(evil.json().error.code).toBe('INVALID_WEBHOOK_URL');

    const evil2 = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: auth(u.token),
      payload: { url: 'ftp://example.com/hook', events: ['limit.near'] },
    });
    expect(evil2.statusCode).toBe(400);

    const badEvent = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: auth(u.token),
      payload: { url: 'http://127.0.0.1:9/hook', events: ['nope.event'] },
    });
    expect(badEvent.statusCode).toBe(400);
    expect(badEvent.json().error.code).toBe('UNKNOWN_EVENT');
  });

  it('webhook delivery: signed POST, signature verifiable, retries then replay', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);

    // Local capture server (loopback is allowed in NODE_ENV=test).
    const received: Array<{ headers: any; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: auth(u.token),
      payload: { url: `http://127.0.0.1:${port}/hook`, events: ['limit.near'] },
    });
    expect(created.statusCode).toBe(200);
    const { id: endpointId, secret } = created.json() as any;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    // Queue a test delivery and run the retry worker.
    const test = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/${endpointId}/test`,
      headers: auth(u.token),
    });
    expect(test.statusCode).toBe(200);
    const attempted = await processWebhookRetries();
    expect(attempted).toBeGreaterThanOrEqual(1);
    // Poll briefly for the async delivery.
    for (let i = 0; i < 20 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(received.length).toBeGreaterThanOrEqual(1);
    const { headers, body } = received[0];
    expect(headers['x-bseo-event']).toBe('notify.limit_near');
    expect(headers['x-bseo-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    const { verifyWebhookSignature } = await import('../src/services/webhookDelivery.js');
    expect(
      verifyWebhookSignature(secret, Number(headers['x-bseo-timestamp']), body, headers['x-bseo-signature']),
    ).toBe(true);

    // Delivery recorded as delivered.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/webhooks/deliveries',
      headers: auth(u.token),
    });
    const deliveries = (list.json() as any).data;
    expect(deliveries[0].status).toBe('delivered');

    // Replay a delivered delivery -> pending again.
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/webhooks/deliveries/${deliveries[0].id}/replay`,
      headers: auth(u.token),
    });
    expect(replay.statusCode).toBe(200);
    server.close();
  });

  it('webhook retries: failing endpoint gets retried then marked failed', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);
    // Port 9 (discard) — connection refused. Loopback allowed in test.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: auth(u.token),
      payload: { url: 'http://127.0.0.1:9/hook', events: ['limit.near'] },
    });
    const endpointId = (created.json() as any).id as string;
    await app.inject({ method: 'POST', url: `/api/v1/webhooks/${endpointId}/test`, headers: auth(u.token) });

    // Force all retries now by rewinding next_retry_at between runs.
    for (let i = 0; i < 7; i++) {
      await processWebhookRetries();
      await query(`UPDATE webhook_deliveries SET next_retry_at = now() WHERE endpoint_id = $1`, [endpointId]);
    }
    const r = await query(`SELECT status, attempts FROM webhook_deliveries WHERE endpoint_id = $1`, [endpointId]);
    expect(r.rows[0].status).toBe('failed');
    expect(Number(r.rows[0].attempts)).toBeGreaterThanOrEqual(6);
  });

  it('dispatchNotification logs to the notification center (inapp fallback)', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);
    await query(`UPDATE tenants SET notify_email = $2 WHERE id = $1`, [u.tenantId, u.email]);
    await dispatchNotification(u.tenantId, 'limit_near', { title: 'Test alert', body: 'body here' }, { ruleType: 'limit_near' });

    const center = await app.inject({
      method: 'GET',
      url: '/api/v1/account/notifications',
      headers: auth(u.token),
    });
    expect(center.statusCode).toBe(200);
    const items = (center.json() as any).data;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]).toMatchObject({ notification_type: 'limit_near' });
  });

  it('signWebhookDelivery is deterministic and verifiable', () => {
    const sig = signWebhookDelivery('s3cr3t', 123, '{"a":1}');
    expect(sig).toBe(signWebhookDelivery('s3cr3t', 123, '{"a":1}'));
    expect(sig).not.toBe(signWebhookDelivery('other', 123, '{"a":1}'));
  });
});
