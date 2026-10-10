import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { buildApp } from '../src/index.js';
import { pool, query, runMigrations, type QueryFn } from '../src/db.js';

/**
 * P0-02: migration race + no transactions. api and worker both ran
 * runMigrations() at boot with no lock and no transaction; a failure left a
 * half-applied migration. Fix: Postgres advisory lock on the real path, each
 * migration file in its own transaction, a one-shot `migrate` compose
 * service, and /healthz split into liveness vs readiness.
 *
 * DB-backed parts need DATABASE_URL pointing at a test database (e.g.
 * bseo_test_backend). They skip otherwise — never touches a non-test
 * database by accident.
 */
const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');
if (!HAS_TEST_DB) console.warn('[p0-02] skipping DB-backed tests: DATABASE_URL does not point at a test database');

describe.runIf(HAS_TEST_DB)('P0-02 migration safety', () => {
  it('runs each migration in a transaction: failure rolls back, nothing recorded', async () => {
    const seen: string[] = [];
    const boom = new Error('synthetic migration failure');
    const fake: QueryFn = async (text) => {
      const t = text.trim().toUpperCase().slice(0, 40);
      seen.push(t);
      if (t.startsWith('SELECT NAME FROM MIGRATIONS')) return { rows: [], rowCount: 0 };
      if (t.startsWith('CREATE TABLE IF NOT EXISTS MIGRATIONS')) return { rows: [], rowCount: 0 };
      if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (t.startsWith('INSERT INTO MIGRATIONS')) return { rows: [], rowCount: 1 };
      throw boom; // the migration file body itself
    };
    await expect(runMigrations(fake)).rejects.toBe(boom);
    const beginIdx = seen.indexOf('BEGIN');
    const rollbackIdx = seen.indexOf('ROLLBACK');
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(rollbackIdx).toBeGreaterThan(beginIdx);
    // The failed file must NOT be recorded as applied, and no COMMIT happened.
    expect(seen.filter((s) => s.startsWith('INSERT INTO MIGRATIONS'))).toHaveLength(0);
    expect(seen).not.toContain('COMMIT');
  });

  it('concurrent runMigrations() calls serialize via advisory lock (real DB)', async () => {
    await Promise.all([runMigrations(), runMigrations(), runMigrations()]);
    const { readdir } = await import('node:fs/promises');
    const onDisk = (await readdir(new URL('../migrations', import.meta.url))).filter((f: string) =>
      f.endsWith('.sql'),
    );
    const r = await query('SELECT COUNT(*)::int AS n FROM migrations');
    expect(r.rows[0].n).toBe(onDisk.length);
  }, 60000);
});

describe('P0-02 liveness vs readiness', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  it('/healthz stays a dependency-free liveness probe', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  // Needs live Postgres + Redis.
  it.runIf(HAS_TEST_DB)('/readyz reports DB + Redis health', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.db).toBe(true);
    expect(body.redis).toBe(true);
  });

  it('compose wires a one-shot migrate service with healthchecks', async () => {
    const compose = await readFile(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
    // one-shot migrate service exists and runs the migrate entrypoint
    expect(compose).toMatch(/^\s{2}migrate:/m);
    expect(compose).toContain('dist/migrate.js');
    // api/worker wait for migrations to complete successfully
    expect(compose).toMatch(/migrate:\s*\n\s*condition:\s*service_completed_successfully/);
    // real healthchecks on the long-running services
    expect(compose).toContain('/healthz');
    const healthchecks = compose.match(/healthcheck:/g) ?? [];
    expect(healthchecks.length).toBeGreaterThanOrEqual(4); // postgres, redis, api, worker
  });
});
