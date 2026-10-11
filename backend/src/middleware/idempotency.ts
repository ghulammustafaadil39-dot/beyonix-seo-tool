import crypto from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db.js';

/**
 * Idempotency keys for POSTs that create paid work (C-07).
 *
 * Clients send `Idempotency-Key: <uuid>`; the key is scoped per tenant.
 * - First request with the key executes the handler and stores {requestHash,
 *   response, statusCode}.
 * - A replay with the same key AND the same request hash (method+path+body)
 *   returns the stored response WITHOUT re-executing.
 * - The same key with a DIFFERENT body is a 422 (client bug — never silently
 *   reuse a response for different work).
 *
 * Usage: `preHandler: [idempotencyPreHandler('billing:checkout')]`, and the
 * handler must call `storeIdempotentResponse(req, reply, body)` — or simpler,
 * wrap with `withIdempotency('scope', handler)`.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

export function requestHash(req: FastifyRequest): string {
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '');
  return crypto.createHash('sha256').update(`${req.method}:${req.url}:${body}`).digest('hex');
}

interface StoredResponse {
  statusCode: number;
  body: unknown;
}

async function lookup(
  tenantId: string,
  key: string,
): Promise<{ requestHash: string; response: StoredResponse } | null> {
  const r = await query(
    `SELECT request_hash, response, status_code FROM idempotency_keys
     WHERE tenant_id = $1 AND key = $2`,
    [tenantId, key],
  );
  if (r.rows.length === 0) return null;
  return {
    requestHash: r.rows[0].request_hash as string,
    response: { statusCode: r.rows[0].status_code as number, body: r.rows[0].response },
  };
}

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
     ON CONFLICT (tenant_id, key) DO NOTHING`,
    [key, tenantId, scope, requestHash(req), JSON.stringify(body ?? null), statusCode],
  );
}

/**
 * Wraps a POST handler with idempotency-key support. The wrapped handler
 * runs normally on first use; replays short-circuit. The header is
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
    const stored = await lookup(tenantId, key);
    const hash = requestHash(req);
    if (stored) {
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
      return reply.status(stored.response.statusCode).send(stored.response.body);
    }
    const body = await handler(req, reply);
    // Only store successful JSON responses (2xx). Failures are safe to
    // retry and must not poison the key.
    if (!reply.sent && reply.statusCode >= 200 && reply.statusCode < 300) {
      await storeIdempotentResponse(tenantId, key, scope, req, reply.statusCode, body);
    }
    return body;
  };
}
