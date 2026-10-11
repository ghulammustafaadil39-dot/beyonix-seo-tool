import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from './config.js';

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

const queues = new Map<string, Queue>();

export function getQueue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: getConnection().duplicate(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
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
}

/** Enqueue with retry/backoff defaults + optional idempotency key. */
export async function enqueue(queueName: string, jobName: string, data: Record<string, unknown>, opts: EnqueueOpts = {}) {
  const { idempotencyKey, ...jobOpts } = opts;
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
  const now = Date.now();
  const redis = getConnection();
  // simple fixed-window counter
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, RL_WINDOW);
  void now;
  return count <= max;
}
