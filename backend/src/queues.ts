import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { ApiError } from './errors.js';
import { query } from './db.js';

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
  const key = `rl:${tenantId}:${queue}`;
  const redis = getConnection();
  // simple fixed-window counter
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RL_WINDOW);
  return count <= max;
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
