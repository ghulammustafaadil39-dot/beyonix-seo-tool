import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[db] pool error', err);
});

// Narrow query type used across services so tests can inject a fake.
export type QueryFn = (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

export const query: QueryFn = (text, params) => pool.query(text, params as any[]);

/**
 * Advisory-lock key serializing concurrent migration runs. api, worker and
 * the one-shot `migrate` compose service all call runMigrations() at boot;
 * the lock (P0-02) turns the old crash/half-apply race into serialization.
 * (Arbitrary 32-bit key, namespaced to this app's migrations.)
 */
const MIGRATION_ADVISORY_LOCK = 82011;

async function ensureMigrationsTable(q: QueryFn): Promise<void> {
  await q(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
}

/**
 * Applies pending migration files. Each file runs inside its own
 * transaction: a failure rolls back that file completely and it is NOT
 * recorded in `migrations`, so a retry starts clean (P0-02).
 */
async function applyMigrations(q: QueryFn, dir: string, files: string[], applied: Set<string>): Promise<void> {
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    console.log(`[db] applying migration ${f}`);
    await q('BEGIN');
    try {
      await q(sql);
      await q('INSERT INTO migrations(name) VALUES ($1)', [f]);
      await q('COMMIT');
    } catch (err) {
      try {
        await q('ROLLBACK');
      } catch {
        /* ignore rollback errors */
      }
      throw err;
    }
  }
}

function migrationsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
}

async function pendingFiles(): Promise<{ dir: string; files: string[] } | null> {
  const dir = migrationsDir();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    console.warn('[db] no migrations directory found, skipping');
    return null;
  }
  return { dir, files };
}

export async function runMigrations(q: QueryFn = query): Promise<void> {
  const pending = await pendingFiles();
  if (!pending) return;
  const { dir, files } = pending;

  if (q === query) {
    // Real pool path: a single client holds a SESSION-level advisory lock for
    // the whole run, so concurrent boots serialize. The lock MUST be released
    // explicitly before client.release(): pool.release() keeps the session
    // alive, so the lock would otherwise stay held by the idle pooled
    // session and deadlock every later migrator.
    const client = await pool.connect();
    const cq = ((text: string, params?: unknown[]) =>
      client.query(text, params as any[])) as unknown as QueryFn;
    try {
      await cq('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK]);
      try {
        await ensureMigrationsTable(cq);
        const applied = new Set((await cq('SELECT name FROM migrations')).rows.map((r: any) => r.name));
        await applyMigrations(cq, dir, files, applied);
      } finally {
        try {
          await cq('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK]);
        } catch {
          /* best-effort: the session going away releases it anyway */
        }
      }
    } finally {
      client.release();
    }
    return;
  }

  // Injected QueryFn (tests): no cross-process lock is possible, but each
  // migration still runs transactionally.
  await ensureMigrationsTable(q);
  const applied = new Set((await q('SELECT name FROM migrations')).rows.map((r: any) => r.name));
  await applyMigrations(q, dir, files, applied);
}
