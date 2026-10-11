// Hardening-1 — two small fixes:
//  1. safeFetch must NOT forward Authorization/Cookie on cross-host redirects
//     (same-host redirects keep headers).
//  2. PATCH /settings llm_provider accepts mock|gemini|openai|null, the
//     frontend's legacy 'default' normalizes to null, invalid → 400
//     VALIDATION_ERROR; the value flows into getLLMForTenant selection.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { safeFetch , shouldStripCredentials } from '../src/services/safeFetch.js';
import { buildApp } from '../src/index.js';
import { pool, query, runMigrations } from '../src/db.js';
import { getLLMForTenant } from '../src/providers/llm.js';
import { auth, signupVerified, tenantCollector } from './helpers-ba.js';

// ---------------------------------------------------------------------------
// Fix 1: safeFetch redirect credential stripping
// ---------------------------------------------------------------------------

interface SeenHeaders {
  authorization?: string;
  cookie?: string;
  'x-custom'?: string;
}

let serverA: http.Server;
let serverB: http.Server;
let portA = 0;
let portB = 0;
let seenByA: SeenHeaders = {};
let seenByB: SeenHeaders = {};

const echo = (seen: () => SeenHeaders) => (req: http.IncomingMessage, res: http.ServerResponse) => {
  const target = seen();
  target.authorization = req.headers.authorization;
  target.cookie = req.headers.cookie;
  target['x-custom'] = req.headers['x-custom'] as string | undefined;
  res.setHeader('Content-Type', 'text/html');
  res.end('<html><body>echo</body></html>');
};

beforeAll(async () => {
  serverB = http.createServer(echo(() => seenByB));
  await new Promise<void>((r) => serverB.listen(0, '127.0.0.1', () => r()));
  portB = (serverB.address() as AddressInfo).port;

  serverA = http.createServer((req, res) => {
    if (req.url === '/redirect-cross') {
      res.writeHead(302, { Location: `http://b-test.invalid:${portB}/echo` });
      res.end();
      return;
    }
    if (req.url === '/redirect-same') {
      res.writeHead(302, { Location: '/echo' });
      res.end();
      return;
    }
    echo(() => seenByA)(req, res);
  });
  await new Promise<void>((r) => serverA.listen(0, '127.0.0.1', () => r()));
  portA = (serverA.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => serverA.close(() => r(undefined)));
  await new Promise((r) => serverB.close(() => r(undefined)));
});

const dnsLookup = async (_hostname: string) => [{ address: '127.0.0.1', family: 4 }];

const CREDS = {
  Authorization: 'Bearer top-secret-token',
  Cookie: 'session=abc123',
  'X-Custom': 'keep-me',
};

describe('Hardening-1 safeFetch redirect credentials', () => {
  it('cross-host redirect: target sees NO Authorization/Cookie', async () => {
    seenByB = {};
    const res = await safeFetch(
      `http://a-test.invalid:${portA}/redirect-cross`,
      { headers: CREDS },
      8000,
      5,
      { dnsLookup },
    );
    expect(res.status).toBe(200);
    expect(seenByB.authorization).toBeUndefined();
    expect(seenByB.cookie).toBeUndefined();
    // Only credential headers are stripped; unrelated headers still flow.
    expect(seenByB['x-custom']).toBe('keep-me');
  });

  it('same-host redirect: Authorization/Cookie preserved', async () => {
    seenByA = {};
    const res = await safeFetch(
      `http://a-test.invalid:${portA}/redirect-same`,
      { headers: CREDS },
      8000,
      5,
      { dnsLookup },
    );
    expect(res.status).toBe(200);
    expect(seenByA.authorization).toBe('Bearer top-secret-token');
    expect(seenByA.cookie).toBe('session=abc123');
  });
});

// ---------------------------------------------------------------------------
// Fix 2: PATCH /settings llm_provider
// ---------------------------------------------------------------------------

const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

describe.runIf(HAS_TEST_DB)('Hardening-1 settings llm_provider', () => {
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

  const patchProvider = (token: string, value: string | null) =>
    app.inject({
      method: 'PATCH',
      url: '/api/v1/settings',
      headers: auth(token),
      payload: { llm_provider: value },
    });

  const getProvider = async (token: string) => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/settings', headers: auth(token) });
    expect(r.statusCode).toBe(200);
    return (r.json() as any).llm_provider;
  };

  it.each([
    ['gemini', 'gemini'],
    ['openai', 'openai'],
    ['mock', 'mock'],
    ['default', null], // legacy frontend value → null ("use server default")
    [null, null],
  ])('PATCH llm_provider=%s → 200, persisted as %s', async (sent, persisted) => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);
    const r = await patchProvider(u.token, sent);
    expect(r.statusCode).toBe(200);
    expect((r.json() as any).llm_provider).toBe(persisted);
    expect(await getProvider(u.token)).toBe(persisted);
  });

  it('invalid llm_provider → 400 VALIDATION_ERROR', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);
    const r = await patchProvider(u.token, 'claude');
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('the persisted value flows into tenant provider selection', async () => {
    const u = await signupVerified(app);
    tc.add(u.tenantId);

    await patchProvider(u.token, 'gemini');
    expect((await getLLMForTenant(u.tenantId)).name).toBe('gemini');

    await patchProvider(u.token, 'openai');
    expect((await getLLMForTenant(u.tenantId)).name).toBe('openai');

    await patchProvider(u.token, 'mock');
    const mock = await getLLMForTenant(u.tenantId);
    expect(mock.name).toBe('mock');
    expect(mock.isMock).toBe(true);
  });
});

describe('shouldStripCredentials (LA: https->http downgrade residual)', () => {
  const u = (s: string) => new URL(s);
  it('strips on host change', () => {
    expect(shouldStripCredentials(u('https://a.example/x'), u('https://b.example/y'))).toBe(true);
  });
  it('strips on same-host https->http downgrade', () => {
    expect(shouldStripCredentials(u('https://a.example/x'), u('http://a.example/y'))).toBe(true);
  });
  it('keeps headers on same-origin redirects', () => {
    expect(shouldStripCredentials(u('https://a.example/x'), u('https://a.example/y'))).toBe(false);
    expect(shouldStripCredentials(u('http://a.example/x'), u('http://a.example/y'))).toBe(false);
  });
  it('keeps headers on http->https upgrade (same host)', () => {
    expect(shouldStripCredentials(u('http://a.example/x'), u('https://a.example/y'))).toBe(false);
  });
  it('strips when the port changes (host includes port)', () => {
    expect(shouldStripCredentials(u('https://a.example:8443/x'), u('https://a.example:9443/y'))).toBe(true);
  });
});
