/**
 * Wave-4 Pass #1 MEDIUM regression tests — batch 1 (backend).
 *
 * A1-M1: withUsageReservation reserve -> work -> commit(actual)/cancel,
 *         incl. the concurrent-overspend race.
 * A1-M2: csrfGuard treats x-api-key as non-ambient.
 * A1-M3: deleted_at IS NULL in site/keyword counts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildTestApp, query, signupOwner, createSite, authz } from './helpers.js';
import {
  withUsageReservation,
  checkLimit,
  commitUsage,
  cancelUsage,
  reserveUsage,
} from '../../src/metering.js';
import { requiresCsrfCheck } from '../../src/middleware/csrf.js';
import { ApiError } from '../../src/errors.js';

let app: Awaited<ReturnType<typeof buildTestApp>>;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

describe('A1-M1: withUsageReservation', () => {
  it('reserves, runs work, and commits with actual units on success', async () => {
    const owner = await signupOwner(app);
    // starter: ai_words limit 5000 — plenty of headroom.
    const value = await withUsageReservation(owner.tenantId, 'ai_words', 100, async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { value: 'done', actualUnits: 42 };
    });
    expect(value).toBe('done');
    const row = await query(
      `SELECT status, units FROM usage_reservations WHERE tenant_id = $1 AND event_type = 'ai_words' ORDER BY created_at DESC LIMIT 1`,
      [owner.tenantId],
    );
    expect(row.rows[0].status).toBe('committed');
    expect(Number(row.rows[0].units)).toBe(42);
  });

  it('cancels the reservation when work throws (error propagates)', async () => {
    const owner = await signupOwner(app);
    await expect(
      withUsageReservation(owner.tenantId, 'ai_words', 100, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const row = await query(
      `SELECT status FROM usage_reservations WHERE tenant_id = $1 AND event_type = 'ai_words' ORDER BY created_at DESC LIMIT 1`,
      [owner.tenantId],
    );
    expect(row.rows[0].status).toBe('cancelled');
  });

  it('two concurrent site reservations at limit 1 -> one succeeds, one 402 (no overspend)', async () => {
    const owner = await signupOwner(app); // starter plan: max_sites = 1
    const slow = () => new Promise((r) => setTimeout(r, 300));
    const attempt = () =>
      withUsageReservation(owner.tenantId, 'sites', 1, async () => {
        await slow();
        return { value: 'site-created' };
      });
    const [a, b] = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    const err = (rejected[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(402);
    expect((err as ApiError).code).toBe('LIMIT_EXCEEDED');
    // The loser's reservation must not linger as a hold.
    const holds = await query(
      `SELECT COUNT(*)::int c FROM usage_reservations
       WHERE tenant_id = $1 AND event_type = 'sites' AND status = 'reserved'`,
      [owner.tenantId],
    );
    expect(holds.rows[0].c).toBe(0);
  });

  it('committing a reservation records a usage_events row (no silent metering)', async () => {
    const owner = await signupOwner(app);
    const r = await reserveUsage(owner.tenantId, 'starter', 'keyword_metrics', 5);
    await commitUsage(r.reservationId, 3);
    const ev = await query(
      `SELECT units FROM usage_events WHERE tenant_id = $1 AND event_type = 'keyword_metric'`,
      [owner.tenantId],
    );
    expect(ev.rows.length).toBe(1);
    expect(Number(ev.rows[0].units)).toBe(3);
    // getUsage sees it exactly once (no double-count with the reservation).
    const { getUsage } = await import('../../src/metering.js');
    expect(await getUsage(owner.tenantId, 'keyword_metric')).toBe(3);
  });

  it('reserveUsage/commitUsage/cancelUsage primitives behave', async () => {
    const owner = await signupOwner(app);
    const r = await reserveUsage(owner.tenantId, 'starter', 'ai_words', 10);
    expect(r.reservationId).toBeTruthy();
    await cancelUsage(r.reservationId);
    const row = await query(`SELECT status FROM usage_reservations WHERE id = $1`, [r.reservationId]);
    expect(row.rows[0].status).toBe('cancelled');
    const r2 = await reserveUsage(owner.tenantId, 'starter', 'ai_words', 10);
    await commitUsage(r2.reservationId, 7);
    const row2 = await query(`SELECT status, units FROM usage_reservations WHERE id = $1`, [r2.reservationId]);
    expect(row2.rows[0].status).toBe('committed');
    expect(Number(row2.rows[0].units)).toBe(7);
  });
});

describe('A1-M2: csrfGuard treats x-api-key as non-ambient', () => {
  it('does not require a CSRF check when an API key header is present', () => {
    // POST + session cookie + x-api-key -> exempt (API keys are explicit auth).
    expect(requiresCsrfCheck('POST', true, false, true)).toBe(false);
    // POST + session cookie, no other credential -> CSRF check required.
    expect(requiresCsrfCheck('POST', true, false, false)).toBe(true);
    // GET is never a mutation.
    expect(requiresCsrfCheck('GET', true, false, true)).toBe(false);
  });
});

describe('A1-M3: deleted_at IS NULL in counts', () => {
  it('soft-deleted sites do not burn the plan slot', async () => {
    const owner = await signupOwner(app); // starter: max_sites = 1
    const siteId = await createSite(app, owner);
    const full = await checkLimit(owner.tenantId, 'starter', 'sites');
    expect(full.used).toBe(1);
    expect(full.ok).toBe(false); // 1 site on a 1-site plan: at the limit
    // Soft-delete the site (owner-only per A1-H2). The slot must free up —
    // without the A1-M3 fix the deleted row still counted and ok stayed false.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/sites/${siteId}`,
      headers: authz(owner),
    });
    expect(del.statusCode).toBe(200);
    const check = await checkLimit(owner.tenantId, 'starter', 'sites');
    expect(check.used).toBe(0);
    expect(check.ok).toBe(true);
  });

  it('keywords on soft-deleted sites do not burn quota', async () => {
    const owner = await signupOwner(app);
    const siteId = await createSite(app, owner);
    await query(
      `INSERT INTO keywords (id, tenant_id, site_id, keyword, tracked) VALUES (gen_random_uuid(), $1, $2, 'w4 kw', TRUE)`,
      [owner.tenantId, siteId],
    );
    const before = await checkLimit(owner.tenantId, 'starter', 'keywords_tracked');
    expect(before.used).toBe(1);
    await query(`UPDATE sites SET deleted_at = now() WHERE id = $1`, [siteId]);
    const after = await checkLimit(owner.tenantId, 'starter', 'keywords_tracked');
    expect(after.used).toBe(0);
  });
});
