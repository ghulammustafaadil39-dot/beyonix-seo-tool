/**
 * Self-test for the malicious-site fixture (tests/fixtures/malicious-site/).
 * Proves every attack route is armed correctly. Uses plain fetch — NOT
 * safeFetch — except for the S-02 bypass test below.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import {
  startFixtureSite,
  stopFixtureSite,
  FIXTURE_PORT,
  MALICIOUS_HTML,
} from './fixtures/malicious-site/server.js';
import { safeFetch, isLoopbackBypassActive } from '../src/services/safeFetch.js';

const base = `http://127.0.0.1:${FIXTURE_PORT}`;
let server: Server;

beforeAll(async () => {
  server = await startFixtureSite();
});

afterAll(async () => {
  await stopFixtureSite(server);
});

/** GET with manual redirect handling; body is cancelled, never consumed. */
async function head(url: string): Promise<Response> {
  const res = await fetch(url, { redirect: 'manual' });
  await res.body?.cancel().catch(() => undefined);
  return res;
}

describe('malicious-site fixture', () => {
  it('serves an index linking every attack route', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const p of ['/gzip-bomb', '/huge', '/redirect-loop/a', '/redirect-ssrf/metadata', '/ok']) {
      expect(html).toContain(p);
    }
  });

  it('gzip bomb is armed: tiny on the wire, huge inflated (headers only — never inflate it here)', async () => {
    const res = await head(`${base}/gzip-bomb`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const wireBytes = Number(res.headers.get('content-length'));
    expect(wireBytes).toBeGreaterThan(0);
    expect(wireBytes).toBeLessThan(1024 * 1024); // < 1 MB on the wire…
    // …but inflates to ~256 MB (N-A2-5: no size cap today)
  });

  it('huge page advertises ~32 MB', async () => {
    const res = await head(`${base}/huge`);
    expect(res.status).toBe(200);
    const bytes = Number(res.headers.get('content-length'));
    expect(bytes).toBeGreaterThan(30 * 1024 * 1024);
  });

  it('redirect loop alternates A ↔ B', async () => {
    const a = await head(`${base}/redirect-loop/a`);
    expect(a.status).toBe(302);
    expect(a.headers.get('location')).toBe('/redirect-loop/b');
    const b = await head(`${base}/redirect-loop/b`);
    expect(b.status).toBe(302);
    expect(b.headers.get('location')).toBe('/redirect-loop/a');
  });

  it('SSRF redirect targets point at blocked destinations', async () => {
    const cases: Array<[string, RegExp]> = [
      ['/redirect-ssrf/metadata', /^http:\/\/169\.254\.169\.254\//],
      ['/redirect-ssrf/loopback', /^http:\/\/127\.0\.0\.1/],
      ['/redirect-ssrf/internal', /^http:\/\/192\.168\./],
      ['/redirect-ssrf/file', /^file:\/\//],
    ];
    for (const [path, re] of cases) {
      const res = await head(`${base}${path}`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toMatch(re);
    }
  });

  it('control page is small and valid', async () => {
    const res = await fetch(`${base}/ok`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.length).toBeLessThan(10 * 1024);
    expect(html).toContain('<h1>Control page</h1>');
  });

  it('safeFetch test-only loopback bypass is active in test env, refused elsewhere (S-02)', async () => {
    // The bypass exists so the crawler can be tested against this local
    // fixture. It must be impossible to activate outside NODE_ENV=test.
    expect(isLoopbackBypassActive('test')).toBe(true);
    expect(isLoopbackBypassActive('production')).toBe(false);
    expect(isLoopbackBypassActive('development')).toBe(false);
    expect(isLoopbackBypassActive('')).toBe(false);
    // In this test env the bypass is active, so the fixture IS fetchable.
    const res = await safeFetch(`${base}/ok`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it('raw HTML fixtures exist for direct analyzePage tests', () => {
    expect(MALICIOUS_HTML.deepNest).toContain('<div>'.repeat(10));
    expect(MALICIOUS_HTML.wide.length).toBeGreaterThan(1024 * 1024);
    expect(MALICIOUS_HTML.xssShaped).toContain('onerror=');
  });
});
