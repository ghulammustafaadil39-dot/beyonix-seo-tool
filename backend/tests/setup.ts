// Vitest setup: per-worktree test database (LA directive — do NOT use shared bseo_test).
// Runs before test files, so src/config.ts and src/db.ts pick these up at import.
// (Local dev credentials only — same values as .env.example / docker-compose.yml.)
process.env.DATABASE_URL ??= 'postgres://bseo:bseo@localhost:5432/bseo_test_security';
process.env.REDIS_URL ??= 'redis://localhost:6379';
// S-07: unit tests exercise the real AES path (not the dev-only plain:
// fallback). Same throwaway test key as tests/integration/setup.ts.
process.env.ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
// LA (S-03 test-isolation fix): S-03/S-04 Redis keys (rate limits, login
// lockout, OAuth state) previously used the fixed 'bseo:' prefix, so stale
// keys from earlier runs (lockouts live up to an hour) flaked later suites.
// Namespace this run's keys and flush the namespace for a clean slate.
process.env.BSEO_REDIS_PREFIX ??= `bseo:unit:${process.pid}:`;
{
  const { Redis } = await import('ioredis');
  const redis = new Redis(process.env.REDIS_URL as string, {
    maxRetriesPerRequest: 3,
    connectTimeout: 5000,
  });
  try {
    const prefix = process.env.BSEO_REDIS_PREFIX as string;
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
  } finally {
    redis.disconnect();
  }
}
