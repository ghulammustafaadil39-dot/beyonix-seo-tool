import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool, query, runMigrations } from '../src/db.js';

const exec = promisify(execFile);

/**
 * C-06: backup/restore round-trip test.
 *
 * Exercises the REAL scripts (scripts/backup.sh + scripts/restore.sh):
 * a table-scoped plain-SQL backup of a probe table, drop, restore, verify
 * rows are back — plus a full custom-format backup whose archive integrity
 * is verified with pg_restore --list.
 *
 * The bseo role has no CREATEDB privilege, so a full restore goes into a
 * scratch database only where one is available; the table-scoped round-trip
 * is the portable proof that backup output feeds restore input.
 *
 * Needs DATABASE_URL at a test database (bseo_test_ba) + pg_dump/psql on PATH.
 */
const HAS_TEST_DB = /test/i.test(process.env.DATABASE_URL ?? '');
const SCRIPTS = new URL('../scripts/', import.meta.url).pathname;

describe.runIf(HAS_TEST_DB)('C-06 backup & restore', () => {
  let dir: string;

  beforeAll(async () => {
    await runMigrations();
    dir = mkdtempSync(join(tmpdir(), 'bseo-backup-test-'));
  }, 60000);

  afterAll(async () => {
    await query(`DROP TABLE IF EXISTS restore_probe`).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    await pool.end();
  });

  it('table-scoped backup -> drop -> restore returns the rows', async () => {
    await query(`DROP TABLE IF EXISTS restore_probe`);
    await query(`CREATE TABLE restore_probe (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), v text NOT NULL)`);
    await query(`INSERT INTO restore_probe (v) VALUES ('a'), ('b'), ('c')`);

    const dumpFile = join(dir, 'probe.sql');
    await exec(join(SCRIPTS, 'backup.sh'), [dumpFile, '-t', 'restore_probe', '--format=plain'], {
      env: { ...process.env },
    });

    await query(`DROP TABLE restore_probe`);
    await exec(join(SCRIPTS, 'restore.sh'), [dumpFile], { env: { ...process.env } });

    const r = await query(`SELECT v FROM restore_probe ORDER BY v`);
    expect(r.rows.map((row: any) => row.v)).toEqual(['a', 'b', 'c']);
  });

  it('full custom-format backup lists cleanly and contains core tables', async () => {
    const dumpFile = join(dir, 'full.dump');
    await exec(join(SCRIPTS, 'backup.sh'), [dumpFile], { env: { ...process.env } });
    const { stdout } = await exec('pg_restore', ['--list', dumpFile]);
    for (const t of ['tenants', 'users', 'usage_events', 'api_keys', 'webhook_endpoints']) {
      expect(stdout).toContain(`TABLE public ${t} `);
    }
  });

  it('restore.sh refuses to run without DATABASE_URL', async () => {
    const dumpFile = join(dir, 'probe2.sql');
    await query(`DROP TABLE IF EXISTS restore_probe`);
    await query(`CREATE TABLE restore_probe (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), v text NOT NULL)`);
    await exec(join(SCRIPTS, 'backup.sh'), [dumpFile, '-t', 'restore_probe', '--format=plain'], {
      env: { ...process.env },
    });
    const env = { ...process.env };
    delete env.DATABASE_URL;
    await expect(exec(join(SCRIPTS, 'restore.sh'), [dumpFile], { env })).rejects.toThrow();
  });
});
