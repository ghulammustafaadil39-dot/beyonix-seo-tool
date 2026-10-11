// Vitest setup: DATABASE_URL is read from the environment when set (per
// worktree / per session), falling back to the shared test database.
// (Local dev credentials only — same values as .env.example / docker-compose.yml.)
process.env.DATABASE_URL ??= 'postgres://bseo:bseo@localhost:5432/bseo_test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
// S-07: unit tests exercise the real AES path (not the dev-only plain:
// fallback). Same throwaway test key as tests/integration/setup.ts.
process.env.ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
// LA (S-03 test-isolation fix): S-03/S-04 Redis keys (rate limits, login
// lockout, OAuth state) previously used the fixed 'bseo:' prefix, so stale
// keys from earlier runs (lockouts live up to an hour) flaked later suites.
// Namespace this run's keys and flush the namespace for a clean slate.
// LA (Wave-2 gate flake fix): per-FILE namespace. The unit project runs
// singleFork — every file shares ONE process, so a per-pid prefix still
// gave the whole suite ONE per-IP rate-limit bucket (300/min) → random
// 429 flakes once the suite grew past ~500 tests (bb-f03 bulk-import was
// the visible victim; standalone runs always passed). setup.ts executes
// once per test file, so minting a fresh prefix per execution isolates
// each file's bucket. Set BSEO_REDIS_PREFIX_LOCKED=1 + BSEO_REDIS_PREFIX
// to pin a namespace for manual debugging.
if (process.env.BSEO_REDIS_PREFIX_LOCKED !== '1') {
  process.env.BSEO_REDIS_PREFIX = `bseo:unit:${process.pid}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}:`;
}
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
