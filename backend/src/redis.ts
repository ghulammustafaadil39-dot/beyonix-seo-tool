// Shared Redis client singleton. Import this instead of constructing ad-hoc
// Redis connections, so the whole process shares one pool and tests can rely
// on a single connection per REDIS_URL.
import { Redis } from 'ioredis';
import { config } from './config.js';

let client: Redis | null = null;

/** Lazily creates (once) and returns the shared Redis client. */
export function getRedis(): Redis {
  if (!client) {
    client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
    client.on('error', (err) => {
      // Never crash the process on a transient Redis error; readiness and
      // rate-limit paths surface the failure explicitly instead.
      console.error('[redis] error', err);
    });
  }
  return client;
}

/** Test/ops escape hatch: close and drop the singleton (e.g. before exit). */
export async function closeRedis(): Promise<void> {
  if (client) {
    client.disconnect();
    client = null;
  }
}

/**
 * Base prefix for all bseo Redis keys (rate limits, lockouts, OAuth state).
 * Overridable via BSEO_REDIS_PREFIX so tests can namespace (and flush) their
 * own keyspace instead of colliding with other suites or stale prior runs.
 */
export function redisKeyPrefix(): string {
  return process.env.BSEO_REDIS_PREFIX ?? 'bseo:';
}

// A2-M5: atomic fixed-window increment. The naive INCR-then-EXPIRE pair is
// not atomic: a crash (or dropped connection) between the two leaves a key
// with NO TTL whose counter grows forever — permanently 429-ing that tenant
// or API key until manual Redis surgery. This Lua script runs server-side
// so the increment and the expiry are one atomic step.
const INCR_WITH_TTL_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c
`;

/**
 * Atomically increments a fixed-window counter and sets its TTL on first
 * hit (A2-M5). Returns the new count. The caller must include
 * redisKeyPrefix() in the key.
 */
export async function incrWithTtl(client: Redis, key: string, ttlSeconds: number): Promise<number> {
  const res = await client.eval(INCR_WITH_TTL_LUA, 1, key, String(ttlSeconds));
  return Number(res);
}
