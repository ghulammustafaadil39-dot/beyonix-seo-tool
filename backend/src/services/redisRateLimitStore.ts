// S-03: Redis-backed rate limiting.
//
// Two pieces:
//  1. createRateLimitStore() — a @fastify/rate-limit v10-compatible store
//     constructor so per-IP limits are shared across API instances instead
//     of living in each process's memory.
//  2. tenantRateLimit() — a per-account (tenant) limiter for expensive
//     endpoints, as a Fastify preHandler factory.
//
// Both use one Lua script (atomic INCR + fixed-window TTL).
import type { Redis } from 'ioredis';
import { ApiError } from '../errors.js';

const RATE_LIMIT_LUA = `
local current = redis.call('INCR', KEYS[1])
local ttl
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
else
  ttl = redis.call('PTTL', KEYS[1])
end
return {current, ttl}
`;

type RedisWithScript = Redis & {
  bseoRateLimit(key: string, windowMs: number, cb: (err: Error | null, res: [number, number]) => void): void;
  bseoRateLimit(key: string, windowMs: number): Promise<[number, number]>;
};

function withScript(redis: Redis): RedisWithScript {
  const r = redis as RedisWithScript;
  if (typeof r.bseoRateLimit !== 'function') {
    (redis as any).defineCommand('bseoRateLimit', { numberOfKeys: 1, lua: RATE_LIMIT_LUA });
  }
  return r;
}

interface StoreCtorOptions {
  timeWindow?: number | string | ((req: any, key: string) => number | Promise<number>);
  max?: number | ((req: any, key: string) => number | Promise<number>);
  nameSpace?: string;
}

interface StoreIncrResult {
  current: number;
  ttl: number;
}

/**
 * Returns a class matching @fastify/rate-limit v10's FastifyRateLimitStoreCtor
 * (`new(options)`, `.child(routeOptions)`, `.incr(key, cb, timeWindow?, max?)`).
 * The plugin instantiates it with the global params and calls child() per
 * route, so each route gets its own key prefix.
 */
export function createRateLimitStore(redis: Redis, keyPrefix = 'bseo:rl:') {
  const r = withScript(redis);
  return class RedisRateLimitStore {
    private prefix: string;
    private timeWindow: number;
    constructor(options: StoreCtorOptions = {}) {
      this.prefix = `${keyPrefix}${options.nameSpace ?? ''}`;
      this.timeWindow = typeof options.timeWindow === 'number' ? options.timeWindow : 60_000;
    }
    child(routeOptions: any): RedisRateLimitStore {
      const method = routeOptions?.routeInfo?.method ?? routeOptions?.method ?? 'ANY';
      const url = routeOptions?.routeInfo?.url ?? routeOptions?.url ?? routeOptions?.path ?? 'global';
      const Ctor = this.constructor as new (o: StoreCtorOptions) => RedisRateLimitStore;
      return new Ctor({
        timeWindow: typeof routeOptions?.timeWindow === 'number' ? routeOptions.timeWindow : this.timeWindow,
        nameSpace: `${method}:${url}:`,
      });
    }
    incr(
      key: string,
      callback: (err: Error | null, res?: StoreIncrResult) => void,
      timeWindow?: number,
    ): void {
      const tw = typeof timeWindow === 'number' && timeWindow > 0 ? timeWindow : this.timeWindow;
      r.bseoRateLimit(this.prefix + String(key), tw, (err, res) => {
        if (err) return callback(err);
        callback(null, { current: Number(res?.[0] ?? 0), ttl: Number(res?.[1] ?? 0) });
      });
    }
  };
}

export interface TenantRateLimitOptions {
  redis: Redis;
  /** Max requests per window. A function is re-read per request (env-tunable). */
  max: number | (() => number);
  windowMs: number;
  keyPrefix?: string;
  /** Defaults to the authenticated tenant, falling back to the client IP. */
  keyFn?: (req: any) => string;
}

/**
 * Fastify preHandler factory enforcing a per-account (tenant) rate limit on
 * expensive endpoints (keyword research, content generation). Throws 429
 * RATE_LIMITED when exceeded. Instance hook (authPlugin) runs first, so
 * req.tenant is available here.
 */
export function tenantRateLimit(opts: TenantRateLimitOptions) {
  const r = withScript(opts.redis);
  const prefix = opts.keyPrefix ?? 'bseo:acct-rl:';
  const keyFn =
    opts.keyFn ??
    ((req: any) => (req.tenant?.tenantId ? `tenant:${req.tenant.tenantId}` : `ip:${req.ip ?? 'unknown'}`));
  return async (req: any): Promise<void> => {
    const max = typeof opts.max === 'function' ? opts.max() : opts.max;
    const [current, ttl] = await r.bseoRateLimit(prefix + keyFn(req), opts.windowMs);
    if (current > max) {
      const retrySec = Math.max(1, Math.ceil(ttl / 1000));
      throw new ApiError(
        429,
        'RATE_LIMITED',
        `Too many requests for this account — try again in ${retrySec}s`,
      );
    }
  };
}
