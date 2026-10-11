/**
 * Wave-4 Pass #4 regression tests — BE-B (services/worker/scripts).
 *
 * D2-H-1: seedFromGsc passes the ENCRYPTED GSC refresh token through to the
 *         Google provider unchanged (the old code decrypted it first, so the
 *         provider's authed() double-decrypted and threw on every call —
 *         GSC keyword seeding silently never worked).
 * D2-M-1: the tenant queue rate limiter fails fast (429, fail-closed) on a
 *         Redis outage instead of hanging forever on the unbounded BullMQ
 *         connection.
 * D1-H-2: audit failure is attempt-aware — a transient failure on a
 *         non-final attempt resets the audit row to 'queued' so the BullMQ
 *         retry's conditional claim succeeds (and the crawl resumes); only
 *         the final attempt marks the row 'failed'.
 * D4-H-1: backup scripts are POSIX sh — verified outside vitest via
 *         `dash -n` plus old-vs-new DATABASE_URL parsing parity (tricky
 *         percent-encoded passwords decode identically under dash and bash).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Redis } from 'ioredis';
import { UnrecoverableError, type Job } from 'bullmq';
import { buildTestApp, query, signupOwner, createSite } from './helpers.js';
import { runMigrations } from '../../src/db.js';
import { seedFromGsc } from '../../src/services/keywordService.js';
import { encrypt } from '../../src/crypto.js';
import { getGoogle } from '../../src/providers/google.js';
import { crawlProcessor } from '../../src/services/crawlJobs.js';
import {
  checkTenantRateLimit,
  setLimiterRedisForTests,
  enqueue,
  QUEUES,
  Jobs,
} from '../../src/queues.js';

const mockCrawlSite = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/crawler.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/services/crawler.js')>();
  return { ...original, crawlSite: mockCrawlSite };
});
vi.mock('../../src/services/pagespeed.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/services/pagespeed.js')>();
  return {
    ...original,
    getPageSpeedMetrics: vi.fn(async () => ({ metrics: null, cached: false, quotaExhausted: false })),
  };
});

let app: Awaited<ReturnType<typeof buildTestApp>>;

beforeAll(async () => {
  await runMigrations();
  app = await buildTestApp();
});

afterAll(async () => {
  setLimiterRedisForTests(null);
  await app.close();
});

describe('D2-H-1: seedFromGsc passes the encrypted token through', () => {
  it('hands the still-encrypted refresh token to the Google provider', async () => {
    const owner = await signupOwner(app);
    const siteId = await createSite(app, owner);
    const enc = encrypt('fake-gsc-refresh-token');
    expect(enc).toMatch(/^enc2:/);
    await query(`UPDATE sites SET gsc_connected = TRUE, gsc_refresh_token_enc = $2 WHERE id = $1`, [
      siteId,
      enc,
    ]);

    // Spy the (mock) provider: the regression is about WHAT token string
    // seedFromGsc passes, and the mock never decrypts — which is exactly
    // why three audit passes missed the double-decrypt.
    const spy = vi.spyOn(getGoogle(), 'searchQueries');
    try {
      const n = await seedFromGsc(owner.tenantId, siteId);
      expect(n).toBeGreaterThan(0);
      expect(spy).toHaveBeenCalledTimes(1);
      const [tokenArg] = spy.mock.calls[0];
      // The encrypted column must go through UNCHANGED. The old code ran
      // decrypt() here, so the provider received the PLAINTEXT token and
      // its authed() threw "Unknown encrypted format" on every call.
      expect(tokenArg).toBe(enc);
    } finally {
      spy.mockRestore();
    }

    const rows = await query(`SELECT keyword, added_from FROM keywords WHERE site_id = $1`, [siteId]);
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) expect(r.added_from).toBe('gsc');
  });

  it('returns 0 without touching the provider when GSC is not connected', async () => {
    const owner = await signupOwner(app);
    const siteId = await createSite(app, owner);
    const spy = vi.spyOn(getGoogle(), 'searchQueries');
    try {
      expect(await seedFromGsc(owner.tenantId, siteId)).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('D2-M-1: rate limiter fails fast on Redis outage (fail-closed)', () => {
  function deadRedis(): Redis {
    const r = new Redis('redis://127.0.0.1:1', {
      maxRetriesPerRequest: 2,
      connectTimeout: 250,
      retryStrategy: () => null, // no reconnect loop: fail fast
      enableReadyCheck: false,
    });
    r.on('error', () => {});
    return r;
  }

  it('checkTenantRateLimit rejects 429 quickly instead of hanging', async () => {
    const dead = deadRedis();
    setLimiterRedisForTests(dead);
    try {
      const start = Date.now();
      await expect(checkTenantRateLimit('w4f4-tenant', 'crawl')).rejects.toMatchObject({
        status: 429,
        code: 'TENANT_QUEUE_RATE_LIMITED',
      });
      // Fails fast (bounded retries + 2s command ceiling) — never the
      // forever-hang the unbounded BullMQ connection produced.
      expect(Date.now() - start).toBeLessThan(8000);
    } finally {
      setLimiterRedisForTests(null);
      dead.disconnect();
    }
  });

  it('enqueue surfaces the fast 429 instead of hanging the request', async () => {
    const dead = deadRedis();
    setLimiterRedisForTests(dead);
    try {
      const start = Date.now();
      await expect(
        enqueue(QUEUES.crawl, Jobs.CRAWL_SITE, { tenantId: 'w4f4-tenant', siteId: 'w4f4-site' }),
      ).rejects.toMatchObject({ status: 429, code: 'TENANT_QUEUE_RATE_LIMITED' });
      expect(Date.now() - start).toBeLessThan(8000);
    } finally {
      setLimiterRedisForTests(null);
      dead.disconnect();
    }
  });

  it('healthy Redis still enforces the limit (fail-closed applies to outages only)', async () => {
    setLimiterRedisForTests(null);
    const tenant = `w4f4-rl-${Date.now()}`;
    expect(await checkTenantRateLimit(tenant, 'crawl', 2)).toBe(true);
    expect(await checkTenantRateLimit(tenant, 'crawl', 2)).toBe(true);
    expect(await checkTenantRateLimit(tenant, 'crawl', 2)).toBe(false);
  });
});

describe('D1-H-2: attempt-aware audit failure', () => {
  const okCrawl = {
    pages: [],
    brokenLinks: [],
    robotsFound: false,
    sitemapFound: false,
    sitemapUrls: [],
    redirectChains: [],
  };

  async function newQueuedAudit() {
    const owner = await signupOwner(app);
    const siteId = await createSite(app, owner);
    const ins = await query(
      `INSERT INTO audits (id, tenant_id, site_id, status)
       VALUES (gen_random_uuid(), $1, $2, 'queued') RETURNING id`,
      [owner.tenantId, siteId],
    );
    return { owner, siteId, auditId: ins.rows[0].id as string };
  }

  const crawlJob = (a: Awaited<ReturnType<typeof newQueuedAudit>>, attemptsMade: number) =>
    ({
      name: 'crawl-site',
      data: { siteId: a.siteId, tenantId: a.owner.tenantId, auditId: a.auditId },
      attemptsMade,
      opts: { attempts: 3 },
    }) as unknown as Job;

  const auditStatus = async (auditId: string) =>
    (await query(`SELECT status, error FROM audits WHERE id = $1`, [auditId])).rows[0] as {
      status: string;
      error: string | null;
    };

  it('a transient failure on attempt 1 resets the row to queued; the retry then succeeds', async () => {
    const a = await newQueuedAudit();
    mockCrawlSite.mockRejectedValueOnce(new Error('transient robots fetch blip'));
    mockCrawlSite.mockResolvedValueOnce(okCrawl);

    // Attempt 1 (attemptsMade=0 of 3): the crawl throws transiently.
    await expect(crawlProcessor(crawlJob(a, 0))).rejects.toThrow('transient robots fetch blip');
    // Non-final attempt: back to 'queued' (NOT 'failed') so the retry's
    // conditional claim (WHERE status='queued') succeeds. The old code
    // marked 'failed' here, so attempt 2 always died with
    // UnrecoverableError ("no longer queued — dropping job").
    expect((await auditStatus(a.auditId)).status).toBe('queued');

    // BullMQ retry: same job, attemptsMade=1. The claim succeeds and the
    // crawl (with its persisted crawl_state resume) completes.
    await crawlProcessor(crawlJob(a, 1));
    expect((await auditStatus(a.auditId)).status).toBe('done');
  });

  it('the final attempt marks the row failed with the error', async () => {
    const a = await newQueuedAudit();
    mockCrawlSite.mockRejectedValueOnce(new Error('persistent provider outage'));

    // Attempt 3 (attemptsMade=2 of 3): no retries left — terminal.
    await expect(crawlProcessor(crawlJob(a, 2))).rejects.toThrow('persistent provider outage');
    const row = await auditStatus(a.auditId);
    expect(row.status).toBe('failed');
    expect(String(row.error)).toContain('persistent provider outage');
  });

  it('a reaped row is still never resurrected (C2-M-1 still holds)', async () => {
    const a = await newQueuedAudit();
    // Simulate the stuck-audit reaper: row failed while the job was delayed.
    await query(`UPDATE audits SET status = 'failed', error = 'reaped' WHERE id = $1`, [a.auditId]);
    mockCrawlSite.mockClear();
    await expect(crawlProcessor(crawlJob(a, 0))).rejects.toBeInstanceOf(UnrecoverableError);
    expect((await auditStatus(a.auditId)).status).toBe('failed');
    expect(mockCrawlSite).not.toHaveBeenCalled();
  });
});
