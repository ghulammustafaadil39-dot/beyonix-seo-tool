/**
 * DB helpers for integration tests.
 *
 * - ensureMigrated(): run pending migrations against bseo_test (idempotent).
 * - resetDb(): TRUNCATE every public table except `migrations` (CASCADE,
 *   RESTART IDENTITY) so each test file — and ideally each test via
 *   beforeEach — starts from an empty, hermetic database. Table list is read
 *   from pg_tables at runtime so it stays correct as migrations are added.
 */
import { query, pool, runMigrations } from '../../../src/db.js';

export { query };

export async function ensureMigrated(): Promise<void> {
  await runMigrations();
}

export async function resetDb(): Promise<void> {
  const r = await query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('migrations')`,
  );
  const tables = r.rows
    .map((row: any) => `"${String(row.tablename).replace(/"/g, '""')}"`)
    .join(', ');
  if (tables.length > 0) {
    await query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
  }
}

/** Close the pool at the very end of a worker's run (do NOT call per-file). */
export async function closeDb(): Promise<void> {
  await pool.end();
}

let emailSeq = 0;

/** Unique, deliverable-looking email for signup tests (never collides). */
export function uniqueEmail(prefix = 'qa'): string {
  emailSeq += 1;
  return `${prefix}+${Date.now()}-${process.pid}-${emailSeq}@beyo.test`;
}
