// OAuth `state` store for the Google sign-in and GSC-connect flows.
// S-01: extracted from route-local in-memory maps into one testable module.
// S-04 will move this to Redis + bind the state to a signed httpOnly cookie
// (+ PKCE); the create/consume interface stays the same.
import { randomBytes } from 'node:crypto';

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 500;

export interface GscStateData {
  tenantId: string;
  siteId: string;
}

const signinStates = new Map<string, number>(); // state -> createdAt
const gscStates = new Map<string, { data: GscStateData; exp: number }>();

function sweep<K>(m: Map<K, number>, now: number) {
  if (m.size < MAX_ENTRIES) return;
  for (const [k, v] of m) if (now - v > TTL_MS) m.delete(k);
}

/** Google sign-in flow: mint a one-time state. */
export function createSigninState(): string {
  sweep(signinStates, Date.now());
  const state = randomBytes(16).toString('hex');
  signinStates.set(state, Date.now());
  return state;
}

/** Returns true once for a fresh state; false when missing/expired/reused. */
export function consumeSigninState(state: string): boolean {
  const createdAt = signinStates.get(state);
  if (state) signinStates.delete(state);
  if (!state || createdAt === undefined || Date.now() - createdAt > TTL_MS) return false;
  return true;
}

/** GSC-connect flow: mint a one-time state bound to tenant+site. */
export function createGscState(data: GscStateData): string {
  if (gscStates.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of gscStates) if (v.exp < now) gscStates.delete(k);
  }
  const state = randomBytes(16).toString('hex');
  gscStates.set(state, { data, exp: Date.now() + TTL_MS });
  return state;
}

/** Returns the bound data once for a fresh state; null when missing/expired/reused. */
export function consumeGscState(state: string): GscStateData | null {
  const s = state ? gscStates.get(state) : undefined;
  if (state) gscStates.delete(state);
  if (!state || !s || s.exp < Date.now()) return null;
  return s.data;
}
