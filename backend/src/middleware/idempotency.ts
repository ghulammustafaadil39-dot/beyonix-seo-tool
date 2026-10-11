import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db.js';

/**
 * Idempotency keys for POSTs that create paid work (C-07).
 *
 * Clients send `Idempotency-Key: <uuid>`; the key is scoped per tenant.
 * - The key is CLAIMED before the handler runs (C-01 fix): the first
 *   request INSERTs a pending row (response/status NULL) and only then
 *   executes. A concurrent duplicate sees the claim, WAITS for it to
 *   complete, and replays the stored response — the handler never
 *   executes twice for the same key (previously both requests could miss
 *   the lookup and both execute, e.g. a double Stripe checkout).
 * - A replay with the same key AND the same request hash (method+path+body)
 *   returns the stored response WITHOUT re-executing.
 * - The same key with a DIFFERENT body is a 422 (client bug — never silently
 *   reuse a response for different work).
 * - Failed executions DELETE their claim, so a later retry can execute
 *   (failures never poison the key).
 * - A duplicate that waits longer than the wait budget gets a 409
 *   IDEMPOTENCY_IN_PROGRESS instead of executing.
 * - NEW-3: a claim left `pending` by a process crash is ABANDONED after
 *   5 minutes — it is never reaped by its owner (there is none), so
 *   without this the key would be burned forever. A later request with
 *   the same key AND the same body hash may take the claim over
 *   (conditional DELETE of the stale row, then a fresh claim) and
 *   execute. The retention sweep also deletes stale pending claims.
 *
 * Usage: wrap the handler with `withIdempotency('scope', handler)`.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** How long a concurrent duplicate waits for the claiming request. */
const WAIT_TIMEOUT_MS = 15_000;
const WAIT_POLL_MS = 50;

/** NEW-3: a pending claim older than this is abandoned (crashed owner). */
export const STALE_PENDING_MS = 5 * 60_000;

export function requestHash(req: FastifyRequest): string {
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '');
  return crypto.createHash('sha256').update(`${req.method}:${req.url}:${body}`).digest('hex');
}

interface StoredResponse {
  statusCode: number;
  body: unknown;
}

interface LookupResult {
  requestHash: string;
  /** Null while the claiming request is still executing. */
  response: StoredResponse | null;
}

async function lookup(tenantId: string, key: string): Promise<LookupResult | null> {
  const r = await query(
    `SELECT request_hash, response, status_code FROM idempotency_keys
     WHERE tenant_id = $1 AND key = $2`,
    [tenantId, key],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return {
    requestHash: row.request_hash as string,
    response:
      row.status_code == null
        ? null
        : { statusCode: row.status_code as number, body: row.response },
  };
}

/** Atomically claims the key. Returns true when THIS caller owns the claim. */
async function claimKey(
  tenantId: string,
  key: string,
  scope: string,
  hash: string,
): Promise<boolean> {
  const r = await query(
    `INSERT INTO idempotency_keys (key, tenant_id, scope, request_hash, response, status_code)
     VALUES ($1, $2, $3, $4, NULL, NULL)
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [key, tenantId, scope, hash],
  );
  return (r.rowCount ?? 0) > 0;
}

async function completeClaim(
  tenantId: string,
  key: string,
  statusCode: number,
  body: unknown,
): Promise<void> {
  await query(
    `UPDATE idempotency_keys SET response = $3, status_code = $4
     WHERE tenant_id = $1 AND key = $2`,
    [tenantId, key, JSON.stringify(body ?? null), statusCode],
  );
}

async function releaseClaim(tenantId: string, key: string): Promise<void> {
  await query(`DELETE FROM idempotency_keys WHERE tenant_id = $1 AND key = $2`, [tenantId, key]);
}

/**
 * NEW-3: deletes a PENDING claim iff it is stale (older than
 * STALE_PENDING_MS — keep the interval literal below in sync) AND carries
 * the same request hash. Returns true when this caller reaped it (the
 * caller may then claim the key itself). The hash predicate means a
 * different-body reuse can never reap someone else's claim — it still
 * gets the 422 from replayOrConflict. The status/age predicates make the
 * delete race-safe: two concurrent takeover attempts, exactly one wins.
 */
async function reapStaleClaim(tenantId: string, key: string, hash: string): Promise<boolean> {
  const r = await query(
    `DELETE FROM idempotency_keys
     WHERE tenant_id = $1 AND key = $2 AND request_hash = $3
       AND status_code IS NULL
       AND created_at < now() - interval '5 minutes'`,
    [tenantId, key, hash],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Completes a previously-claimed (or fresh) idempotency record. Kept for
 * API compatibility; `withIdempotency` is the primary path.
 */
export async function storeIdempotentResponse(
  tenantId: string,
  key: string,
  scope: string,
  req: FastifyRequest,
  statusCode: number,
  body: unknown,
): Promise<void> {
  await query(
    `INSERT INTO idempotency_keys (key, tenant_id, scope, request_hash, response, status_code)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       response = EXCLUDED.response, status_code = EXCLUDED.status_code`,
    [key, tenantId, scope, requestHash(req), JSON.stringify(body ?? null), statusCode],
  );
}

function replayOrConflict(
  req: FastifyRequest,
  reply: FastifyReply,
  stored: LookupResult,
  hash: string,
): unknown | null {
  if (stored.requestHash !== hash) {
    return reply.status(422).send({
      ok: false,
      error: {
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency-Key was already used with a different request body.',
        requestId: req.id,
      },
    });
  }
  if (stored.response) {
    return reply.status(stored.response.statusCode).send(stored.response.body);
  }
  return null;
}

/**
 * Wraps a POST handler with idempotency-key support. The header is
 * optional — requests without it execute every time (unchanged behavior).
 */
export function withIdempotency(
  scope: string,
  handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers[IDEMPOTENCY_HEADER] as string | undefined;
    const tenantId: string | undefined = (req as any).tenant?.tenantId;
    if (!key || !tenantId) {
      return handler(req, reply);
    }
    const hash = requestHash(req);

    // Claim-before-execute loop: normally a single iteration; it repeats
    // only when a previous claim was released after a failed execution,
    // letting this request become the new claimant.
    for (;;) {
      const claimed = await claimKey(tenantId, key, scope, hash);
      if (claimed) {
        try {
          const body = await handler(req, reply);
          // Only store successful JSON responses (2xx). Failures are safe
          // to retry and must not poison the key.
          if (!reply.sent && reply.statusCode >= 200 && reply.statusCode < 300) {
            await completeClaim(tenantId, key, reply.statusCode, body);
          } else {
            await releaseClaim(tenantId, key);
          }
          return body;
        } catch (err) {
          await releaseClaim(tenantId, key).catch(() => undefined);
          throw err;
        }
      }

      // Someone else holds (or held) the key.
      const existing = await lookup(tenantId, key);
      if (!existing) continue; // claim was just released — try to claim it
      const immediate = replayOrConflict(req, reply, existing, hash);
      if (immediate !== null || existing.response || existing.requestHash !== hash) return immediate;

      // NEW-3: pending claim with OUR hash — if its owner crashed and
      // the claim is stale, take it over instead of waiting out the
      // budget and 409ing on a key that would never complete. The
      // conditional DELETE no-ops for a fresh claim, which then falls
      // through to the normal wait below.
      if (await reapStaleClaim(tenantId, key, hash)) continue;

      // Pending claim with our hash: wait for it to complete, then replay.
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      for (;;) {
        await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
        const cur = await lookup(tenantId, key);
        if (!cur) break; // claimer failed and released — outer loop re-claims
        const done = replayOrConflict(req, reply, cur, hash);
        if (done !== null || cur.response || cur.requestHash !== hash) return done;
        if (Date.now() >= deadline) {
          return reply.status(409).send({
            ok: false,
            error: {
              code: 'IDEMPOTENCY_IN_PROGRESS',
              message: 'A request with this Idempotency-Key is still in progress; retry shortly.',
              requestId: req.id,
            },
          });
        }
      }
    }
  };
}
