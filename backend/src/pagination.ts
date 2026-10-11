import type { FastifyRequest } from 'fastify';
import { validationError } from './errors.js';

/** Stable pagination (C-07): page/limit/offset with a hard cap. */
export interface Page {
  page: number;
  limit: number;
  offset: number;
}

export function paginate(req: FastifyRequest, defaultLimit = 20, maxLimit = 100): Page {
  const q = req.query as { page?: unknown; limit?: unknown };
  const page = Math.max(1, parseInt(String(q.page ?? '1'), 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(String(q.limit ?? String(defaultLimit)), 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

export interface PagedResult<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
}

// AUDIT (A1-L4): the `paged` envelope helper was removed — it had zero
// callers (only `paginate` is used). Restorable from git history if needed.

/** Validates that a value is a UUID (C-07 input validation helper). */
export function assertUuid(v: unknown, name = 'id'): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    throw validationError(`${name} must be a valid UUID`);
  }
  return v;
}
