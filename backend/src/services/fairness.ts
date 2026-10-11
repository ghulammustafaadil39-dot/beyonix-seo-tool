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
 * Atomic try-acquire of a per-tenant heavy slot. Returns true when the
 * tenant holds < limit slots; the slot key carries a TTL so a crashed
 * worker cannot wedge a tenant forever.
 */
export async function acquireHeavySlot(tenantId: string, limit = HEAVY_CONCURRENCY_PER_TENANT): Promise<string | null> {
  const redis = getRedis();
  const setKey = `${redisKeyPrefix()}fair:heavy:${tenantId}`;
  const slotId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const script = `
    local n = redis.call('SCARD', KEYS[1])
    if tonumber(n) >= tonumber(ARGV[2]) then return nil end
    redis.call('SADD', KEYS[1], ARGV[1])
    redis.call('EXPIRE', KEYS[1], 900)
    return ARGV[1]
  `;
  const out = (await redis.eval(script, 1, setKey, slotId, String(limit))) as string | null;
  return out;
}

/** Releases a previously acquired slot (best-effort). */
export async function releaseHeavySlot(tenantId: string, slotId: string): Promise<void> {
  const redis = getRedis();
  await redis.srem(`${redisKeyPrefix()}fair:heavy:${tenantId}`, slotId).catch(() => {});
}

/** Pure helper (unit-tested): round-robin pick of the next tenant with
 * pending jobs, skipping tenants already at their heavy-slot limit. */
export function pickNextTenantFairly(pending: string[], atLimit: Set<string>): string | null {
  const eligible = pending.filter((t) => !atLimit.has(t));
  return eligible.length > 0 ? eligible[0] : null;
}
