// W-01 load proof (honest simulation).
// Enqueues rank-check jobs for T tenants x K keywords against REAL
// Postgres + Redis and processes them with REAL BullMQ workers running
// the production rankCheckProcessor (mock provider in this env, labeled).
// 10k real sites is not feasible here; this runs at the largest scale the
// VM sustains cleanly and reports measured throughput + per-tenant
// fairness. Usage: DATABASE_URL=... npx tsx scripts/load-proof.ts [tenants] [keywordsPerTenant]
import { Worker, type Job } from 'bullmq';
import { pool, query, runMigrations } from '../src/db.js';
import { enqueue, getConnection, getQueue, QUEUES, Jobs } from '../src/queues.js';
import { rankCheckProcessor } from '../src/services/rankJobs.js';
import { acquireHeavySlot, releaseHeavySlot } from '../src/services/fairness.js';
import { hashPassword } from '../src/middleware/auth.js';
import { closeRedis } from '../src/redis.js';

const TENANTS = Number(process.argv[2] ?? 10);
const KW = Number(process.argv[3] ?? 5);

async function main() {
  await runMigrations();
  await query(`TRUNCATE tenants CASCADE`);
  const tenants: Array<{ tenantId: string; siteId: string }> = [];
  const pw = await hashPassword('J7#kP9!mV2@qX5$zR8&');
  for (let i = 0; i < TENANTS; i++) {
    const t = await query(`INSERT INTO tenants (id,name,plan_id) VALUES (gen_random_uuid(),$1,'pro') RETURNING id`, [`LoadT${i}`]);
    const tid = t.rows[0].id as string;
    await query(`INSERT INTO users (id,tenant_id,email,password_hash,name,role,email_verified_at) VALUES (gen_random_uuid(),$1,$2,$3,'L','owner',now())`,
      [tid, `load${Date.now()}-${i}@example.com`, pw]);
    const s = await query(`INSERT INTO sites (id,tenant_id,domain,verified) VALUES (gen_random_uuid(),$1,$2,TRUE) RETURNING id`, [tid, `load${i}.example.com`]);
    const sid = s.rows[0].id as string;
    for (let k = 0; k < KW; k++) {
      await query(`INSERT INTO keywords (id,tenant_id,site_id,keyword,tracked) VALUES (gen_random_uuid(),$1,$2,$3,TRUE)`, [tid, sid, `load kw ${i}-${k}`]);
    }
    tenants.push({ tenantId: tid, siteId: sid });
  }
  // Warm keyword metrics cache so the run measures DB/Redis/worker, not provider.
  const { getKeywordMetrics } = await import('../src/services/keywordCache.js');
  for (const t of tenants) {
    const kws = Array.from({ length: KW }, (_, k) => `load kw ${tenants.indexOf(t)}-${k}`);
    await getKeywordMetrics(t.tenantId, kws);
  }

  const perTenantCompleted: Record<string, number> = {};
  const perTenantFailed: Record<string, number> = {};
  const workers: Worker[] = [];
  const worker = new Worker(
    QUEUES.rankCheck,
    async (job: Job) => {
      const res: any = await rankCheckProcessor(job);
      const tid = (job.data as any).tenantId as string;
      perTenantCompleted[tid] = (perTenantCompleted[tid] ?? 0) + 1;
      return res;
    },
    { connection: getConnection().duplicate(), concurrency: 8 },
  );
  worker.on('failed', (job, err) => {
    const tid = (job?.data as any)?.tenantId as string;
    perTenantFailed[tid] = (perTenantFailed[tid] ?? 0) + 1;
    console.error('[load] job failed', err.message);
  });
  workers.push(worker);
  await worker.waitUntilReady();

  // Fairness evidence: tenant 0 grabs both heavy slots; a third acquire must fail.
  const s1 = await acquireHeavySlot(tenants[0].tenantId);
  const s2 = await acquireHeavySlot(tenants[0].tenantId);
  const s3 = await acquireHeavySlot(tenants[0].tenantId);
  const fairness = { slot1: !!s1, slot2: !!s2, slot3Denied: s3 === null };
  if (s1) await releaseHeavySlot(tenants[0].tenantId, s1);
  if (s2) await releaseHeavySlot(tenants[0].tenantId, s2);

  const start = Date.now();
  for (const t of tenants) {
    await enqueue(QUEUES.rankCheck, Jobs.RANK_CHECK, { siteId: t.siteId, tenantId: t.tenantId }, { rateLimit: false });
  }
  const total = TENANTS;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const done = Object.values(perTenantCompleted).reduce((a, b) => a + b, 0);
    const failed = Object.values(perTenantFailed).reduce((a, b) => a + b, 0);
    if (done + failed >= total) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const elapsedSec = (Date.now() - start) / 1000;
  const done = Object.values(perTenantCompleted).reduce((a, b) => a + b, 0);
  const failed = Object.values(perTenantFailed).reduce((a, b) => a + b, 0);
  const counts = tenants.map((t) => perTenantCompleted[t.tenantId] ?? 0);
  const max = Math.max(...counts); const min = Math.min(...counts);
  const rc = await query(`SELECT COUNT(*)::int c FROM rank_checks`);
  const queue = getQueue(QUEUES.rankCheck);
  const jobCounts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');

  console.log(JSON.stringify({
    simulated: { tenants: TENANTS, keywordsPerTenant: KW, enqueuedJobs: total, provider: 'mock (labeled)' },
    throughput: { jobsCompleted: done, jobsFailed: failed, elapsedSec: Number(elapsedSec.toFixed(2)), jobsPerSec: Number((done / Math.max(elapsedSec, 0.01)).toFixed(2)) },
    fairness: { ...fairness, perTenantCompletions: counts, maxShare: max, minShare: min, maxDivergence: max - min },
    db: { rankChecksRows: Number(rc.rows[0].c) },
    bullmq: jobCounts,
  }, null, 2));

  await Promise.all(workers.map((w) => w.close()));
  getConnection().disconnect();
  await closeRedis();
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
