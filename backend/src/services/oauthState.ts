// OAuth `state` store for the Google sign-in, GSC-connect and GA4-connect flows.
//
// S-04: the store is Redis (shared across API instances — the old in-memory
// maps let a state minted on one instance never validate on another), every
// state is bound to the initiating browser via a signed httpOnly cookie
// (login-CSRF defense: an attacker can't complete their OAuth flow in the
// victim's browser), states are one-time use (atomic GETDEL) with a 15-minute
// TTL, and each flow carries a PKCE code verifier (S256) for Google.
//
// Interface (stable names/semantics since S-01): create* mints a fresh
// one-time state and returns it with its PKCE code challenge; consume*
// returns the stored payload once, or null when the state is
// missing/expired/already used.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import { config } from '../config.js';
import { getRedis } from '../redis.js';

export const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
export const OAUTH_STATE_COOKIE = 'bseo_oauth_state';
const MAX_COOKIE_STATES = 5;

export interface GscStateData {
  tenantId: string;
  siteId: string;
}

interface StoredState {
  data: GscStateData | null;
  codeVerifier: string;
  exp: number;
}

export interface CreatedOAuthState {
  state: string;
  /** S256 PKCE challenge to send to Google; the verifier stays server-side. */
  codeChallenge: string;
}

interface StateOpts {
  /** Test hook: namespace Redis keys so parallel suites never collide. */
  keyPrefix?: string;
}

const prefixOf = (o?: StateOpts): string => o?.keyPrefix ?? 'bseo:';
const stateKey = (prefix: string, flow: string, state: string): string =>
  `${prefix}oauth:${flow}:${state}`;

function newCodeVerifier(): string {
  // 32 random bytes -> 43 base64url chars (RFC 7636: 43..128).
  return randomBytes(32).toString('base64url');
}

/** S256 PKCE code challenge for a verifier. Pure and unit-testable. */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

async function storeState(
  redis: Redis,
  flow: string,
  state: string,
  data: GscStateData | null,
  prefix: string,
): Promise<string> {
  const codeVerifier = newCodeVerifier();
  const rec: StoredState = { data, codeVerifier, exp: Date.now() + OAUTH_STATE_TTL_MS };
  await redis.set(stateKey(prefix, flow, state), JSON.stringify(rec), 'PX', OAUTH_STATE_TTL_MS);
  return codeVerifier;
}

/**
 * Atomic one-time consume (GETDEL, Redis >= 6.2). Returns the stored record,
 * or null when the state is missing, expired, or already consumed.
 */
async function consumeState(
  redis: Redis,
  flow: string,
  state: string,
  prefix: string,
): Promise<StoredState | null> {
  if (!state || typeof state !== 'string') return null;
  const raw = await redis.getdel(stateKey(prefix, flow, state));
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as StoredState;
    if (!rec || typeof rec.codeVerifier !== 'string' || rec.exp < Date.now()) return null;
    return rec;
  } catch {
    return null;
  }
}

/** Google sign-in flow: mint a one-time state (+ PKCE verifier). */
export async function createSigninState(
  redis: Redis = getRedis(),
  o?: StateOpts,
): Promise<CreatedOAuthState> {
  const state = randomBytes(16).toString('hex');
  const codeVerifier = await storeState(redis, 'signin', state, null, prefixOf(o));
  return { state, codeChallenge: codeChallenge(codeVerifier) };
}

/** Returns the PKCE verifier once for a fresh state; null when missing/expired/reused. */
export async function consumeSigninState(
  state: string,
  redis: Redis = getRedis(),
  o?: StateOpts,
): Promise<{ codeVerifier: string } | null> {
  const rec = await consumeState(redis, 'signin', state, prefixOf(o));
  return rec ? { codeVerifier: rec.codeVerifier } : null;
}

/** GSC/GA4-connect flow: mint a one-time state bound to tenant+site (+ PKCE verifier). */
export async function createGscState(
  data: GscStateData,
  redis: Redis = getRedis(),
  o?: StateOpts,
): Promise<CreatedOAuthState> {
  const state = randomBytes(16).toString('hex');
  const codeVerifier = await storeState(redis, 'gsc', state, data, prefixOf(o));
  return { state, codeChallenge: codeChallenge(codeVerifier) };
}

/** Returns the bound data + PKCE verifier once; null when missing/expired/reused. */
export async function consumeGscState(
  state: string,
  redis: Redis = getRedis(),
  o?: StateOpts,
): Promise<{ data: GscStateData; codeVerifier: string } | null> {
  const rec = await consumeState(redis, 'gsc', state, prefixOf(o));
  if (!rec || !rec.data) return null;
  return { data: rec.data, codeVerifier: rec.codeVerifier };
}

/** GA4-connect flow: same shape as GSC (tenant+site binding), own namespace. */
export async function createGa4State(
  data: GscStateData,
  redis: Redis = getRedis(),
  o?: StateOpts,
): Promise<CreatedOAuthState> {
  const state = randomBytes(16).toString('hex');
  const codeVerifier = await storeState(redis, 'ga4', state, data, prefixOf(o));
  return { state, codeChallenge: codeChallenge(codeVerifier) };
}

/** Returns the bound data + PKCE verifier once; null when missing/expired/reused. */
export async function consumeGa4State(
  state: string,
  redis: Redis = getRedis(),
  o?: StateOpts,
): Promise<{ data: GscStateData; codeVerifier: string } | null> {
  const rec = await consumeState(redis, 'ga4', state, prefixOf(o));
  if (!rec || !rec.data) return null;
  return { data: rec.data, codeVerifier: rec.codeVerifier };
}

// ---------------------------------------------------------------------------
// Browser binding: signed httpOnly cookie listing the states this browser
// initiated. The callback requires the returned `state` query param to be in
// the signed list, so an OAuth response can't be completed cross-browser
// (login CSRF / session fixation via the OAuth flow).
// ---------------------------------------------------------------------------

function cookieSecret(): string {
  // Dedicated COOKIE_SECRET preferred; the JWT secret is the fail-safe so
  // the binding can never be unsigned by misconfiguration.
  return config.cookieSecret || config.jwtSecret;
}

/**
 * Signs a list of states for the cookie. Pure and unit-testable.
 * Format: base64url(JSON([state,...])) + '.' + hex(HMAC_SHA256(payload)).
 */
export function signOAuthStates(states: string[]): string {
  const payload = Buffer.from(JSON.stringify(states.slice(-MAX_COOKIE_STATES)), 'utf8').toString('base64url');
  const sig = createHmac('sha256', cookieSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/** True when the cookie is correctly signed and lists the given state. */
export function verifyOAuthStates(cookieValue: string | undefined, state: string): boolean {
  if (!cookieValue || !state) return false;
  const dot = cookieValue.lastIndexOf('.');
  if (dot === -1) return false;
  const payload = cookieValue.slice(0, dot);
  const sigHex = cookieValue.slice(dot + 1);
  const expected = createHmac('sha256', cookieSecret()).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sigHex, 'hex');
  } catch {
    return false;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const states = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(states) && states.includes(state);
  } catch {
    return false;
  }
}

function readCookieStates(req: any): string[] {
  const raw = req?.cookies?.[OAUTH_STATE_COOKIE] as string | undefined;
  if (!raw) return [];
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return [];
  const payload = raw.slice(0, dot);
  const sigHex = raw.slice(dot + 1);
  const expected = createHmac('sha256', cookieSecret()).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(sigHex, 'hex');
  } catch {
    return [];
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return [];
  try {
    const states = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(states) ? states.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Appends the state to the signed httpOnly state cookie (keeps the last
 * few so parallel tabs each keep a working flow). Call on OAuth start.
 */
export function setOAuthStateCookie(reply: any, state: string, req?: any): void {
  const states = [...readCookieStates(req).filter((s) => s !== state), state].slice(-MAX_COOKIE_STATES);
  reply.setCookie(OAUTH_STATE_COOKIE, signOAuthStates(states), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.nodeEnv === 'production',
    path: '/',
    maxAge: OAUTH_STATE_TTL_MS / 1000,
  });
}

/** Clears the state cookie after a flow completes. */
export function clearOAuthStateCookie(reply: any): void {
  reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
}
