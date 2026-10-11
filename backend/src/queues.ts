import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { ApiError } from './errors.js';
import { query } from './db.js';
import { getRedis, incrWithTtl, redisKeyPrefix } from './redis.js';

let _connection: Redis | null = null;

/**
 * Lazy Redis singleton. Importing this module must NEVER open a network
 * connection (route modules import it; unit tests and `buildApp()` smoke
 * tests must work with no Redis running).
 */
export function getConnection(): Redis {
  if (!_connection) {
    _connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  }
  return _connection;
}

// ---- D2-M-1: bounded Redis client for the rate limiter (no forever-hang) ----

/**
 * Test hook: override the client the limiter below uses (e.g. point it at a
 * dead port to simulate a Redis outage). Production always uses the shared
 * bounded client from redis.ts.
 */
let _limiterRedisOverride: Redis | null = null;
export function setLimiterRedisForTests(r: Redis | null): void {
  if (_limiterRedisOverride && _limiterRedisOverride !== r) _limiterRedisOverride.disconnect();
  _limiterRedisOverride = r;
}

function limiterRedis(): Redis {
  // Same bounded client middleware/auth.ts uses (maxRetriesPerRequest: 3).
  // The BullMQ connection MUST stay maxRetriesPerRequest: null (blocking
  // commands), but commands on THAT connection retry FOREVER on a Redis
  // outage — running the limiter on it hung every user-initiated
  // enqueue() forever instead of failing fast.
  return _limiterRedisOverride ?? getRedis();
}

/** Per-command ceiling so even a half-open connection fails fast. */
const LIMITER_REDIS_TIMEOUT_MS = 2000;

/** Rejects if p does not settle within ms (the loser is ignored). */
function withCommandTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[queues] ${what} timed out after ${ms}ms`)), ms);
  });
  const settle = (fn: () => T): T => {
    if (timer) clearTimeout(timer);
    return fn();
  };
  return Promise.race([p.then((v) => settle(() => v), (e) => settle(() => { throw e; })), timeout]);
}

export const QUEUES = {
  crawl: 'crawl',
  rankCheck: 'rank-check',
  keywordRefresh: 'keyword-refresh',
  geoCheck: 'geo-check',
  report: 'report',
  content: 'content',
} as const;

export const Jobs = {
  CRAWL_SITE: 'crawl-site',
  LIGHT_CHECK: 'light-check',
  RANK_CHECK: 'rank-check',
  KEYWORD_REFRESH: 'keyword-refresh',
  GEO_CHECK: 'geo-check',
  WEEKLY_REPORT: 'weekly-report',
  GENERATE_CONTENT: 'generate-content',
  BACKLINK_REFRESH: 'backlink-refresh',
  REVERIFY_SITE: 'reverify-site',
} as const;

/** Per-queue job timeouts (C-03). BullMQ v5 has no native job timeout, so
 * the worker wraps every processor in a timeout race (see worker.ts):
 * an overrunning job fails fast (retry/DLQ) instead of wedging a slot. */
export const QUEUE_TIMEOUTS_MS: Record<string, number> = {
  [QUEUES.crawl]: 15 * 60_000,
  [QUEUES.rankCheck]: 10 * 60_000,
  [QUEUES.keywordRefresh]: 10 * 60_000,
  [QUEUES.geoCheck]: 10 * 60_000,
  [QUEUES.report]: 15 * 60_000,
  [QUEUES.content]: 20 * 60_000,
};

/**
 * Jittered exponential backoff (C-03): 5s, 10s, 20s … capped at 5 min, with
 * ±50% jitter so a provider outage doesn't retry-thundering-herd on
 * recovery. Wired into every Worker via `settings: { backoffStrategy }`
 * (BullMQ only honors custom strategies on the Worker, not the Queue).
 */
export function jitteredBackoffStrategy(attemptsMade: number): number {
  const exp = Math.min(300_000, 5000 * 2 ** (attemptsMade - 1));
  return Math.floor(exp * (0.5 + Math.random()));
}

const queues = new Map<string, Queue>();

export function getQueue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: getConnection().duplicate(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'custom' },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    });
    queues.set(name, q);
  }
  return q;
}

export interface EnqueueOpts extends JobsOptions {
  idempotencyKey?: string;
  /**
   * Per-tenant enqueue rate limiting (N-A1-3). User-initiated enqueues are
   * limited (10/min per tenant per queue); system callers (the scheduler)
   * pass false because bulk ticks legitimately burst.
   */
  rateLimit?: boolean;
}

/**
 * Enqueue with retry/backoff defaults + optional idempotency key.
 * C-03/N-A1-3: the per-tenant token bucket is enforced here (not dead code
 * anymore) — over-limit callers get a 429 instead of silently queueing.
 */
export async function enqueue(
  queueName: string,
  jobName: string,
  data: Record<string, unknown>,
  opts: EnqueueOpts = {},
) {
  const { idempotencyKey, rateLimit = true, ...jobOpts } = opts;
  const tenantId = typeof data.tenantId === 'string' ? data.tenantId : undefined;
  if (rateLimit && tenantId) {
    const allowed = await checkTenantRateLimit(tenantId, queueName);
    if (!allowed) {
      throw new ApiError(
        429,
        'TENANT_QUEUE_RATE_LIMITED',
        `Too many ${jobName} jobs for this workspace — please wait a minute and try again.`,
        { retryAfterSec: 60 },
      );
    }
  }
  return getQueue(queueName).add(jobName, data, {
    jobId: idempotencyKey,
    ...jobOpts,
  });
}

// ---- Per-tenant rate limiting (token bucket in Redis, 10/min default) ----
const RL_MAX = 10;
const RL_WINDOW = 60;

export async function checkTenantRateLimit(tenantId: string, queue: string, max = RL_MAX): Promise<boolean> {
  // A2-M5: namespaced key + atomic INCR-with-TTL (Lua) — a crash between
  // INCR and EXPIRE used to leave a TTL-less key that 429'd the tenant
  // forever.
  const key = `${redisKeyPrefix()}rl:${tenantId}:${queue}`;
  let count: number;
  try {
    count = await withCommandTimeout(
      incrWithTtl(limiterRedis(), key, RL_WINDOW),
      LIMITER_REDIS_TIMEOUT_MS,
      'rate-limit increment',
    );
  } catch {
    // D2-M-1: FAIL-CLOSED on limiter outage. Justification: (1) the limiter
    // guards paid work (crawls, rank checks, content → real provider spend);
    // an unobservable window must not be treated as an empty one, or one
    // outage lets tenants burst past their quota. (2) Availability is not
    // actually improved by fail-open: without Redis the subsequent
    // BullMQ Queue.add on the blocking connection fails anyway — fail-open
    // would only move the hang, not remove it. (3) The 429 carries
    // retryAfterSec so clients back off and retry.
    throw new ApiError(
      429,
      'TENANT_QUEUE_RATE_LIMITED',
      'Rate limiter temporarily unavailable — please retry shortly.',
      { retryAfterSec: 60 },
    );
  }
  return count <= max;
}

/**
 * B1-M3: honest idempotent enqueue for manual refresh routes
 * (ranks/refresh, backlinks/refresh, reports/generate).
 *
 * BullMQ dedupes silently on jobId — `Queue.add` with a duplicate id
 * returns the pre-existing job (even completed ones, kept by
 * removeOnComplete), so a repeat click used to get a fake
 * `{ok:true, queued:true}` while nothing was queued (same silent-dedupe
 * class as the A1-H1 audit-race bug).
 *
 * This helper claims the idempotency window atomically in Redis (SET NX):
 * exactly one caller per window enqueues; every repeat click gets
 * `{ deduplicated: true }` and the route reports
 * `{ok:true, queued:false, deduplicated:true}` honestly. If the enqueue
 * itself throws (e.g. the per-tenant 429), the claim is released so the
 * next click can retry — a failed enqueue must not burn the window.
 */
export async function enqueueDeduped(
  queueName: string,
  jobName: string,
  data: Record<string, unknown>,
  idempotencyKey: string,
  ttlSec = 86400,
): Promise<{ deduplicated: boolean }> {
  const mapKey = `${redisKeyPrefix()}dedup:${idempotencyKey}`;
  // D2-M-1: the dedupe claim runs on the bounded limiter client — on the
  // BullMQ connection (maxRetriesPerRequest: null) it would retry forever
  // during a Redis outage. A failed claim fails fast instead of hanging.
  // J2-LOW-3 (pass#10): claim with a SHORT TTL first. If the process
  // crashes between the claim and Queue.add, the phantom claim self-heals
  // in 60s instead of the full window (up to 7 days for reports/generate).
  // On successful enqueue the claim is extended to the full window.
  const claimed = await withCommandTimeout(
    limiterRedis().set(mapKey, '1', 'EX', 60, 'NX'),
    LIMITER_REDIS_TIMEOUT_MS,
    'dedupe claim',
  );
  if (!claimed) return { deduplicated: true };
  try {
    // BullMQ custom jobIds may contain ':' only in the legacy 3-part
    // repeatable shape — sanitize so any idempotency key works here; the
    // Redis claim above (not the jobId) is the dedupe arbiter.
    const jobId = `${idempotencyKey.replaceAll(':', '-')}-${randomUUID()}`;
    await enqueue(queueName, jobName, data, { idempotencyKey: jobId });
    // The job exists — extend the claim to the full dedupe window.
    await limiterRedis().expire(mapKey, ttlSec).catch(() => {});
  } catch (err) {
    // Release the claim on the bounded client (best effort) so the next
    // click can retry — a failed enqueue must not burn the window.
    await limiterRedis().del(mapKey).catch(() => {});
    throw err;
  }
  return { deduplicated: false };
}

// ---- Dead-letter queue (C-03) ----

export interface DeadLetter {
  queue: string;
  jobName: string;
  tenantId?: string;
  payload: Record<string, unknown>;
  attempts: number;
  error: string;
}

/**
 * Records a job that exhausted all attempts. Called from the worker's
 * 'failed' handler; replayable from the admin back-office (F-14).
 */
export async function captureDeadLetter(dl: DeadLetter): Promise<void> {
  await query(
    `INSERT INTO dead_letter_jobs (id, queue, job_name, tenant_id, payload, attempts, error, status)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'pending')`,
    [dl.queue, dl.jobName, dl.tenantId ?? null, JSON.stringify(dl.payload), dl.attempts, dl.error],
  );
}

/** Test/ops escape hatch: drop cached Queue objects (e.g. between suites). */
export function resetQueuesForTests(): void {
  for (const q of queues.values()) {
    void q.close().catch(() => {});
  }
  queues.clear();
}
