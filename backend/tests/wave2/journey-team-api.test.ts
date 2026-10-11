/**
 * Wave-2 PHASE GATE — E2E journey (team + public API).
 *
 *   team invite (202 generic) → invitee signs up → accepts (fresh session
 *   cookie set, bound to the owner's tenant) → member list reflects the
 *   role → API key created (shown once) → scoped API call succeeds →
 *   out-of-scope call 403s with INSUFFICIENT_SCOPE.
 *
 * Chaos/resilience citations (existing coverage, NOT duplicated here —
 * see the gate report):
 *  - Duplicate Idempotency-Key concurrent checkout executes once:
 *    tests/c-01.test.ts "SECURITY regression (C-01): two concurrent
 *    same-key checkouts execute exactly once" and "withIdempotency runs
 *    a concurrent duplicate handler once".
 *  - Webhook delivery redirecting to an internal address delivers
 *    nothing internally: tests/f-10.test.ts "SECURITY regression
 *    (F-10): redirect to an internal address is NOT followed"
 *    (internalHits === 0 asserted there).
 *  - DLQ capture + admin replay composition: tests/c-03.test.ts
 *    "captureDeadLetter stores a replayable row" + tests/f-14.test.ts
 *    "failed jobs: list, replay re-enqueues, discard closes". The one
 *    link those two do NOT cover — a real worker process turning a
 *    throwing job into a DLQ row — is covered NEW in
 *    journey-chaos.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../integration/helpers/app.js';
import { query, resetDb, uniqueEmail } from '../integration/helpers/db.js';
import { resetRedis } from '../integration/helpers/redis.js';
import { sessionTokenFromResponse } from '../helpers.js';

let app: FastifyInstance;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

interface GateUser {
  email: string;
  password: string;
  token: string;
  tenantId: string;
  verifyToken: string;
}

async function signupVerified(email: string): Promise<GateUser> {
  const password = `Gate!${Date.now()}${Math.floor(Math.random() * 1e9)}xQ9#Zz`;
  const s = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, password, name: 'Gate Team' },
  });
  expect(s.statusCode).toBe(201);
  const body = s.json() as any;
  const v = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/email/verify',
    payload: { token: body.verifyToken },
  });
  expect(v.statusCode).toBe(200);
  return {
    email,
    password,
    token: sessionTokenFromResponse(s),
    tenantId: body.tenant.id as string,
    verifyToken: body.verifyToken as string,
  };
}

function cookieValue(res: { headers: any }, name: string): string | null {
  const raw = res.headers['set-cookie'];
  const list: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const hit = list.find((c: string) => c.startsWith(`${name}=`));
  return hit ? hit.split(';')[0].slice(name.length + 1) : null;
}

let owner: GateUser;
let inviteeEmail: string;
let inviteToken: string;
let rawApiKey: string;

beforeAll(async () => {
  await resetDb();
  await resetRedis();
  app = await buildTestApp();
}, 60000);

afterAll(async () => {
  await app?.close();
});

describe('Wave-2 gate: team + API key journey', () => {
  it('owner invites a teammate → 202 generic response with the mock-mode accept token', async () => {
    owner = await signupVerified(uniqueEmail('gateowner'));
    inviteeEmail = uniqueEmail('gateinvitee');

    const inv = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations',
      headers: auth(owner.token),
      payload: { email: inviteeEmail, role: 'editor' },
    });
    // F-09 NEW-2: always 202 generic (no enumeration oracle). The token
    // debug field appears only because mail runs in mock mode here.
    expect(inv.statusCode).toBe(202);
    const body = inv.json() as any;
    expect(body.ok).toBe(true);
    inviteToken = body.token as string;
    expect(inviteToken).toMatch(/^[0-9a-f]{64}$/);
  }, 60000);

  it('invitee signs up → accepts → fresh session cookie bound to the owner tenant', async () => {
    const invitee = await signupVerified(inviteeEmail);
    expect(invitee.tenantId).not.toBe(owner.tenantId);

    const accept = await app.inject({
      method: 'POST',
      url: '/api/v1/account/invitations/accept',
      headers: auth(invitee.token),
      payload: { token: inviteToken },
    });
    expect(accept.statusCode).toBe(200);
    const body = accept.json() as any;
    expect(body).toMatchObject({ tenantId: owner.tenantId, role: 'editor' });

    // D3-M-1: the session JWT is delivered ONLY via the httpOnly cookie —
    // never in the JSON body (A3-H1 cookie-only policy). The browser
    // session works without a re-login via the cookie.
    const setCookie = cookieValue(accept, 'bseo_token');
    expect(setCookie).toBeTruthy();
    expect('token' in body).toBe(false);
    const raw = accept.headers['set-cookie'];
    const list: string[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    expect(list.find((c: string) => c.startsWith('bseo_token='))!.toLowerCase()).toContain('httponly');

    // And the fresh session is really bound to the owner's tenant.
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: auth(setCookie as string),
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as any).tenant.id).toBe(owner.tenantId);
    expect((me.json() as any).user.email).toBe(inviteeEmail);
    // (/auth/me does not expose user.role; role is asserted via the
    // accept response above and the member list below.)

    // The member list on the owner's side reflects the new member.
    const members = await app.inject({
      method: 'GET',
      url: '/api/v1/account/members',
      headers: auth(owner.token),
    });
    expect(members.statusCode).toBe(200);
    const emails = (members.json() as any).data.map((m: any) => `${m.email}:${m.role}`);
    expect(emails).toContain(`${inviteeEmail}:editor`);
  }, 60000);

  it('API key created (raw key shown once) → scoped call succeeds', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/apikeys',
      headers: auth(owner.token),
      payload: { name: 'gate-ci', scopes: ['sites:read'] },
    });
    expect(created.statusCode).toBe(200);
    const body = created.json() as any;
    rawApiKey = body.key as string;
    expect(rawApiKey).toMatch(/^bseo_[0-9a-f]{64}$/);
    expect(body).not.toHaveProperty('key_hash');

    // Only the sha256 hash is stored.
    const row = await query(`SELECT key_hash FROM api_keys WHERE tenant_id = $1`, [owner.tenantId]);
    expect(row.rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.rows[0].key_hash).not.toContain(rawApiKey);

    const scoped = await app.inject({
      method: 'GET',
      url: '/api/v1/sites',
      headers: { 'x-api-key': rawApiKey },
    });
    expect(scoped.statusCode).toBe(200);
    expect(Array.isArray((scoped.json() as any).data)).toBe(true);
  }, 60000);

  it('out-of-scope API call 403s with INSUFFICIENT_SCOPE + missing[]', async () => {
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: { 'x-api-key': rawApiKey },
      payload: { url: 'http://127.0.0.1:9/hook', events: ['limit.near'] },
    });
    expect(denied.statusCode).toBe(403);
    const body = denied.json() as any;
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE');
    // The frozen addendum promises missing[] on the 403 envelope.
    expect((body.error as any).missing).toContain('webhooks:write');
  }, 60000);
});
