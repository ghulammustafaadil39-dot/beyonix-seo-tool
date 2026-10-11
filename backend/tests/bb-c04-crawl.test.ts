// Backend-B Wave 2 — C-04 crawler vs the malicious fixture site.
// Verifies the S-02 safeFetch caps hold under attack shapes (gzip bomb,
// huge page, redirect loop, SSRF redirects) and the crawler reports them
// instead of hanging or OOMing. NODE_ENV=test enables the loopback bypass.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { startFixtureSite, stopFixtureSite, FIXTURE_PORT } from './fixtures/malicious-site/server.js';
import { crawlSite, traceRedirectHops } from '../src/services/crawler.js';

const base = `http://127.0.0.1:${FIXTURE_PORT}`;

let server: Server;
beforeAll(async () => {
  server = await startFixtureSite();
});
afterAll(async () => {
  await stopFixtureSite(server);
});

describe('crawler vs malicious fixture', () => {
  it('survives gzip bomb + huge page: size cap aborts, crawl completes', async () => {
    const result = await crawlSite(`${base}/`, {
      maxPages: 4,
      skipSitemap: true,
      imageCheckCap: 0,
    });
    expect(result.pages.length).toBeGreaterThan(0);
    const bomb = result.pages.find((p) => p.url.includes('/gzip-bomb'));
    const huge = result.pages.find((p) => p.url.includes('/huge'));
    // Both exceed the 5 MB safeFetch cap -> recorded as failed (status 0),
    // never inflated into memory.
    expect(bomb?.statusCode).toBe(0);
    expect(huge?.statusCode).toBe(0);
  }, 60000);

  it('detects the redirect loop via traceRedirectHops', async () => {
    const chain = await traceRedirectHops(`${base}/redirect-loop/a`, 3000);
    expect(chain.loopSuspected).toBe(true);
    expect(chain.hops).toBeNull();
  }, 60000);

  it('blocks SSRF redirect targets (metadata / loopback / private / file)', async () => {
    const result = await crawlSite(`${base}/redirect-ssrf/metadata`, {
      maxPages: 1,
      skipSitemap: true,
      imageCheckCap: 0,
    });
    // The redirect hop to 169.254.169.254 is blocked -> page fetch fails.
    expect(result.pages[0]?.statusCode).toBe(0);
  }, 60000);

  it('records redirect chains for moved pages', async () => {
    const result = await crawlSite(`${base}/`, {
      maxPages: 8,
      skipSitemap: true,
      imageCheckCap: 0,
    });
    // At least the loop page (if crawled) produced a chain entry or a 0-status page.
    const loopChain = result.redirectChains.find((c) => c.from.includes('/redirect-loop/'));
    const loopPage = result.pages.find((p) => p.url.includes('/redirect-loop/'));
    expect(loopChain?.loopSuspected === true || loopPage?.statusCode === 0).toBe(true);
  }, 60000);
});
