import { EventEmitter } from 'node:events';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import { pool, query, runMigrations } from '../src/db.js';
import { isoWeek, SCHEDULES, SCHEDULER_TIMEZONE } from '../src/scheduler.js';
import {
  captureDeadLetter,
  checkTenantRateLimit,
  enqueue,
  getQueue,
  jitteredBackoffStrategy,
  QUEUE_TIMEOUTS_MS,
  resetQueuesForTests,
} from '../src/queues.js';
import { shouldDeadLetter, withJobTimeout } from '../src/worker.js';
import { createLeaderElection } from '../src/services/leaderElection.js';
import { CircuitBreaker, CircuitOpenError } from '../src/services/circuitBreaker.js';
import { installGracefulShutdown } from '../src/shutdown.js';

/**
 * C-03 (HIGH): queue reliability.
 *  - N-A2-1: graceful shutdown drains in-flight work (api + worker).
 *  - N-A2-2: scheduler leader election (exactly one tick across N workers);
 *    isoWeek uses UTC getters (cron schedules run in UTC).
 *  - N-A1-3: per-tenant enqueue rate limiting is wired (no longer dead code).
 *  - Dead-letter queue capture for terminally failed jobs.
 *  - Job timeouts, stalled-job config, jittered backoff, circuit breakers.
 *
 * Needs Redis on localhost:6379 and DATABASE_URL at a test database.
 */
const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

describe('C-03 queues', () => {
  it('isoWeek is computed from UTC date parts (N-A2-2)', () => {
    expect(isoWeek(new Date(Date.UTC(2024, 0, 1)))).toBe('2024-W01'); // Monday
    expect(isoWeek(new Date('2023-12-31T23:30:00Z'))).toBe('2023-W52'); // Sunday
    expect(isoWeek(new Date('2024-12-30T00:00:00Z'))).toBe('2025-W01'); // Monday, next ISO year
  });

  it('isoWeek does not depend on the server timezone', () => {
    const prev = process.env.TZ;
    process.env.TZ = 'America/New_York'; // UTC-5: 2024-01-01T02:00Z is still Dec 31 locally
    try {
      expect(isoWeek(new Date('2024-01-01T02:00:00Z'))).toBe('2024-W01');
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it('every schedule is defined for the UTC timezone', () => {
    expect(SCHEDULER_TIMEZONE).toBe('UTC');
    expect(SCHEDULES.length).toBeGreaterThanOrEqual(9);
    for (const s of SCHEDULES) {
      expect(s.cron.split(' ').length).toBe(5);
    }
    expect(SCHEDULES.map((s) => s.name)).toContain('billing-grace');
    expect(SCHEDULES.map((s) => s.name)).toContain('retention-cleanup');
  });

  it('leader election: exactly one of two contenders wins (N-A2-2)', async () => {
    const key = `test:leader:${Date.now()}`;
    const r1 = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
    const r2 = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
    try {
      const e1 = createLeaderElection(key, 5000, r1);
      const e2 = createLeaderElection(key, 5000, r2);
      const [w1, w2] = await Promise.all([e1.tryAcquire(), e2.tryAcquire()]);
      expect([w1, w2].filter(Boolean)).toHaveLength(1);
      // The winner stays leader on re-entry (tick N+1).
      const winner = w1 ? e1 : e2;
      expect(await winner.tryAcquire()).toBe(true);
      // After release, the other contender can take over.
      await winner.release();
      const loser = w1 ? e2 : e1;
      expect(await loser.tryAcquire()).toBe(true);
      await loser.release();
    } finally {
      r1.disconnect();
      r2.disconnect();
    }
  });

  it('enqueue enforces the per-tenant token bucket (N-A1-3)', async () => {
    const tenantId = `c03-rl-${Date.now()}`;
    const queueName = `c03-test-q-${Date.now()}`;
    // 10/min is the bucket: the 11th enqueue must 429.
    for (let i = 0; i < 10; i++) {
      await enqueue(queueName, 'test-job', { tenantId, i }, { rateLimit: true });
    }
    await expect(enqueue(queueName, 'test-job', { tenantId, i: 10 }, { rateLimit: true })).rejects.toMatchObject({
      status: 429,
      code: 'TENANT_QUEUE_RATE_LIMITED',
    });
    // System callers (scheduler) bypass with rateLimit: false.
    await enqueue(queueName, 'test-job', { tenantId, i: 11 }, { rateLimit: false });
    // No tenantId -> no limiting (backwards compatible).
    await enqueue(queueName, 'test-job', { i: 12 });
    const q = getQueue(queueName);
    const counts = await q.getJobCounts();
    expect(counts.waiting + counts.delayed).toBeGreaterThanOrEqual(12);
    await q.obliterate({ force: true });
    resetQueuesForTests();
  });

  it('checkTenantRateLimit is no longer dead code: direct calls agree with enqueue', async () => {
    const tenantId = `c03-rl2-${Date.now()}`;
    for (let i = 0; i < 10; i++) {
      expect(await checkTenantRateLimit(tenantId, 'some-queue')).toBe(true);
    }
    expect(await checkTenantRateLimit(tenantId, 'some-queue')).toBe(false);
  });

  it('queues carry jittered custom backoff + per-queue timeouts', () => {
    const q = getQueue(`c03-opts-${Date.now()}`);
    const opts: any = q.opts?.defaultJobOptions ?? {};
    expect(opts.attempts).toBe(3);
    expect(opts.backoff?.type).toBe('custom');
    // Jittered exponential: attempt 1 -> [2500, 7500]; attempt 3 -> [10000, 30000]; capped at 300s.
    for (let i = 0; i < 20; i++) {
      const d1 = jitteredBackoffStrategy(1);
      expect(d1).toBeGreaterThanOrEqual(2500);
      expect(d1).toBeLessThanOrEqual(7500);
    }
    expect(jitteredBackoffStrategy(10)).toBeLessThanOrEqual(450_000);
    expect(jitteredBackoffStrategy(100)).toBeLessThanOrEqual(450_000);
    expect(Object.keys(QUEUE_TIMEOUTS_MS)).toContain('crawl');
    resetQueuesForTests();
  });

  it('withJobTimeout fails an overrunning processor instead of wedging the slot', async () => {
    const job = { id: 'j1', name: 'slow' } as any;
    // Monkey-patch the crawl timeout down for this test via a fake queue key.
    (QUEUE_TIMEOUTS_MS as any)['c03-timeout-q'] = 50;
    await expect(
      withJobTimeout(job, 'c03-timeout-q', () => new Promise(() => {})),
    ).rejects.toThrow(/timed out after 50ms/);
    delete (QUEUE_TIMEOUTS_MS as any)['c03-timeout-q'];
    // Fast processors are unaffected.
    await expect(withJobTimeout(job, 'c03-timeout-q', async () => 'ok')).resolves.toBe('ok');
  });

  it('shouldDeadLetter only fires when attempts are exhausted', () => {
    expect(shouldDeadLetter({ attemptsMade: 3, opts: { attempts: 3 } } as any)).toBe(true);
    expect(shouldDeadLetter({ attemptsMade: 1, opts: { attempts: 3 } } as any)).toBe(false);
    expect(shouldDeadLetter({ attemptsMade: 0, opts: {} } as any)).toBe(false); // attempts default 1
  });

  it('graceful shutdown runs steps in order, then exits 0 (N-A2-1)', async () => {
    const emitter = new EventEmitter();
    const order: string[] = [];
    let exitCode: number | null = null;
    installGracefulShutdown(
      [
        { name: 'a', run: async () => { order.push('a'); } },
        { name: 'b', run: async () => { order.push('b'); } },
      ],
      { emitter, exit: (c) => { exitCode = c; } },
    );
    emitter.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    expect(order).toEqual(['a', 'b']);
    expect(exitCode).toBe(0);
  });

  it('a second signal during shutdown forces exit(1)', async () => {
    const emitter = new EventEmitter();
    const codes: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    installGracefulShutdown([{ name: 'slow', run: () => gate }], {
      emitter,
      exit: (c) => { codes.push(c); },
    });
    emitter.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 100));
    emitter.emit('SIGTERM');
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(codes[0]).toBe(1);
  });

  it('circuit breaker opens after the failure threshold and half-opens after reset', async () => {
    const name = `c03-cb-${Date.now()}`;
    const cb = new CircuitBreaker(name, { failureThreshold: 3, resetTimeoutMs: 150 });
    await cb.reset();
    expect(await cb.getState()).toBe('closed');
    for (let i = 0; i < 3; i++) {
      await expect(cb.exec(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    }
    expect(await cb.getState()).toBe('open');
    let called = false;
    await expect(
      cb.exec(async () => { called = true; return 1; }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(called).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(await cb.getState()).toBe('half-open');
    await expect(cb.exec(async () => 42)).resolves.toBe(42);
    expect(await cb.getState()).toBe('closed');
    await cb.reset();
  });

  it('circuit breaker counts a provider 429 as a failure (backpressure)', async () => {
    const name = `c03-cb429-${Date.now()}`;
    const cb = new CircuitBreaker(name, { failureThreshold: 2, resetTimeoutMs: 60_000 });
    await cb.reset();
    const err429 = Object.assign(new Error('Too Many Requests'), { status: 429 });
    await expect(cb.exec(async () => { throw err429; })).rejects.toThrow('Too Many Requests');
    await expect(cb.exec(async () => { throw err429; })).rejects.toThrow('Too Many Requests');
    expect(await cb.getState()).toBe('open');
    await cb.reset();
  });
});

describe.runIf(HAS_TEST_DB)('C-03 dead letters (db)', () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('captureDeadLetter stores a replayable row', async () => {
    const t = await query(
      `INSERT INTO tenants (id, name, plan_id) VALUES (gen_random_uuid(), 'c03dl', 'starter') RETURNING id`,
    );
    const tenantId = t.rows[0].id as string;
    try {
      await captureDeadLetter({
        queue: 'crawl',
        jobName: 'crawl-site',
        tenantId,
        payload: { siteId: 's1', tenantId },
        attempts: 3,
        error: 'timeout',
      });
      const r = await query(`SELECT queue, job_name, status, payload FROM dead_letter_jobs WHERE tenant_id = $1`, [
        tenantId,
      ]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ queue: 'crawl', job_name: 'crawl-site', status: 'pending' });
      expect(r.rows[0].payload).toMatchObject({ siteId: 's1' });
    } finally {
      await query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
  });
});
