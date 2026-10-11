import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { pool, query, runMigrations } from '../src/db.js';
import {
  checkLimit,
  commitUsage,
  cancelUsage,
  getBillingWindow,
  getProviderSpend,
  getUsage,
  recordProviderSpend,
  recordUsage,
  registerUsageAlertHook,
  reserveUsage,
} from '../src/metering.js';

/**
 * C-02 (HIGH): metering correctness.
 *  - reserve-then-commit: concurrent callers must NOT overspend the limit
 *    (N-A2-4 — the old check-then-act raced).
 *  - usage windows follow the tenant's BILLING period from Stripe, not the
 *    calendar month (N-A2-3).
 *  - 80%/100% alert hooks fire exactly once per period.
 *  - per-tenant DataForSEO cost tracking via recordProviderSpend.
 *  - hard 402 stops carry { upgrade, limit, used }.
 *
 * Needs DATABASE_URL pointing at a test database (bseo_test_ba).
 */
const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');

describe.runIf(HAS_TEST_DB)('C-02 metering', () => {
  let tenantSub: string; // has an active subscription -> billing-period window
  let tenantNoSub: string; // no subscription -> calendar-month fallback

  beforeAll(async () => {
    await runMigrations();
    const mk = async (name: string) => {
      const r = await query(
        `INSERT INTO tenants (id, name, plan_id) VALUES (gen_random_uuid(), $1, 'starter') RETURNING id`,
        [name],
      );
      return r.rows[0].id as string;
    };
    tenantSub = await mk('c02-sub');
    tenantNoSub = await mk('c02-nosub');
    // Billing period started 10 days ago (NOT aligned to calendar month).
    await query(
      `INSERT INTO subscriptions (id, tenant_id, stripe_sub_id, plan_id, status,
                                 current_period_start, current_period_end)
       VALUES (gen_random_uuid(), $1, 'sub_c02', 'starter', 'active',
               now() - interval '10 days', now() + interval '20 days')`,
      [tenantSub],
    );
  }, 60000);

  afterAll(async () => {
    await query('DELETE FROM tenants WHERE id = ANY($1)', [[tenantSub, tenantNoSub]]);
    await pool.end();
  });

  it('getUsage windows on the Stripe billing period, not the calendar month', async () => {
    // 40 days ago: inside the calendar month? No — but more importantly it
    // is OUTSIDE the billing period (started 10 days ago).
    await recordUsage(tenantSub, 'serp_check', 7, undefined, { tag: 'old' });
    await query(
      `UPDATE usage_events SET created_at = now() - interval '40 days'
       WHERE tenant_id = $1 AND meta->>'tag' = 'old'`,
      [tenantSub],
    );
    await recordUsage(tenantSub, 'serp_check', 3);
    const used = await getUsage(tenantSub, 'serp_check');
    expect(used).toBe(3); // the 40-day-old row is outside the billing window
  });

  it('getUsage falls back to the calendar month with no subscription', async () => {
    await recordUsage(tenantNoSub, 'serp_check', 2, undefined, { tag: 'old2' });
    await query(
      `UPDATE usage_events SET created_at = now() - interval '40 days'
       WHERE tenant_id = $1 AND meta->>'tag' = 'old2'`,
      [tenantNoSub],
    );
    await recordUsage(tenantNoSub, 'serp_check', 4);
    expect(await getUsage(tenantNoSub, 'serp_check')).toBe(4);
  });

  it('getBillingWindow returns the Stripe period when present', async () => {
    const w = await getBillingWindow(tenantSub);
    expect(w.start.getTime()).toBeLessThan(Date.now() - 9 * 86400_000);
    expect(w.start.getTime()).toBeGreaterThan(Date.now() - 11 * 86400_000);
  });

  it('recordUsage no longer floors zero-cost calls at 1 unit (N-A2-4)', async () => {
    const before = await getUsage(tenantNoSub, 'geo_check');
    await recordUsage(tenantNoSub, 'geo_check', 0);
    expect(await getUsage(tenantNoSub, 'geo_check')).toBe(before);
  });

  it('reserve-then-commit: 20 concurrent reserves on a limit of 10 cannot overspend', async () => {
    // starter ai_words limit is 5000 — use a tiny synthetic kind via plan
    // override? Instead test the atomicity primitive directly: 20 parallel
    // reserves of 1 unit against a limit of 10.
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        reserveUsage(tenantNoSub, 'starter', 'ai_words', 1, {
          meta: { race: `c02-${i}` },
          limitOverride: 10,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    expect(ok).toBe(10);
    expect(rejected).toBe(10);
    for (const r of results) {
      if (r.status === 'rejected') {
        expect((r.reason as any)?.status).toBe(402);
        expect((r.reason as any)?.code).toBe('LIMIT_EXCEEDED');
        expect((r.reason as any)?.extra?.upgrade).toBe(true);
      }
    }
    // Cleanup: cancel all reservations so later tests start clean.
    for (const r of results) {
      if (r.status === 'fulfilled') await cancelUsage(r.value.reservationId);
    }
  });

  it('commitUsage finalizes actual units; cancelUsage frees the hold', async () => {
    const before = await getUsage(tenantNoSub, 'keyword_metric');
    const res = await reserveUsage(tenantNoSub, 'starter', 'keyword_metrics', 5, { limitOverride: 100 });
    expect(await getUsage(tenantNoSub, 'keyword_metric')).toBe(before + 5);
    await commitUsage(res.reservationId, 3);
    expect(await getUsage(tenantNoSub, 'keyword_metric')).toBe(before + 3);

    const res2 = await reserveUsage(tenantNoSub, 'starter', 'keyword_metrics', 4, { limitOverride: 100 });
    expect(await getUsage(tenantNoSub, 'keyword_metric')).toBe(before + 3 + 4);
    await cancelUsage(res2.reservationId);
    expect(await getUsage(tenantNoSub, 'keyword_metric')).toBe(before + 3);
  });

  it('expired reservations stop counting toward the window', async () => {
    const before = await getUsage(tenantNoSub, 'crawl_page');
    const res = await reserveUsage(tenantNoSub, 'starter', 'crawl_pages', 6, { limitOverride: 1000 });
    await query(`UPDATE usage_reservations SET expires_at = now() - interval '1 minute' WHERE id = $1`, [
      res.reservationId,
    ]);
    expect(await getUsage(tenantNoSub, 'crawl_page')).toBe(before);
  });

  it('80% and 100% alert hooks fire exactly once per period', async () => {
    const fired: Array<{ level: number; used: number }> = [];
    const off = registerUsageAlertHook(async (info) => {
      if (info.tenantId === tenantNoSub && info.kind === 'geo_checks') {
        fired.push({ level: info.level, used: info.used });
      }
    });
    // Alert hooks fire fire-and-forget after commit (best-effort, never
    // blocks metering) — poll with a timeout instead of asserting
    // immediately, then assert EXACTLY-ONCE counts.
    const waitFor = async (level: 80 | 100, timeoutMs = 5000) => {
      const start = Date.now();
      for (;;) {
        if (fired.some((f) => f.level === level)) return;
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${level}% alert`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    try {
      // starter geo_checks_month = 20. Reserve 16 -> hits 80%.
      const r1 = await reserveUsage(tenantNoSub, 'starter', 'geo_checks', 16);
      await commitUsage(r1.reservationId);
      await waitFor(80);
      // Reserve again (still 80%) -> no second 80% fire.
      const r2 = await reserveUsage(tenantNoSub, 'starter', 'geo_checks', 1);
      await commitUsage(r2.reservationId);
      // Push to 20 -> 100% fires once.
      const r3 = await reserveUsage(tenantNoSub, 'starter', 'geo_checks', 3);
      await commitUsage(r3.reservationId);
      await waitFor(100);
      // Settle: a duplicate fire would arrive within this window.
      await new Promise((r) => setTimeout(r, 300));
      expect(fired.filter((f) => f.level === 80)).toHaveLength(1);
      expect(fired.filter((f) => f.level === 100)).toHaveLength(1);
    } finally {
      off();
    }
  });

  it('checkLimit 402 payload carries { upgrade, limit, used }', async () => {
    const check = await checkLimit(tenantNoSub, 'starter', 'geo_checks');
    expect(check.ok).toBe(false); // 16+1+3 = 20 = starter limit
    expect(check.used).toBeGreaterThanOrEqual(check.limit);
  });

  it('recordProviderSpend tracks per-tenant DataForSEO cost', async () => {
    await recordProviderSpend(tenantSub, 'dataforseo', 'keyword_metrics', 10, 250);
    await recordProviderSpend(tenantSub, 'dataforseo', 'serp', 5, 100);
    const total = await getProviderSpend(tenantSub, {});
    expect(total.units).toBe(15);
    expect(total.costCents).toBe(350);
    const kw = await getProviderSpend(tenantSub, { feature: 'keyword_metrics' });
    expect(kw.units).toBe(10);
    expect(kw.costCents).toBe(250);
  });
});
