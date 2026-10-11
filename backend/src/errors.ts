export class ApiError extends Error {
  status: number;
  code: string;
  extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Builds the frozen API error envelope:
 * `{ ok:false, error:{ code, message, requestId?, details? } }` (N-A1-2).
 * Pass the request id so every error body carries it. */
export function errorEnvelope(err: unknown, requestId?: string) {
  const rid = requestId ? { requestId } : {};
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: { ok: false, error: { code: err.code, message: err.message, ...err.extra, ...rid } },
    };
  }
  // Fastify schema-validation failures (thrown before the handler runs).
  // Frozen contract: validation errors → 400 VALIDATION_ERROR (N-A1-1).
  const fErr = err as { code?: string; validation?: unknown[] } | null | undefined;
  if (fErr?.code === 'FST_ERR_VALIDATION' || Array.isArray(fErr?.validation)) {
    // B2-L4: raw `validation` items carry schema internals (schemaPath,
    // params — incl. regex patterns and allowed-value lists). In
    // production only the failing field path + message go out; the full
    // items stay in dev/test where they help debugging.
    const raw = fErr.validation ?? [];
    const details =
      process.env.NODE_ENV === 'production'
        ? (raw as Array<{ instancePath?: string; message?: string }>).map((v) => ({
            instancePath: v?.instancePath ?? '',
            message: v?.message ?? 'invalid value',
          }))
        : raw;
    return {
      status: 400,
      body: {
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details,
          ...rid,
        },
      },
    };
  }
  // Never leak internal messages (Postgres details, provider responses,
  // missing-key hints) to clients in production. Log server-side instead.
  if (process.env.NODE_ENV === 'production') {
    console.error(`[api] internal error requestId=${requestId ?? '-'}:`, err instanceof Error ? err.message : err);
    return {
      status: 500,
      body: { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', ...rid } },
    };
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  return { status: 500, body: { ok: false, error: { code: 'INTERNAL', message, ...rid } } };
}

export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const unauthorized = (msg = 'Unauthorized') => new ApiError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Forbidden') => new ApiError(403, 'FORBIDDEN', msg);
export const conflict = (code: string, msg: string) => new ApiError(409, code, msg);
export const badRequest = (msg: string) => new ApiError(400, 'BAD_REQUEST', msg);
/** Input-validation failures (frozen contract: VALIDATION_ERROR, 400). */
export const validationError = (msg: string, details: unknown[] = []) =>
  new ApiError(400, 'VALIDATION_ERROR', msg, details.length > 0 ? { details } : {});
