/**
 * Redis helpers for integration tests.
 *
 * Tests use REDIS_URL=redis://localhost:6379/1 (DB 1) so FLUSHDB never touches
 * the dev database (DB 0). Call resetRedis() in beforeEach for hermeticity.
 */
import { Redis } from 'ioredis';
import { config } from '../../../src/config.js';

let client: Redis | null = null;

export function getTestRedis(): Redis {
  if (!client) {
    client = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
  }
  return client;
}

export async function resetRedis(): Promise<void> {
  await getTestRedis().flushdb();
}

/** Disconnect at the very end of a worker's run (do NOT call per-file). */
export async function closeRedis(): Promise<void> {
  if (client) {
    client.disconnect();
    client = null;
  }
}
