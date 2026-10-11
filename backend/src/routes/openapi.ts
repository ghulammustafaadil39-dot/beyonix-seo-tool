import type { FastifyInstance } from 'fastify';
import { buildOpenApiSpec } from '../services/openapi.js';

/** C-07 / N-A2-8: OpenAPI 3.1, generated from route schemas. Public (docs). */
export async function registerOpenApiRoutes(fastify: FastifyInstance) {
  fastify.get('/openapi.json', async (_req, reply) => {
    return reply.header('Content-Type', 'application/json').send(buildOpenApiSpec());
  });
}
