// One-shot migration runner (P0-02). The compose `migrate` service runs
// `node dist/migrate.js` and api/worker wait for it to complete
// successfully, so schema changes land exactly once before anything boots.
// Exit 0 when the schema is up to date, non-zero on failure.
import { pool, runMigrations } from './db.js';

async function main() {
  await runMigrations();
  console.log('[migrate] schema up to date');
  await pool.end();
}

main().catch((e) => {
  console.error('[migrate] failed:', e);
  process.exit(1);
});
