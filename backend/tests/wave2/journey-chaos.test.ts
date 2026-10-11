/**
 * Wave-2 PHASE GATE — chaos/resilience spot-check (a): DLQ + admin replay.
 *
 * The composition NOT covered by existing tests: c-03 proves
 * captureDeadLetter() stores a row and shouldDeadLetter() fires only at
 * terminal failure; f-14 proves the admin list/replay endpoints against
 * hand-inserted rows. Neither runs a REAL worker against a job that
 * actually throws. This test does:
 *
 *   spawn the real worker process (node dist/worker.js — the production
 *   entry; NOTE: `tsx src/worker.ts` never starts main() because the
 *   entry guard checks argv[1].endsWith('worker.js') — filed as a gate
 *   bug, see the header of the gate report) → enqueue a crawl job
 *   whose site does not exist (processor throws on every attempt) →
 *   after retries are exhausted the worker's 'failed' handler must land
 *   exactly one row in dead_letter_jobs → kill the worker → a platform
 *   admin replays the row via POST /admin/jobs/failed/:id/replay → the
 *   row is marked 'replayed' and a fresh job is back on the crawl queue.
 *
 * Non-admin access to the admin DLQ surface is 404 (no existence leak),
 * asserted before the test user is promoted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../integration/helpers/app.js';
import { query, resetDb, uniqueEmail } from '../integration/helpers/db.js';
import { resetRedis } from '../integration/helpers/redis.js';
import { sessionTokenFromResponse } from '../helpers.js';
import { enqueue, getQueue, QUEUES, Jobs } from '../../src/queues.js';

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let app: FastifyInstance;
let worker: ChildProcess | null = null;
let workerLog = '';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

let token: string;
let tenantId: string;
let userId: string;
let dlqId: string;

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

beforeAll(async () => {
  await resetDb();
  await resetRedis();
  app = await buildTestApp();

  const email = uniqueEmail('gatechaos');
  const password = `Gate!${Date.now()}${Math.floor(Math.random() * 1e9)}xQ9#Zz`;
  const s = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, password, name: 'Gate Chaos' },
  });
  expect(s.statusCode).toBe(201);
  const body = s.json() as any;
  tenantId = body.tenant.id as string;
  userId = body.user.id as string;
  token = sessionTokenFromResponse(s);
  const v = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/email/verify',
    payload: { token: body.verifyToken },
  });
  expect(v.statusCode).toBe(200);
}, 60000);

afterAll(async () => {
  if (worker && !worker.killed) {
    worker.kill('SIGKILL');
  }
  await getQueue(QUEUES.crawl).obliterate({ force: true }).catch(() => undefined);
  await app?.close();
});

describe('Wave-2 gate: chaos — throwing job lands in DLQ and replays via admin', () => {
  it('non-admin cannot see the admin DLQ surface (404, no existence leak)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/jobs/failed', headers: auth(token) });
    expect(res.statusCode).toBe(404);
    // Promote for the replay step below.
    await query(`UPDATE users SET is_platform_admin = TRUE WHERE id = $1`, [userId]);
    const asAdmin = await app.inject({ method: 'GET', url: '/api/v1/admin/jobs/failed', headers: auth(token) });
    expect(asAdmin.statusCode).toBe(200);
  }, 60000);

  it('a crawl job that throws on every attempt lands in dead_letter_jobs via the real worker', async () => {
    // Compile first so the worker runs through its production entry
    // (node dist/worker.js). ~30-60s; dist/ is gitignored.
    execFileSync(path.join(backendDir, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], {
      cwd: backendDir,
      stdio: 'pipe',
      timeout: 180000,
    });
    worker = spawn(process.execPath, ['dist/worker.js'], {
      cwd: backendDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    worker.stdout?.on('data', (d) => (workerLog += d.toString()));
    worker.stderr?.on('data', (d) => (workerLog += d.toString()));

    await waitFor(() => workerLog.includes('all processors started'), 90000, 'worker startup');
    expect(workerLog).toContain('all processors started');

    // A crawl for a site that does not exist: requireSite throws inside
    // crawlProcessor on every attempt (attempts=3, jittered backoff).
    const ghostSiteId = randomUUID();
    await enqueue(QUEUES.crawl, Jobs.CRAWL_SITE, {
      siteId: ghostSiteId,
      tenantId,
      auditId: randomUUID(),
    });

    await waitFor(async () => {
      const r = await query(`SELECT id FROM dead_letter_jobs WHERE tenant_id = $1 AND queue = 'crawl'`, [tenantId]);
      if (r.rows.length > 0) {
        dlqId = r.rows[0].id as string;
        return true;
      }
      return false;
    }, 180000, 'dead-letter row');

    const row = await query(`SELECT * FROM dead_letter_jobs WHERE id = $1`, [dlqId]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].job_name).toBe(Jobs.CRAWL_SITE);
    expect(row.rows[0].status).toBe('pending');
    expect(Number(row.rows[0].attempts)).toBe(3);
    expect(row.rows[0].payload.siteId).toBe(ghostSiteId);
    expect(String(row.rows[0].error)).toMatch(/not found/i);

    // Stop the worker before replay so the replayed job stays queued
    // (with the worker running it would fail again within seconds).
    const proc = worker;
    proc.kill('SIGTERM');
    await waitFor(() => proc.exitCode !== null || proc.signalCode !== null, 30000, 'worker exit').catch(() => {
      proc.kill('SIGKILL');
    });
    worker = null;
  }, 300000);

  it('admin replay re-enqueues the dead-letter job and marks the row replayed', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/jobs/failed?status=pending',
      headers: auth(token),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as any).data.some((d: any) => d.id === dlqId)).toBe(true);

    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/jobs/failed/${dlqId}/replay`,
      headers: auth(token),
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as any).ok).toBe(true);

    const row = await query(`SELECT status, replayed_at FROM dead_letter_jobs WHERE id = $1`, [dlqId]);
    expect(row.rows[0].status).toBe('replayed');
    expect(row.rows[0].replayed_at).not.toBeNull();

    // A fresh job is back on the crawl queue carrying the original payload.
    const queue = getQueue(QUEUES.crawl);
    const counts = await queue.getJobCounts('waiting', 'delayed', 'prioritized', 'paused');
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(1);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized', 'paused']);
    expect(jobs.some((j) => (j.data as any)?.tenantId === tenantId)).toBe(true);

    // Replaying a non-pending row is a 404 (idempotent terminal state).
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/jobs/failed/${dlqId}/replay`,
      headers: auth(token),
    });
    expect(again.statusCode).toBe(404);
  }, 60000);
});
