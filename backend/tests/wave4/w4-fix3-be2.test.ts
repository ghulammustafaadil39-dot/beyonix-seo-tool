/**
 * Wave-4 Pass #3 regression tests — BE-2 (metering / fairness / scheduler).
 *
 * C1-M-4 + C5-M-4: commitUsage clamps actualUnits to the reserved amount.
 * C1-M-5:          crawl_pages goes through reserveUsage/commitUsage (metering level).
 * C1-M-8:          competitor gap endpoints batch serp_snapshots (single query).
 * C2-M-1:          worker claims audits conditionally; a reaped row is NOT
 *                  resurrected (job dropped via UnrecoverableError).
 * C2-L5:           expired reservations cannot be committed (410).
 * C2-L6:           scheduler ticks compute the idempotency date key once.
 * C5-M-3:          recordProviderSpend prices unpriced units (cents circuit live).
 * C5-L-5:          checkLimit counts reservation holds for sites/keywords_tracked.
 * Low (batching):  keyword-list member add is a batched INSERT, not per-id N+1.
 * Low (verify):    getSerpSnapshot cache hits keep the honest mock label.
 * Low (verify):    isoWeek stays pure-UTC.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { UnrecoverableError, type Job } from 'bullmq';
import { buildTestApp, query, signupOwner, createSite, authz } from './helpers.js';
import {
  reserveUsage,
  commitUsage,
  cancelUsage,
  checkLimit,
  getUsage,
  recordProviderSpend,
  getProviderSpend,
} from '../../src/metering.js';
import { priceProviderUnits } from '../../src/services/providerGuard.js';
import { isoWeek } from '../../src/weekKey.js';
import { getSerpSnapshot, snapshotCacheKey } from '../../src/services/serpSnapshots.js';
import { crawlProcessor } from '../../src/services/crawlJobs.js';

const mockEnqueue = vi.hoisted(() => vi.fn());
vi.mock('../../src/queues.js', () => ({
  enqueue: mockEnqueue,
  QUEUES: {
    crawl: 'crawl',
    rankCheck: 'rank-check',
    keywordRefresh: 'keyword-refresh',
    geoCheck: 'geo-check',
    report: 'report',
    content: 'content',
  },
  Jobs: {
    CRAWL_SITE: 'crawl-site',
    LIGHT_CHECK: 'light-check',
    RANK_CHECK: 'rank-check',
    KEYWORD_REFRESH: 'keyword-refresh',
    GEO_CHECK: 'geo-check',
    WEEKLY_REPORT: 'weekly-report',
    GENERATE_CONTENT: 'generate-content',
    BACKLINK_REFRESH: 'backlink-refresh',
    REVERIFY_SITE: 'reverify-site',
  },
}));

let app: Awaited<ReturnType<typeof buildTestApp>>;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('C1-M-4/C5-M-4: commitUsage clamps actualUnits to the reserved amount', () => {
  it('commits at most the reserved units when the caller reports more', async () => {
    const owner = await signupOwner(app);
    const rsv = await reserveUsage(owner.tenantId, 'starter', 'ai_words', 10, { limitOverride: 1000 });
    await commitUsage(rsv.reservationId, 25);
    const row = await query(`SELECT status, units FROM usage_reservations WHERE id = $1`, [rsv.reservationId]);
    expect(row.rows[0].status).toBe('committed');
    expect(Number(row.rows[0].units)).toBe(10); // clamped, not 25
    const ev = await query(
      `SELECT COALESCE(SUM(units),0)::int AS u FROM usage_events WHERE tenant_id = $1 AND event_type = 'ai_words'`,
      [owner.tenantId],
    );
    expect(Number(ev.rows[0].u)).toBe(10);
  });

  it('committing without actualUnits commits the full reservation', async () => {
    const owner = await signupOwner(app);
    const rsv = await reserveUsage(owner.tenantId, 'starter', 'ai_words', 7, { limitOverride: 1000 });
    await commitUsage(rsv.reservationId);
    expect(await getUsage(owner.tenantId, 'ai_words')).toBe(7);
  });

  it('committing fewer than reserved records the actual (partial results)', async () => {
    const owner = await signupOwner(app);
    const rsv = await reserveUsage(owner.tenantId, 'starter', 'ai_words', 10, { limitOverride: 1000 });
    await commitUsage(rsv.reservationId, 3);
    expect(await getUsage(owner.tenantId, 'ai_words')).toBe(3);
  });

  it('a second commit of the same reservation is rejected (idempotent flip)', async () => {
    const owner = await signupOwner(app);
    const rsv = await reserveUsage(owner.tenantId, 'starter', 'ai_words', 5, { limitOverride: 1000 });
    await commitUsage(rsv.reservationId, 5);
    await expect(commitUsage(rsv.reservationId, 5)).rejects.toMatchObject({ status: 404 });
  });
});

describe('C2-L5: expired reservations cannot be committed', () => {
  it('commit after expiry throws 410 and records no spend', async () => {
    const owner = await signupOwner(app);
    const rsv = await reserveUsage(owner.tenantId, 'starter', 'ai_words', 10, { limitOverride: 1000 });
    await query(`UPDATE usage_reservations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      rsv.reservationId,
    ]);
    await expect(commitUsage(rsv.reservationId, 10)).rejects.toMatchObject({
      status: 410,
      code: 'RESERVATION_EXPIRED',
    });
    expect(await getUsage(owner.tenantId, 'ai_words')).toBe(0);
  });

  it('an expired hold no longer blocks a fresh reservation', async () => {
    const owner = await signupOwner(app);
    const first = await reserveUsage(owner.tenantId, 'starter', 'ai_words', 10, { limitOverride: 10 });
    await query(`UPDATE usage_reservations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      first.reservationId,
    ]);
    // The expired hold is freed: a new reservation for the full limit succeeds.
    const second = await reserveUsage(owner.tenantId, 'starter', 'ai_words', 10, { limitOverride: 10 });
    expect(second.reservationId).toBeTruthy();
    await cancelUsage(second.reservationId);
  });
});

describe('C2-M-1: conditional audit claim (no reaper resurrection)', () => {
  it('a reaped (failed) audit row is NOT resurrected — the job is dropped', async () => {
    const owner = await signupOwner(app);
    const siteId = await createSite(app, owner);
    const ins = await query(
      `INSERT INTO audits (id, tenant_id, site_id, status, started_at)
       VALUES (gen_random_uuid(), $1, $2, 'failed', now() - interval '3 hours') RETURNING id`,
      [owner.tenantId, siteId],
    );
    const auditId = ins.rows[0].id as string;
    const job = { name: 'crawl-site', data: { siteId, tenantId: owner.tenantId, auditId } } as unknown as Job;
    await expect(crawlProcessor(job)).rejects.toBeInstanceOf(UnrecoverableError);
    const row = await query(`SELECT status FROM audits WHERE id = $1`, [auditId]);
    expect(row.rows[0].status).toBe('failed'); // still failed, not running
  });

  it('a queued audit row IS claimed to running', async () => {
    const owner = await signupOwner(app);
    const siteId = await createSite(app, owner);
    const ins = await query(
      `INSERT INTO audits (id, tenant_id, site_id, status, started_at)
       VALUES (gen_random_uuid(), $1, $2, 'queued', now()) RETURNING id`,
      [owner.tenantId, siteId],
    );
    const auditId = ins.rows[0].id as string;
    // Exercise the exact claim predicate the worker uses.
    const claimed = await query(
      `UPDATE audits SET status = 'running', started_at = COALESCE(started_at, now())
       WHERE id = $1 AND tenant_id = $2 AND status = 'queued'`,
      [auditId, owner.tenantId],
    );
    expect(claimed.rowCount).toBe(1);
    const row = await query(`SELECT status FROM audits WHERE id = $1`, [auditId]);
    expect(row.rows[0].status).toBe('running');
  });
});

describe('C1-M-5: crawl_pages goes through reserveUsage/commitUsage', () => {
  it('concurrent audits cannot collectively overshoot the crawl_pages limit', async () => {
    const owner = await signupOwner(app);
    // Two full-size crawl reservations against a limit of 100: exactly one wins.
    const results = await Promise.allSettled([
      reserveUsage(owner.tenantId, 'starter', 'crawl_pages', 60, { limitOverride: 100 }),
      reserveUsage(owner.tenantId, 'starter', 'crawl_pages', 60, { limitOverride: 100 }),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ status: 402, code: 'LIMIT_EXCEEDED' });
    const rsv = (won[0] as PromiseFulfilledResult<{ reservationId: string }>).value;
    // Commit the actual fresh-page count (less than reserved).
    await commitUsage(rsv.reservationId, 42);
    expect(await getUsage(owner.tenantId, 'crawl_page')).toBe(42);
  });

  it('a failed crawl releases its hold via cancelUsage', async () => {
    const owner = await signupOwner(app);
    const rsv = await reserveUsage(owner.tenantId, 'starter', 'crawl_pages', 50, { limitOverride: 100 });
    await cancelUsage(rsv.reservationId);
    expect(await getUsage(owner.tenantId, 'crawl_page')).toBe(0);
    // The freed hold lets a full-size reservation through again.
    const again = await reserveUsage(owner.tenantId, 'starter', 'crawl_pages', 100, { limitOverride: 100 });
    expect(again.reservationId).toBeTruthy();
    await cancelUsage(again.reservationId);
  });
});

describe('C5-M-3: provider spend is priced (dollar circuit can trip)', () => {
  it('recordProviderSpend with costCents=0 records the default unit price', async () => {
    const owner = await signupOwner(app);
    await recordProviderSpend(owner.tenantId, 'dataforseo', 'serp', 1, 0);
    const spend = await getProviderSpend(owner.tenantId, { provider: 'dataforseo', feature: 'serp' });
    expect(spend.units).toBe(1);
    expect(spend.costCents).toBeGreaterThan(0); // priced: ceil(1 * 0.2) = 1
  });

  it('an explicit caller-supplied cost always wins', async () => {
    const owner = await signupOwner(app);
    await recordProviderSpend(owner.tenantId, 'dataforseo', 'serp', 1, 500);
    const spend = await getProviderSpend(owner.tenantId, { provider: 'dataforseo', feature: 'serp' });
    expect(spend.costCents).toBe(500);
  });

  it('priceProviderUnits: unknown feature/provider price at 0', () => {
    expect(priceProviderUnits('dataforseo', 'nope', 10)).toBe(0);
    expect(priceProviderUnits('mock-dataforseo', 'serp', 10)).toBe(0);
    expect(priceProviderUnits('dataforseo', 'serp', 0)).toBe(0);
  });

  it('priceProviderUnits: env override calibrates per feature', () => {
    process.env.PROVIDER_PRICE_SERP_CENTS = '5';
    try {
      expect(priceProviderUnits('dataforseo', 'serp', 2)).toBe(10);
      expect(priceProviderUnits('dataforseo', 'keyword_metrics', 2)).toBeGreaterThan(0); // default table
    } finally {
      delete process.env.PROVIDER_PRICE_SERP_CENTS;
    }
  });
});

describe('C5-L-5: checkLimit counts reservation holds', () => {
  it('an uncommitted sites hold is visible to checkLimit', async () => {
    const owner = await signupOwner(app);
    const before = await checkLimit(owner.tenantId, 'starter', 'sites');
    const rsv = await reserveUsage(owner.tenantId, 'starter', 'sites', 1, { limitOverride: 100 });
    const after = await checkLimit(owner.tenantId, 'starter', 'sites');
    expect(after.used).toBe(before.used + 1);
    await cancelUsage(rsv.reservationId);
  });
});

describe('C1-M-8: competitor gap endpoints batch serp_snapshots', () => {
  async function seedGaps() {
    const owner = await signupOwner(app);
    const siteId = await createSite(app, owner);
    const site = (await query(`SELECT domain FROM sites WHERE id = $1`, [siteId])).rows[0];
    await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/competitors`,
      headers: authz(owner),
      payload: { domain: 'rival.example' },
    });
    const kw = (
      await query(
        `INSERT INTO keywords (id, tenant_id, site_id, keyword, volume, tracked)
         VALUES (gen_random_uuid(), $1, $2, 'w4 gap keyword', 900, TRUE) RETURNING id`,
        [owner.tenantId, siteId],
      )
    ).rows[0].id as string;
    const snap = (
      await query(
        `INSERT INTO serp_snapshots (id, cache_key, keyword, items, source_provider)
         VALUES (gen_random_uuid(), $1, 'w4 gap keyword', $2, 'dataforseo') RETURNING id`,
        [
          `w4gap-${Date.now()}`,
          JSON.stringify([
            { position: 1, domain: 'rival.example', url: 'https://rival.example/', title: 'r' },
            { position: 25, domain: site.domain, url: `https://${site.domain}/`, title: 's' },
          ]),
        ],
      )
    ).rows[0].id as string;
    await query(
      `INSERT INTO rank_checks (id, tenant_id, keyword_id, position, snapshot_id, checked_at)
       VALUES (gen_random_uuid(), $1, $2, 25, $3, now())`,
      [owner.tenantId, kw, snap],
    );
    return { owner, siteId };
  }

  it('compare returns competitor positions from the batched snapshot', async () => {
    const { owner, siteId } = await seedGaps();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${siteId}/competitors/compare`,
      headers: authz(owner),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.keywords).toHaveLength(1);
    expect(body.keywords[0].competitors['rival.example']).toBe(1);
    expect(body.keywords[0].sitePosition).toBe(25);
  });

  it('keyword-gaps flags the competitor top-10 win', async () => {
    const { owner, siteId } = await seedGaps();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${siteId}/competitors/keyword-gaps`,
      headers: authz(owner),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.total).toBe(1);
    expect(body.gaps[0]).toMatchObject({
      keyword: 'w4 gap keyword',
      competitor: 'rival.example',
      competitorPosition: 1,
    });
  });

  it('content-gaps flags the uncovered keyword with a suggestion', async () => {
    const { owner, siteId } = await seedGaps();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${siteId}/competitors/content-gaps`,
      headers: authz(owner),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.total).toBe(1);
    expect(body.gaps[0].suggestion).toContain('rival.example');
  });
});

describe('Low: keyword-list member add is batched', () => {
  it('adds many members in one call, dedupes, and skips unknown ids', async () => {
    const owner = await signupOwner(app);
    const siteId = await createSite(app, owner);
    const kwIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await query(
        `INSERT INTO keywords (id, tenant_id, site_id, keyword) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
        [owner.tenantId, siteId, `w4 list kw ${Date.now()}-${i}`],
      );
      kwIds.push(r.rows[0].id as string);
    }
    const listRes = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/keyword-lists`,
      headers: authz(owner),
      payload: { name: 'w4 list' },
    });
    expect(listRes.statusCode).toBe(201);
    const listId = (listRes.json() as any).list.id as string;
    const bogus = '00000000-0000-0000-0000-000000000000';

    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/keyword-lists/${listId}/keywords`,
      headers: authz(owner),
      payload: { keywordIds: [...kwIds, kwIds[0], bogus] }, // dupe + unknown id
    });
    expect(add.statusCode).toBe(200);
    expect((add.json() as any).added).toBe(3);

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/keyword-lists/${listId}/keywords`,
      headers: authz(owner),
      payload: { keywordIds: kwIds },
    });
    expect((again.json() as any).added).toBe(0); // conflicts -> DO NOTHING
  });
});

describe('Low (verify holding): getSerpSnapshot cache-hit mock flag', () => {
  it('a mock-fetched snapshot served from cache is labeled mock', async () => {
    const owner = await signupOwner(app);
    const kw = `w4 mock kw ${Date.now()}`;
    await query(
      `INSERT INTO serp_snapshots (id, cache_key, keyword, items, source_provider)
       VALUES (gen_random_uuid(), $1, $2, '[]', 'mock-dataforseo')`,
      [snapshotCacheKey(kw, 2840, 'desktop', 'en'), kw],
    );
    const snap = await getSerpSnapshot(owner.tenantId, kw, 'example.com');
    expect(snap.cached).toBe(true);
    expect(snap.providerIsMock).toBe(true);
  });

  it('a real-fetched snapshot served from cache is labeled real', async () => {
    const owner = await signupOwner(app);
    const kw = `w4 real kw ${Date.now()}`;
    await query(
      `INSERT INTO serp_snapshots (id, cache_key, keyword, items, source_provider)
       VALUES (gen_random_uuid(), $1, $2, '[]', 'dataforseo')`,
      [snapshotCacheKey(kw, 2840, 'desktop', 'en'), kw],
    );
    const snap = await getSerpSnapshot(owner.tenantId, kw, 'example.com');
    expect(snap.cached).toBe(true);
    expect(snap.providerIsMock).toBe(false);
  });
});

describe('Low (verify holding): isoWeek is pure-UTC', () => {
  it('matches known ISO weeks at UTC boundaries', () => {
    // 2026-01-01 is a Thursday -> ISO week 1 of 2026.
    expect(isoWeek(new Date('2026-01-01T00:30:00Z'))).toBe('2026-W01');
    // 2026-01-01T00:30+05:00 is 2025-12-31 19:30 UTC (a Wednesday) -> the
    // UTC calendar date decides: ISO week 1 of 2026, not "week 53 of 2025".
    expect(isoWeek(new Date('2026-01-01T00:30:00+05:00'))).toBe('2026-W01');
    // Year boundary: 2021-01-01 is a Friday -> ISO week 53 of 2020.
    expect(isoWeek(new Date('2021-01-01T00:30:00Z'))).toBe('2020-W53');
    // 2026-10-11 is a Sunday -> ISO week 41 of 2026.
    expect(isoWeek(new Date('2026-10-11T23:30:00Z'))).toBe('2026-W41');
  });
});

describe('C2-L6: scheduler ticks compute the idempotency date key once', () => {
  it('rank-checks tick gives every site the same date key across a UTC midnight', async () => {
    const { SCHEDULES } = await import('../../src/scheduler.js');
    const tick = SCHEDULES.find((s) => s.name === 'rank-checks');
    expect(tick).toBeTruthy();

    const owner = await signupOwner(app);
    await query(`UPDATE tenants SET plan_id = 'pro' WHERE id = $1`, [owner.tenantId]); // daily rank checks
    const siteA = await createSite(app, owner);
    const siteB = await createSite(app, owner);
    await query(`UPDATE sites SET verified = TRUE WHERE id = ANY($1)`, [[siteA, siteB]]);

    // Alternate successive no-arg `new Date()` calls across a UTC midnight:
    // the old per-row code handed different sites different date keys.
    const RealDate = Date;
    let dateCalls = 0;
    const dateSpy = vi.spyOn(globalThis, 'Date').mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      if (args.length === 0) {
        dateCalls += 1;
        return dateCalls % 2 === 1
          ? new RealDate('2026-10-11T23:59:59.000Z')
          : new RealDate('2026-10-12T00:00:01.000Z');
      }
      return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
    } as unknown as DateConstructor);
    for (const k of ['UTC', 'parse', 'now'] as const) {
      (globalThis.Date as unknown as Record<string, unknown>)[k] = (
        RealDate as unknown as Record<string, unknown>
      )[k];
    }

    mockEnqueue.mockClear();
    try {
      await tick!.run();
    } finally {
      dateSpy.mockRestore();
    }

    const mine = mockEnqueue.mock.calls.filter((c) => [siteA, siteB].includes((c[2] as any).siteId));
    expect(mine.length).toBe(2);
    const keys = mine.map((c) => (c[3] as any).idempotencyKey as string);
    // Both keys share the single per-tick date (the first call's date).
    expect(keys[0]).toMatch(/:2026-10-11$/);
    expect(keys[1]).toMatch(/:2026-10-11$/);
  });
});
