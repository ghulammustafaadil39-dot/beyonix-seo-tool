// S-03: per-account rate limits for expensive endpoints.
// Use as a route-level preHandler AFTER requireVerifiedEmail (the instance
// auth hook runs first, so req.tenant is available for the tenant key).
import { tenantExpensiveLimit } from '../config.js';
import { getRedis, redisKeyPrefix } from '../redis.js';
import { tenantRateLimit } from '../services/redisRateLimitStore.js';

/**
 * Per-tenant hourly budget for cost-incurring endpoints (keyword research,
 * content/GEO generation). The max is re-read per request (live env
 * fallback), so ops/tests can tune TENANT_EXPENSIVE_LIMIT_PER_HOUR without
 * a reboot.
 */
export function expensiveTenantLimit() {
  return tenantRateLimit({
    redis: getRedis(),
    max: () => tenantExpensiveLimit(),
    windowMs: 60 * 60 * 1000,
    keyPrefix: `${redisKeyPrefix()}acct-rl:expensive:`,
  });
}

/**
 * E1-L-2: dedicated invitation throttle — separate bucket from the spend
 * budget (a tenant doing heavy research shouldn't starve invites, and
 * invite spam shouldn't eat the spend budget). 20/hour/tenant.
 */
export function inviteTenantLimit() {
  return tenantRateLimit({
    redis: getRedis(),
    max: () => 20,
    windowMs: 60 * 60 * 1000,
    keyPrefix: `${redisKeyPrefix()}acct-rl:invite:`,
  });
}
