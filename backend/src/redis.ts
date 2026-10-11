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
