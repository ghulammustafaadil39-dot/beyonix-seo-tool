// Wave-3 security-review regression tests: the six SEC-FIX items
// (settings role guard, GEO LLM cap bypass, keywordGap provider budget,
// GDPR export bearer-URL redaction, bench-hot footgun guard).
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/index.js';
import { pool, query, runMigrations } from '../src/db.js';
import { signupVerified, tenantCollector, auth, uniqueEmail } from './helpers-ba.js';
import { getUsage } from '../src/metering.js';
import { runGeoCheck } from '../src/services/geoService.js';

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');
const execFileAsync = promisify(execFile);

/** Full invite -> signup -> accept flow; returns a session token bound to the owner's tenant. */
async function memberWithRole(app: FastifyInstance, owner: { token: string; tenantId: string }, role: string) {
  const email = uniqueEmail(`secfix-${role}`);
  const inv = await app.inject({
    method: 'POST',
    url: '/api/v1/account/invitations',
    headers: auth(owner.token),
    payload: { email, role },
  });
  expect(inv.statusCode).toBe(202);
  const invitee = await signupVerified(app, email);
  const accept = await app.inject({
    method: 'POST',
    url: '/api/v1/account/invitations/accept',
    headers: auth(invitee.token),
    payload: { token: (inv.json() as any).token },
  });
  expect(accept.statusCode).toBe(200);
  return { token: (accept.json() as any).token as string, tenantId: owner.tenantId };
}

async function makeSite(app: FastifyInstance, token: string, domain: string): Promise<string> {
  const s = await app.inject({ method: 'POST', url: '/api/v1/sites', headers: auth(token), payload: { domain } });
  expect(s.statusCode).toBe(201);
  return (s.json() as any).id as string;
}

describe.runIf(HAS_TEST_DB)('Wave-3 SEC-FIX regressions', () => {
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

  it('SEC-FIX #1: PATCH /settings — viewer/editor -> 403 on cost cap + api key; admin/owner -> 200', async () => {
    const owner = await signupVerified(app); tc.add(owner.tenantId);
    const viewer = await memberWithRole(app, owner, 'viewer');
    const editor = await memberWithRole(app, owner, 'editor');
    const adminM = await memberWithRole(app, owner, 'admin');
    const payload = { llm_cost_cap_words: 123, llm_api_key: 'sk-test-attacker-key' };

    for (const m of [viewer, editor]) {
      const r = await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: auth(m.token), payload });
      expect(r.statusCode).toBe(403);
      expect((r.json() as any).error.code).toBe('FORBIDDEN');
    }
    // The rejected attempts must not have changed anything.
    const g1 = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: auth(owner.token) });
    expect((g1.json() as any).llm_cost_cap_words).toBeNull();
    expect((g1.json() as any).llm_key_set).toBe(false);

    const rAdmin = await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: auth(adminM.token), payload });
    expect(rAdmin.statusCode).toBe(200);
    expect((rAdmin.json() as any).llm_cost_cap_words).toBe(123);
    expect((rAdmin.json() as any).llm_key_set).toBe(true);

    const rOwner = await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: auth(owner.token), payload: { llm_cost_cap_words: 0 } });
    expect(rOwner.statusCode).toBe(200);
    // GET stays readable for every role (only the WRITE is gated).
    const gViewer = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: auth(viewer.token) });
    expect(gViewer.statusCode).toBe(200);
  });

  it('SEC-FIX #2: GEO LLM calls go through the metered path (cap -> 402, ai_words recorded)', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const siteId = await makeSite(app, u.token, `geosec-${Date.now()}.com`);

    // Trip the cap: a GEO run must surface 402 LLM_COST_CAP_EXCEEDED.
    await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: auth(u.token), payload: { llm_cost_cap_words: 0 } });
    await expect(runGeoCheck(u.tenantId, siteId, 'best seo tools', ['chatgpt'], query)).rejects.toMatchObject({
      status: 402,
      code: 'LLM_COST_CAP_EXCEEDED',
    });

    // Lift the cap: the run must record ai_words usage (metered path).
    await app.inject({ method: 'PATCH', url: '/api/v1/settings', headers: auth(u.token), payload: { llm_cost_cap_words: null } });
    const before = await getUsage(u.tenantId, 'ai_words', query);
    const res = await runGeoCheck(u.tenantId, siteId, 'best seo tools', ['chatgpt'], query);
    expect(res).toHaveLength(1);
    expect(res[0].simulated).toBe(true);
    const after = await getUsage(u.tenantId, 'ai_words', query);
    expect(after).toBeGreaterThan(before);
  });

  it('SEC-FIX #3: keywordGap honors the global provider budget (503 when tripped)', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const siteId = await makeSite(app, u.token, `gapsect-${Date.now()}.com`);
    await query(
      `INSERT INTO provider_spend (id,tenant_id,provider,feature,units,cost_cents) VALUES (gen_random_uuid(),$1,'dataforseo','keyword_gap',3,0)`,
      [u.tenantId],
    );
    process.env.GLOBAL_PROVIDER_DAILY_CAP_UNITS = '1';
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/sites/${siteId}/keywords/gap?competitor=gapsec-${Date.now()}.com`,
        headers: auth(u.token),
      });
      expect(res.statusCode).toBe(503);
      expect((res.json() as any).error.code).toBe('PROVIDER_BUDGET_EXCEEDED');
    } finally {
      delete process.env.GLOBAL_PROVIDER_DAILY_CAP_UNITS;
    }
  });

  it('SEC-FIX #4: GDPR export redacts slack_webhook_url and URL-embedded tokens', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const hookUrl = 'https://hooks.slack.com/services/T000/B000/secret-token-abc123';
    const bridgeUrl = 'https://bridge.example.com/hook?token=bridge-secret-xyz&foo=bar';
    const ruleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/account/alert-rules',
      headers: auth(u.token),
      payload: {
        ruleType: 'rank_drop',
        channels: ['slack'],
        config: { slack_webhook_url: hookUrl, threshold: 5 },
      },
    });
    expect(ruleRes.statusCode).toBe(200);
    await query(
      `INSERT INTO webhook_endpoints (id,tenant_id,url,secret_enc,events,enabled) VALUES (gen_random_uuid(),$1,$2,'x','{"audit.finished"}',TRUE)`,
      [u.tenantId, bridgeUrl],
    );

    const res = await app.inject({ method: 'GET', url: '/api/v1/account/export', headers: auth(u.token) });
    expect(res.statusCode).toBe(200);
    const wire = res.body as string;
    // The literal secrets must not appear anywhere on the wire...
    expect(wire).not.toContain(hookUrl);
    expect(wire).not.toContain('bridge-secret-xyz');
    // ...but the redaction placeholder must, with non-secret config intact.
    expect(wire).toContain('[REDACTED]');
    const dump = res.json() as any;
    const rule = (dump.notification_rules as any[])[0];
    expect(rule.config.slack_webhook_url).toBe('[REDACTED]');
    expect(rule.config.threshold).toBe(5);
    expect(rule.channels).toContain('slack');
    const ep = (dump.webhook_endpoints as any[]).find((e: any) => String(e.url).includes('bridge.example.com'));
    expect(ep.url).toBe('https://bridge.example.com/hook?token=[REDACTED]&foo=bar');
  });

  it('SEC-FIX #4b: GDPR export redacts nested config webhook keys + path-embedded bearer URLs', async () => {
    const u = await signupVerified(app); tc.add(u.tenantId);
    const slackServices = 'https://hooks.slack.com/services/T9X/secretabc123';
    const discordHook = 'https://discord.com/api/webhooks/987654321/discord-secret-token';
    const zapierHook = 'https://hooks.zapier.com/hooks/catch/123/secretpath456';
    const ownHook = 'https://hooks.acme.example.com/in/wh?token=own-secret-1&x=1';
    // Discord-style key + a NESTED config object (config.slack.slack_webhook_url).
    const ruleRes = await app.inject({
      method: 'POST',
      url: '/api/v1/account/alert-rules',
      headers: auth(u.token),
      payload: {
        ruleType: 'critical_issue',
        channels: ['webhook'],
        config: {
          webhook_url: discordHook,
          threshold: 3,
          channels: ['email'],
          slack: { slack_webhook_url: slackServices },
          digest: { cadence: 'weekly' },
        },
      },
    });
    expect(ruleRes.statusCode).toBe(200);
    await query(
      `INSERT INTO webhook_endpoints (id,tenant_id,url,secret_enc,events,enabled) VALUES (gen_random_uuid(),$1,$2,'x','{"audit.finished"}',TRUE)`,
      [u.tenantId, zapierHook],
    );
    await query(
      `INSERT INTO webhook_endpoints (id,tenant_id,url,secret_enc,events,enabled) VALUES (gen_random_uuid(),$1,$2,'x','{"rank.changed"}',TRUE)`,
      [u.tenantId, ownHook],
    );

    const res = await app.inject({ method: 'GET', url: '/api/v1/account/export', headers: auth(u.token) });
    expect(res.statusCode).toBe(200);
    const wire = res.body as string;
    // The literal secrets must appear NOWHERE on the wire...
    expect(wire).not.toContain(discordHook);
    expect(wire).not.toContain(slackServices);
    expect(wire).not.toContain(zapierHook);
    expect(wire).not.toContain('own-secret-1');
    expect(wire).not.toContain('discord-secret-token');
    expect(wire).not.toContain('secretpath456');
    expect(wire).toContain('[REDACTED]');

    const dump = res.json() as any;
    const rule = (dump.notification_rules as any[]).find((r: any) => r.rule_type === 'critical_issue');
    expect(rule.config.webhook_url).toBe('[REDACTED]');
    expect(rule.config.slack.slack_webhook_url).toBe('[REDACTED]');
    // Non-secret config stays intact.
    expect(rule.config.threshold).toBe(3);
    expect(rule.config.channels).toEqual(['email']);
    expect(rule.config.digest.cadence).toBe('weekly');

    const byEvents = (ev: string) =>
      (dump.webhook_endpoints as any[]).find((e: any) => (e.events ?? '').includes(ev));
    // Third-party bearer URL (Zapier catch hook): whole URL gone.
    expect(byEvents('audit.finished').url).toBe('[REDACTED]');
    // Customer-owned host: URL intact, only the query token redacted.
    expect(byEvents('rank.changed').url).toBe(
      'https://hooks.acme.example.com/in/wh?token=[REDACTED]&x=1',
    );
  });

  it('SEC-FIX #5: bench-hot refuses to run against a non-test DATABASE_URL', async () => {
    const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const tsxBin = path.join(backendDir, 'node_modules', '.bin', 'tsx');
    try {
      await execFileAsync(tsxBin, ['scripts/bench-hot.ts'], {
        cwd: backendDir,
        timeout: 60000,
        env: { ...process.env, DATABASE_URL: 'postgresql://bseo:bseo@localhost:5432/bseo_prod' },
      });
      throw new Error('bench-hot should have refused a non-test DATABASE_URL');
    } catch (err: any) {
      expect(err.code).toBe(2); // process.exit(2)
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      expect(out).toMatch(/REFUSING/);
      expect(out).toMatch(/TRUNCATE tenants/);
    }
  });
});
