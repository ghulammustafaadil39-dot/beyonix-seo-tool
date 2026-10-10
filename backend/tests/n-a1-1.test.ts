import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import { errorEnvelope } from '../src/errors.js';

/**
 * N-A1-1 (HIGH): Fastify schema-validation errors surfaced as HTTP 500
 * INTERNAL instead of 400 VALIDATION_ERROR, violating the frozen error-
 * envelope contract ("validation errors → VALIDATION_ERROR (400)").
 */
describe('N-A1-1 validation errors', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  it('POST /auth/signup with an invalid body returns 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email: 'not-an-email', password: 'short' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('POST /auth/signup with a missing body returns 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('errorEnvelope maps Fastify FST_ERR_VALIDATION to 400 VALIDATION_ERROR', () => {
    const fastifyValidationError = Object.assign(new Error('body/email must match format "email"'), {
      statusCode: 400,
      code: 'FST_ERR_VALIDATION',
      validation: [{ instancePath: '/email', schemaPath: '#/properties/email/format', keyword: 'format' }],
    });
    const { status, body } = errorEnvelope(fastifyValidationError);
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});
