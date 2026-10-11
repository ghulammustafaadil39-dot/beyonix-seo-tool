// Shared helpers for DB-backed integration tests (S-01 and later).
// Uses the per-worktree database bseo_test_security (see tests/setup.ts).
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { query, runMigrations } from '../src/db.js';
import { hashPassword } from '../src/middleware/auth.js';
import { config } from '../src/config.js';

let migrated = false;

/** Applies pending migrations to the test DB (idempotent; runs once per file). */
export async function ensureTestDb(): Promise<void> {
  if (migrated) return;
  await runMigrations();
  migrated = true;
}

/** Removes all rows from data tables (keeps the migrations ledger). */
export async function truncateAll(): Promise<void> {
  const r = await query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations'`,
  );
  const tables = r.rows.map((x: any) => `"${x.tablename}"`).join(', ');
  if (tables) await query(`TRUNCATE ${tables} CASCADE`);
}

/** Wipes BullMQ job data from the test Redis so enqueue tests stay hermetic. */
export async function flushTestQueues(): Promise<void> {
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3, connectTimeout: 5000 });
  try {
    await redis.ping();
    const keys = await redis.keys('bull:*');
    if (keys.length > 0) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}

export async function createTestUser(
  email: string,
  opts: { password?: string; verified?: boolean; name?: string } = {},
): Promise<{ userId: string; tenantId: string }> {
  const t = await query(
    `INSERT INTO tenants (id, name, plan_id) VALUES (gen_random_uuid(), 'Test Tenant', 'starter') RETURNING id`,
  );
  const tenantId = t.rows[0].id as string;
  const pwHash = await hashPassword(opts.password ?? 'Password123!');
  const u = await query(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, role, email_verified_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 'owner', ${opts.verified ? 'now()' : 'NULL'})
     RETURNING id`,
    [tenantId, email.toLowerCase(), pwHash, opts.name ?? 'Test User'],
  );
  return { userId: u.rows[0].id as string, tenantId };
}

export async function loginAs(
  app: FastifyInstance,
  email: string,
  password = 'Password123!',
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  return (res.json() as any).token as string;
}

export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export async function createTestSite(
  app: FastifyInstance,
  token: string,
  domain = 'example.com',
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/sites',
    headers: authHeaders(token),
    payload: { domain },
  });
  if (res.statusCode !== 201) throw new Error(`create site failed: ${res.statusCode} ${res.body}`);
  return (res.json() as any).id as string;
}
