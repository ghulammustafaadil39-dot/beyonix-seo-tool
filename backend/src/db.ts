import { readdir } from 'node:fs/promises';
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

export async function runMigrations(q: QueryFn = query): Promise<void> {
  await q(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`);
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    console.warn('[db] no migrations directory found, skipping');
    return;
  }
  const applied = new Set((await q('SELECT name FROM migrations')).rows.map((r: any) => r.name));
  for (const f of files) {
    if (applied.has(f)) continue;
    const { readFile } = await import('node:fs/promises');
    const sql = await readFile(path.join(dir, f), 'utf8');
    console.log(`[db] applying migration ${f}`);
    await q(sql);
    await q('INSERT INTO migrations(name) VALUES ($1)', [f]);
  }
}
