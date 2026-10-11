/**
 * Wave-2 QA: test-harness contract — DATABASE_URL from env is honored.
 *
 * LA directive (Wave 1 handoff): backend/tests/setup.ts and
 * backend/tests/integration/setup.ts must read DATABASE_URL from the
 * environment, falling back to the shared bseo_test database. This test
 * proves the running process actually connected to the database named in
 * DATABASE_URL — not a hardcoded default — and never to the dev database.
 *
 * Run 1 (env set):  DATABASE_URL=postgres://bseo:bseo@localhost:5432/bseo_test_qa
 *                   → current_database() must be bseo_test_qa.
 * Run 2 (env unset): fallback → current_database() must be bseo_test.
 */
import { describe, expect, it } from 'vitest';
import { query } from '../integration/helpers/db.js';

describe('test harness: DATABASE_URL env is honored', () => {
  it('connects to the database named in process.env.DATABASE_URL', async () => {
    const url = process.env.DATABASE_URL;
    expect(url, 'DATABASE_URL must be set by the test setup file').toBeTruthy();
    const dbName = new URL(url as string).pathname.replace(/^\//, '');
    expect(dbName.length, 'DATABASE_URL must name a database').toBeGreaterThan(0);
    const r = await query('SELECT current_database() AS db');
    expect(r.rows[0].db).toBe(dbName);
  });

  it('points at a test database, never the dev database', async () => {
    const r = await query('SELECT current_database() AS db');
    const db = r.rows[0].db as string;
    expect(db).not.toBe('bseo');
    expect(db).toMatch(/test/);
  });
});
