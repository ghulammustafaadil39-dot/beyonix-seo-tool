import { Worker, type Job } from 'bullmq';
import { captureDeadLetter, getConnection, jitteredBackoffStrategy, QUEUES, QUEUE_TIMEOUTS_MS, Jobs } from './queues.js';
import { pool, runMigrations } from './db.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { closeRedis } from './redis.js';
import { installGracefulShutdown } from './shutdown.js';
import { crawlProcessor } from './services/crawlJobs.js';
import { backlinkProcessor } from './services/backlinkJobs.js';
import { rankCheckProcessor } from './services/rankJobs.js';
import { keywordRefreshProcessor } from './services/keywordJobs.js';
import { geoCheckProcessor } from './services/geoJobs.js';
import { reportProcessor } from './services/reportJobs.js';
import { contentProcessor } from './services/contentJobs.js';
import { reverifyProcessor } from './services/verifyJobs.js';

/** The crawl queue carries crawl + light-check + backlink-refresh + reverify jobs; dispatch by name. */
async function crawlQueueProcessor(job: Job) {
  switch (job.name) {
    case Jobs.CRAWL_SITE:
    case Jobs.LIGHT_CHECK:
      return crawlProcessor(job);
    case Jobs.BACKLINK_REFRESH:
      return backlinkProcessor(job);
    case Jobs.REVERIFY_SITE:
      return reverifyProcessor(job);
    default:
      throw new Error(`unknown job on crawl queue: ${job.name}`);
  }
}

/**
 * Decides whether a failed job goes to the dead-letter table (C-03):
 * only when it will NOT be retried (attempts exhausted). Retried failures
 * stay in BullMQ; only the terminal failure is captured.
 */
export function shouldDeadLetter(job: Job): boolean {
  const maxAttempts = job.opts.attempts ?? 1;
  return job.attemptsMade >= maxAttempts;
}

/**
 * C-03 job timeout: races the processor against the queue's timeout budget.
 * On timeout the job fails (→ retry or dead-letter) instead of wedging a
 * worker slot forever. The overrunning processor keeps running in the
 * background, but all processors are idempotent by contract, so a late
 * write is harmless.
 */
export function withJobTimeout<T>(job: Job, queueName: string, fn: (job: Job) => Promise<T>): Promise<T> {
  const ms = QUEUE_TIMEOUTS_MS[queueName] ?? 10 * 60_000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`job ${job.id ?? job.name} timed out after ${ms}ms on queue ${queueName}`));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([fn(job), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function workerFor(queueName: string, processor: (job: Job) => Promise<unknown>, concurrency: number): Worker {
  return new Worker(
    queueName,
    (job) => withJobTimeout(job, queueName, processor),
    {
      connection: getConnection().duplicate(),
      concurrency,
      // C-03: stalled-job handling — a crashed processor's job is retried,
      // not silently lost; after maxStalledCount it fails terminally.
      stalledInterval: 30_000,
      maxStalledCount: 3,
      settings: { backoffStrategy: jitteredBackoffStrategy },
    },
  );
}

async function main() {
  await runMigrations();
  const workers: Worker[] = [
    workerFor(QUEUES.crawl, crawlQueueProcessor, 2),
    workerFor(QUEUES.rankCheck, rankCheckProcessor, 4),
    workerFor(QUEUES.keywordRefresh, keywordRefreshProcessor, 2),
    workerFor(QUEUES.geoCheck, geoCheckProcessor, 2),
    workerFor(QUEUES.report, reportProcessor, 2),
    workerFor(QUEUES.content, contentProcessor, 2),
  ];

  for (const w of workers) {
    w.on('failed', (job, err) => {
      console.error(`[worker] job ${job?.id} failed:`, err.message);
      // C-03: terminal failures go to the dead-letter table (replayable
      // from the admin back-office); retried failures stay in BullMQ.
      if (job && shouldDeadLetter(job)) {
        const data = (job.data ?? {}) as Record<string, unknown>;
        void captureDeadLetter({
          queue: w.name,
          jobName: job.name,
          tenantId: typeof data.tenantId === 'string' ? data.tenantId : undefined,
          payload: data,
          attempts: job.attemptsMade,
          error: err.message?.slice(0, 2000) ?? String(err),
        }).catch((e) => console.error('[worker] dead-letter capture failed', e));
      }
    });
    w.on('completed', (job) => console.log(`[worker] job ${job?.id} done`));
  }

  const schedules = startScheduler();
  console.log('[worker] all processors started');

  // C-03 / N-A2-1: graceful shutdown — SIGTERM/SIGINT drain in-flight jobs
  // (worker.close() waits for active processors) instead of killing them.
  installGracefulShutdown([
    {
      name: 'scheduler',
      run: async () => {
        stopScheduler(schedules);
      },
    },
    {
      name: 'workers',
      run: async () => {
        await Promise.all(workers.map((w) => w.close()));
      },
    },
    {
      name: 'redis+db',
      run: async () => {
        getConnection().disconnect();
        await closeRedis();
        await pool.end();
      },
    },
  ]);
}

if (process.argv[1]?.endsWith('worker.js')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}