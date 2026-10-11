// S-03: login lockout with exponential backoff.
//
// Failed sign-in attempts are counted per account (SHA-256 of the email —
// raw emails never hit Redis) AND per client IP, in Redis so the state is
// shared across API instances. Past `maxAttempts` failures the account/IP
// is locked with exponential backoff: baseMs, 2*baseMs, 4*baseMs, ... capped
// at maxMs. Responses stay generic (see routes/auth.ts) so the lockout
// cannot be used to enumerate registered emails.
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { redisKeyPrefix } from '../redis.js';

export interface LockoutOptions {
  maxAttempts: number;
  baseLockoutMs: number;
  maxLockoutMs: number;
  /** How long idle failure counters survive. */
  windowMs: number;
  /** Test hook: namespace keys so parallel suites never collide. */
  keyPrefix?: string;
}

export const LOGIN_LOCKOUT_DEFAULTS: LockoutOptions = {
  maxAttempts: 5,
  baseLockoutMs: 5 * 60 * 1000,
  maxLockoutMs: 60 * 60 * 1000,
  windowMs: 60 * 60 * 1000,
};

const CHECK_LUA = `
local data = redis.call('GET', KEYS[1])
if not data then return {0, 0} end
local rec = cjson.decode(data)
local now = tonumber(ARGV[1])
if rec.lockedUntil and now < rec.lockedUntil then
  return {1, rec.lockedUntil - now}
end
return {0, 0}
`;

const RECORD_LUA = `
local data = redis.call('GET', KEYS[1])
local rec = data and cjson.decode(data) or {count = 0, lockedUntil = 0}
local now = tonumber(ARGV[1])
local maxAttempts = tonumber(ARGV[2])
local baseMs = tonumber(ARGV[3])
local maxMs = tonumber(ARGV[4])
local windowMs = tonumber(ARGV[5])
rec.count = rec.count + 1
if rec.count > maxAttempts then
  local shift = rec.count - maxAttempts - 1
  local backoff = baseMs * (2 ^ shift)
  if backoff > maxMs then backoff = maxMs end
  rec.lockedUntil = now + backoff
end
redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', windowMs)
if now < rec.lockedUntil then
  return {1, rec.lockedUntil - now, rec.count}
end
return {0, 0, rec.count}
`;

type RedisWithLockout = Redis & {
  bseoLockoutCheck(key: string, now: number): Promise<[number, number]>;
  bseoLockoutRecord(
    key: string,
    now: number,
    maxAttempts: number,
    baseMs: number,
    maxMs: number,
    windowMs: number,
  ): Promise<[number, number, number]>;
};

function withScripts(redis: Redis): RedisWithLockout {
  const r = redis as any;
  if (typeof r.bseoLockoutCheck !== 'function') {
    r.defineCommand('bseoLockoutCheck', { numberOfKeys: 1, lua: CHECK_LUA });
  }
  if (typeof r.bseoLockoutRecord !== 'function') {
    r.defineCommand('bseoLockoutRecord', { numberOfKeys: 1, lua: RECORD_LUA });
  }
  return r as RedisWithLockout;
}

function emailKey(email: string, prefix: string): string {
  const h = createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
  return `${prefix}loginfail:e:${h}`;
}

function ipKey(ip: string, prefix: string): string {
  return `${prefix}loginfail:ip:${ip}`;
}

function optsOf(o?: Partial<LockoutOptions>): LockoutOptions {
  const d = LOGIN_LOCKOUT_DEFAULTS;
  return {
    maxAttempts: o?.maxAttempts ?? d.maxAttempts,
    baseLockoutMs: o?.baseLockoutMs ?? d.baseLockoutMs,
    maxLockoutMs: o?.maxLockoutMs ?? d.maxLockoutMs,
    windowMs: o?.windowMs ?? d.windowMs,
    keyPrefix: o?.keyPrefix ?? redisKeyPrefix(),
  };
}

export interface LockoutStatus {
  locked: boolean;
  retryAfterMs: number;
}

/** True when the email OR the IP is currently locked out. Never mutates. */
export async function isLoginLocked(
  redis: Redis,
  email: string,
  ip: string,
  o?: Partial<LockoutOptions>,
): Promise<LockoutStatus> {
  const opts = optsOf(o);
  const r = withScripts(redis);
  const now = Date.now();
  const [eLocked, eRetry] = await r.bseoLockoutCheck(emailKey(email, opts.keyPrefix!), now);
  const [iLocked, iRetry] = await r.bseoLockoutCheck(ipKey(ip, opts.keyPrefix!), now);
  return {
    locked: eLocked === 1 || iLocked === 1,
    retryAfterMs: Math.max(Number(eRetry), Number(iRetry)),
  };
}

/** Records one failed attempt for the email AND the IP. Returns post-write status. */
export async function recordFailedLogin(
  redis: Redis,
  email: string,
  ip: string,
  o?: Partial<LockoutOptions>,
): Promise<LockoutStatus> {
  const opts = optsOf(o);
  const r = withScripts(redis);
  const now = Date.now();
  const args = [now, opts.maxAttempts, opts.baseLockoutMs, opts.maxLockoutMs, opts.windowMs] as const;
  const [eLocked, eRetry] = await r.bseoLockoutRecord(emailKey(email, opts.keyPrefix!), ...args);
  const [iLocked, iRetry] = await r.bseoLockoutRecord(ipKey(ip, opts.keyPrefix!), ...args);
  return {
    locked: eLocked === 1 || iLocked === 1,
    retryAfterMs: Math.max(Number(eRetry), Number(iRetry)),
  };
}

/** Clears failure counters for the email and IP (call on successful login). */
export async function clearLoginAttempts(
  redis: Redis,
  email: string,
  ip: string,
  o?: Partial<LockoutOptions>,
): Promise<void> {
  const prefix = o?.keyPrefix ?? redisKeyPrefix();
  await redis.del(emailKey(email, prefix), ipKey(ip, prefix));
}
