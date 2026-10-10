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

export function errorEnvelope(err: unknown) {
  if (err instanceof ApiError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, ...err.extra } } };
  }
  // Never leak internal messages (Postgres details, provider responses,
  // missing-key hints) to clients in production. Log server-side instead.
  if (process.env.NODE_ENV === 'production') {
    console.error('[api] internal error:', err instanceof Error ? err.message : err);
    return { status: 500, body: { error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } } };
  }
  const message = err instanceof Error ? err.message : 'Internal server error';
  return { status: 500, body: { error: { code: 'INTERNAL', message } } };
}

export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found`);
export const unauthorized = (msg = 'Unauthorized') => new ApiError(401, 'UNAUTHORIZED', msg);
export const forbidden = (msg = 'Forbidden') => new ApiError(403, 'FORBIDDEN', msg);
export const conflict = (code: string, msg: string) => new ApiError(409, code, msg);
export const badRequest = (msg: string) => new ApiError(400, 'BAD_REQUEST', msg);
