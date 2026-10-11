import { Worker, type Job } from 'bullmq';
import { getConnection, QUEUES, Jobs } from './queues.js';
import { runMigrations } from './db.js';
import { startScheduler } from './scheduler.js';
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

async function main() {
  await runMigrations();
  const workers: Worker[] = [
    new Worker(QUEUES.crawl, crawlQueueProcessor, { connection: getConnection().duplicate(), concurrency: 2 }),
    new Worker(QUEUES.rankCheck, rankCheckProcessor, { connection: getConnection().duplicate(), concurrency: 4 }),
    new Worker(QUEUES.keywordRefresh, keywordRefreshProcessor, { connection: getConnection().duplicate(), concurrency: 2 }),
    new Worker(QUEUES.geoCheck, geoCheckProcessor, { connection: getConnection().duplicate(), concurrency: 2 }),
    new Worker(QUEUES.report, reportProcessor, { connection: getConnection().duplicate(), concurrency: 2 }),
    new Worker(QUEUES.content, contentProcessor, { connection: getConnection().duplicate(), concurrency: 2 }),
  ];

  for (const w of workers) {
    w.on('failed', (job, err) => console.error(`[worker] job ${job?.id} failed:`, err.message));
    w.on('completed', (job) => console.log(`[worker] job ${job?.id} done`));
  }

  startScheduler();
  console.log('[worker] all processors started');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
