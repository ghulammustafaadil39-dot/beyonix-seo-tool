import { randomUUID } from 'node:crypto';
import { getRedis, redisKeyPrefix } from '../redis.js';

// W-01: per-tenant job fairness, building on the C-03 per-tenant enqueue
// rate limit. A Redis semaphore bounds how many HEAVY (crawl/audit) jobs one
// tenant may run concurrently across all worker processes; light jobs are
// untouched. Fairness is BEST-EFFORT: acquiring the slot is atomic (Lua);
// losing the race defers the job with a BullMQ delay rather than failing it.

/** Queue classes (W-01): heavy = audit/crawl work, light = everything else. */
export const QUEUE_CLASS: Record<string, 'heavy' | 'light'> = {
  crawl: 'heavy',
  'rank-check': 'light',
  'keyword-refresh': 'light',
  'geo-check': 'light',
  report: 'light',
  content: 'light',
};
export const HEAVY_CONCURRENCY_PER_TENANT = 2;

/**
 * B2-M4: per-slot keys with individual TTLs. The OLD design put the TTL on
 * the whole Redis SET and refreshed it on EVERY successful acquire — a
 * crashed worker never called releaseHeavySlot, its dead member stayed in
 * the set, and steady traffic re-armed the 900s TTL forever, silently
 * dropping the tenant's heavy concurrency from 2 to 1 until 15 minutes of
 * TOTAL heavy-job inactivity.
 *
 * Now each slot is its own key `fair:heavy:<tenant>:<slotId>` with an
 * individual EX 900; the set is only a directory. The acquire script reaps
 * dead members (directory entry whose per-slot key expired) atomically
 * before counting, so a crashed holder's slot frees itself at most 900s
 * after its last heartbeat — even under sustained traffic. The directory
 * TTL is re-armed on acquire and heartbeat, but that is now harmless:
 * reaping is by per-slot key existence, not by directory expiry.
 */
export async function acquireHeavySlot(tenantId: string, limit = HEAVY_CONCURRENCY_PER_TENANT): Promise<string | null> {
  const redis = getRedis();
  const prefix = `${redisKeyPrefix()}fair:heavy:${tenantId}`;
  const slotId = randomUUID();
  const slotKey = `${prefix}:${slotId}`;
  const script = `
    local setKey = KEYS[1]
    local limit = tonumber(ARGV[1])
    local ttl = tonumber(ARGV[2])
    local slotId = ARGV[3]
    local slotKey = ARGV[4]
    -- Reap dead slots: directory members whose per-slot key has expired.
    local members = redis.call('SMEMBERS', setKey)
    local live = 0
    for _, m in ipairs(members) do
      if redis.call('EXISTS', setKey .. ':' .. m) == 1 then
        live = live + 1
      else
        redis.call('SREM', setKey, m)
      end
    end
    if live >= limit then return nil end
    redis.call('SADD', setKey, slotId)
    redis.call('SET', slotKey, '1', 'EX', ttl)
    redis.call('EXPIRE', setKey, ttl)
    return slotId
  `;
  const out = (await redis.eval(script, 2, prefix, slotKey, String(limit), '900', slotId, slotKey)) as string | null;
  return out;
}

/** Releases a previously acquired slot (best-effort). */
export async function releaseHeavySlot(tenantId: string, slotId: string): Promise<void> {
  const redis = getRedis();
  const prefix = `${redisKeyPrefix()}fair:heavy:${tenantId}`;
  await redis
    .multi()
    .srem(prefix, slotId)
    .del(`${prefix}:${slotId}`)
    .exec()
    .catch(() => {});
}

/**
 * A2-L7: heartbeats a held slot's TTL. The acquire script sets EXPIRE 900
 * once, but a heavy job may legitimately run up to its queue timeout
 * (15 min for crawl) — without a heartbeat it could lose its slot at the
 * boundary while still running, silently exceeding
 * HEAVY_CONCURRENCY_PER_TENANT. Only extends when our slot is still a
 * member (never resurrects a reaped set). B2-M4: the heartbeat refreshes
 * the PER-SLOT key, not just the set — a dead holder's key expires on its
 * own and the next acquire reaps it, so refreshing no longer preserves
 * dead slots. The directory TTL is re-armed too (harmless: reaping is by
 * per-slot key existence, and without it a live holder could lose its
 * directory entry while its slot key is still alive).
 */
export async function heartbeatHeavySlot(tenantId: string, slotId: string, ttlSec = 900): Promise<boolean> {
  const redis = getRedis();
  const prefix = `${redisKeyPrefix()}fair:heavy:${tenantId}`;
  const out = await redis.eval(
    `if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then
       redis.call('EXPIRE', KEYS[2], ARGV[2])
       return redis.call('EXPIRE', KEYS[1], ARGV[2])
     else
       return 0
     end`,
    2,
    prefix,
    `${prefix}:${slotId}`,
    slotId,
    String(ttlSec),
  );
  return Number(out) === 1;
}

/** Pure helper (unit-tested): round-robin pick of the next tenant with
 * pending jobs, skipping tenants already at their heavy-slot limit. */
export function pickNextTenantFairly(pending: string[], atLimit: Set<string>): string | null {
  const eligible = pending.filter((t) => !atLimit.has(t));
  return eligible.length > 0 ? eligible[0] : null;
}
