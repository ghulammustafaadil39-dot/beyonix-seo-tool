import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import { ApiError, errorEnvelope } from '../src/errors.js';

/**
 * N-A1-2 (HIGH): the error envelope did not match the frozen contract
 * { ok:false, error:{ code, message, requestId, details? } } — there was no
 * requestId anywhere. Every error body must carry the request id (and echo
 * it on the x-request-id response header).
 */
describe('N-A1-2 request id in error envelope', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  it('404 body matches the contract and echoes x-request-id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
    expect(res.headers['x-request-id']).toBe(body.error.requestId);
  });

  it('honors a client-supplied x-request-id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/does-not-exist',
      headers: { 'x-request-id': 'test-rid-123' },
    });
    expect(res.json().error.requestId).toBe('test-rid-123');
    expect(res.headers['x-request-id']).toBe('test-rid-123');
  });

  it('400 validation errors carry the request id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: {} });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('errorEnvelope(err, requestId) shapes the contract exactly', () => {
    const { status, body } = errorEnvelope(new ApiError(400, 'EMAIL_EXISTS', 'taken', { a: 1 }), 'rid-9');
    expect(status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: { code: 'EMAIL_EXISTS', message: 'taken', a: 1, requestId: 'rid-9' },
    });
  });

  it('errorEnvelope without a request id omits the key', () => {
    const { body } = errorEnvelope(new Error('boom'));
    expect('requestId' in (body.error as Record<string, unknown>)).toBe(false);
  });
});
