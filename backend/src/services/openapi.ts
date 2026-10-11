/**
 * C-07 / N-A2-8: OpenAPI 3.1 served at /api/v1/openapi.json, GENERATED from
 * the Fastify route JSON schemas (not hand-written). An `onRoute` hook in
 * buildApp() collects every route's { method, url, schema } — including
 * routes added later by other teams — so the spec never drifts from code.
 */

export interface DocumentedRoute {
  method: string;
  url: string;
  schema?: {
    params?: any;
    querystring?: any;
    body?: any;
    response?: any;
    description?: string;
    summary?: string;
    tags?: string[];
  };
}

const registry = new Map<string, DocumentedRoute>();

/** Called by the onRoute hook in buildApp(). Dedupe: last registration wins. */
export function recordRouteForDocs(route: DocumentedRoute): void {
  registry.set(`${route.method.toUpperCase()} ${route.url}`, route);
}

export function getDocumentedRoutes(): DocumentedRoute[] {
  return [...registry.values()];
}

/** Test/ops escape hatch. */
export function clearDocumentedRoutes(): void {
  registry.clear();
}

function fastifyPathToOpenApi(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function paramsFromSchema(schema: any, where: 'path' | 'query'): any[] {
  if (!schema || typeof schema !== 'object') return [];
  const props = schema.properties ?? {};
  const required: string[] = schema.required ?? [];
  return Object.entries(props).map(([name, prop]: [string, any]) => ({
    name,
    in: where,
    required: where === 'path' ? true : required.includes(name),
    schema: prop && typeof prop === 'object' ? sanitizeSchema(prop) : { type: 'string' },
  }));
}

/** Strips Fastify-only keywords, keeps JSON-Schema/OpenAPI 3.1 compatible shape. */
function sanitizeSchema(node: any): any {
  if (Array.isArray(node)) return node.map(sanitizeSchema);
  if (!node || typeof node !== 'object') return node;
  const out: any = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'const') {
      out.enum = [v];
      continue;
    }
    out[k] = sanitizeSchema(v);
  }
  return out;
}

export function buildOpenApiSpec(): Record<string, unknown> {
  const paths: Record<string, any> = {};
  for (const route of getDocumentedRoutes()) {
    // K1-LOW-1 (pass#11): the spec is served on a PUBLIC, unauthenticated
    // endpoint — never enumerate the back-office surface. Admin routes are
    // deliberately obscured (404-not-403); publishing their paths +
    // request schemas would nullify that control for reconnaissance.
    if (/(^|\/)admin(\/|$)/.test(route.url)) continue;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const openapiPath = fastifyPathToOpenApi(route.url);
    for (const method of methods) {
      const m = method.toLowerCase();
      if (!['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(m)) continue;
      const s = route.schema ?? {};
      const parameters = [
        ...paramsFromSchema(s.params, 'path'),
        ...paramsFromSchema(s.querystring, 'query'),
      ];
      const operation: any = {
        summary: s.summary ?? `${method.toUpperCase()} ${route.url}`,
        ...(s.description ? { description: s.description } : {}),
        ...(s.tags ? { tags: s.tags } : {}),
        ...(parameters.length > 0 ? { parameters } : {}),
        responses: {},
      };
      if (s.body && ['post', 'put', 'patch'].includes(m)) {
        operation.requestBody = {
          required: true,
          content: { 'application/json': { schema: sanitizeSchema(s.body) } },
        };
      }
      const responses = s.response ?? {};
      const codes = Object.keys(responses);
      if (codes.length > 0) {
        for (const code of codes) {
          operation.responses[code] = {
            description: `Response ${code}`,
            content: { 'application/json': { schema: sanitizeSchema(responses[code]) } },
          };
        }
      } else {
        operation.responses['200'] = { description: 'Successful response' };
      }
      // The frozen error envelope (contract §3.3) on error codes.
      operation.responses['400'] = operation.responses['400'] ?? {
        description: 'Validation error',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                ok: { const: false },
                error: {
                  type: 'object',
                  properties: {
                    code: { type: 'string', example: 'VALIDATION_ERROR' },
                    message: { type: 'string' },
                    requestId: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      };
      paths[openapiPath] = paths[openapiPath] ?? {};
      paths[openapiPath][m] = operation;
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Beyonix SEO API',
      version: '1.0.0',
      description:
        'SEO + GEO SaaS API. Authentication: Bearer JWT (session), httpOnly cookie, or API key ' +
        '(Authorization: Bearer bseo_... / x-api-key). Errors follow { ok:false, error:{ code, message, requestId } }.',
    },
    servers: [{ url: '/api/v1', description: 'Version 1' }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        apiKeyHeader: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      },
    },
  };
}
