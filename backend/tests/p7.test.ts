import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

/**
 * Boot smoke regression test.
 *
 * The API server once failed to boot at all: the inner route-group
 * registrations inside buildApp() were not awaited, which deadlocked
 * fastify/avvio — `await app.register(...)` never resolved and the process
 * exited silently. This test boots the full app (mock mode, no DB/Redis
 * needed) and asserts the route tree is complete.
 */
describe('buildApp (boot smoke)', () => {
  it('boots and registers every route group', async () => {
    const app = await buildApp();
    await app.ready();

    // One representative route per group (method + url must match exactly).
    const expected: Array<[string, string]> = [
      ['POST', '/api/v1/auth/signup'],
      ['POST', '/api/v1/billing/checkout'],
      ['GET', '/api/v1/sites'],
      ['GET', '/api/v1/sites/:id/gsc/auth-url'],
      ['GET', '/api/v1/sites/:id/ga4/auth-url'],
      ['GET', '/api/v1/sites/:id/ga4/overview'],
      ['POST', '/api/v1/sites/:id/ga4/connect'],
      ['GET', '/api/v1/ga4/callback'],
      ['GET', '/api/v1/ga4/mock-consent'],
      ['POST', '/api/v1/sites/:id/audits'],
      ['POST', '/api/v1/sites/:id/keywords/research'],
      ['GET', '/api/v1/sites/:id/ranks'],
      ['GET', '/api/v1/sites/:id/content'],
      ['GET', '/api/v1/content/:id/export'],
      ['GET', '/api/v1/sites/:id/onpage'],
      ['GET', '/api/v1/sites/:id/backlinks'],
      ['POST', '/api/v1/sites/:id/backlinks/upload'],
      ['GET', '/api/v1/sites/:id/geo'],
      ['GET', '/api/v1/sites/:id/reports'],
      ['GET', '/api/v1/settings'],
    ];
    for (const [method, url] of expected) {
      expect(app.hasRoute({ method: method as any, url }), `${method} ${url}`).toBe(true);
    }

    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);

    await app.close();
  }, 30000);
});
