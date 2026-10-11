import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { getRedis, redisKeyPrefix } from '../redis.js';

/**
 * Redis scheduler leader election (C-03 / N-A2-2).
 *
 * Every worker process runs the scheduler, but exactly one may tick: each
 * tick tries SET key token PX ttl NX. The atomic SET NX guarantees a single
 * winner per tick even when N workers fire the same cron second. The token
 * lets a process recognize (and extend) its own leadership; a crashed
 * leader's key expires via the TTL so another worker takes over.
 */
export interface LeaderElection {
  /** Attempts to become (or stay) leader. Resolves true for exactly one caller per tick. */
  tryAcquire(): Promise<boolean>;
  /**
   * A2-M4: extends the lock TTL while a long tick is still running.
   * Resolves false when the lock is no longer ours (another process took
   * over) — the caller should stop trusting its leadership.
   */
  heartbeat(): Promise<boolean>;
  release(): Promise<void>;
}

export function createLeaderElection(key: string, ttlMs = 30_000, redis?: Redis): LeaderElection {
  const client = redis ?? getRedis();
  const fullKey = `${redisKeyPrefix()}${key}`;
  let token: string | null = null;

  return {
    async tryAcquire(): Promise<boolean> {
      const mine = token ?? randomUUID();
      const res = await client.set(fullKey, mine, 'PX', ttlMs, 'NX');
      if (res === 'OK') {
        token = mine;
        return true;
      }
      // Re-entry: still ours from a recent tick — extend and continue.
      if (token) {
        const cur = await client.get(fullKey);
        if (cur === token) {
          await client.pexpire(fullKey, ttlMs);
          return true;
        }
        token = null;
      }
      return false;
    },
    async heartbeat(): Promise<boolean> {
      // A2-M4: extend the TTL only if the lock is still ours (Lua
      // compare-and-pexpire) — a tick that runs past the 30s TTL must not
      // silently lose leadership to a second worker mid-tick.
      if (!token) return false;
      const res = await client.eval(
        `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`,
        1,
        fullKey,
        token,
        String(ttlMs),
      );
      if (Number(res) !== 1) token = null;
      return Number(res) === 1;
    },
    async release(): Promise<void> {
      if (!token) return;
      // Release only if still ours (Lua compare-and-del).
      await client.eval(`if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`, 1, fullKey, token);
      token = null;
    },
  };
}
