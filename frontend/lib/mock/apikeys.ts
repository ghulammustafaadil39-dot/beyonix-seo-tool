/**
 * lib/mock/apikeys.ts — F-13 Public API key management UI (mock-data adapter).
 * Pending backend endpoints (Backend Lead):
 *   GET/POST/DELETE /api/v1/api-keys, scopes, usage
 * Rendered with <MockBanner/>. Docs page at /docs/api describes the API.
 */

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  requests_30d: number;
}

export const API_SCOPES = [
  'sites:read',
  'audits:read',
  'keywords:read',
  'ranks:read',
  'content:read',
  'content:write',
  'reports:read',
  'webhooks:write',
] as const;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockApiKeys(): Promise<ApiKey[]> {
  await delay(250);
  return [
    {
      id: 'k1',
      name: 'Looker Studio connector',
      prefix: 'bseo_sk_9f2a…',
      scopes: ['sites:read', 'ranks:read', 'reports:read'],
      created_at: '2026-09-15T10:00:00Z',
      last_used_at: '2026-10-10T06:22:00Z',
      requests_30d: 1840,
    },
  ];
}

/** Simulated newly-created key: shown ONCE, like the real flow will be. */
export async function mockCreateKey(name: string, scopes: string[]): Promise<ApiKey & { secret: string }> {
  await delay(400);
  return {
    id: `k_${Date.now()}`,
    name,
    prefix: 'bseo_sk_7c1d…',
    scopes,
    created_at: new Date().toISOString(),
    last_used_at: null,
    requests_30d: 0,
    secret: 'bseo_sk_7c1d8f2a9e4b6c0d3f5a7b9e1d4c6a8b',
  };
}
