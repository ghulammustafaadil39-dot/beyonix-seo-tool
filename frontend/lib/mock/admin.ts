/**
 * lib/mock/admin.ts — F-14 Admin back-office UI (mock-data adapter).
 * Pending backend endpoints (Backend Lead): /api/v1/admin/* (tenants,
 * plans, usage, jobs, spend, suspend, impersonate, flags, health, override,
 * refunds). Admin-only. Rendered with <MockBanner/>.
 */

export interface AdminTenant {
  id: string;
  name: string;
  email: string;
  plan: string;
  status: 'active' | 'past_due' | 'suspended';
  sites: number;
  mrr_cents: number;
  created_at: string;
}

export interface FailedJob {
  id: string;
  queue: string;
  tenant: string;
  kind: string;
  failed_at: string;
  error: string;
}

export interface ProviderSpend {
  provider: string;
  month_cents: number;
  budget_cents: number;
}

export interface FeatureFlag {
  key: string;
  description: string;
  enabled: boolean;
  rollout_pct: number;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function mockTenants(): Promise<AdminTenant[]> {
  await delay(300);
  return [
    { id: 't1', name: 'Acme Corp', email: 'owner@acme.example', plan: 'growth', status: 'active', sites: 3, mrr_cents: 7900, created_at: '2026-05-01T10:00:00Z' },
    { id: 't2', name: 'Bakery Ltd', email: 'hello@bakery.example', plan: 'starter', status: 'active', sites: 1, mrr_cents: 2900, created_at: '2026-07-19T10:00:00Z' },
    { id: 't3', name: 'Old Client', email: 'x@old.example', plan: 'starter', status: 'past_due', sites: 1, mrr_cents: 2900, created_at: '2026-06-11T10:00:00Z' },
  ];
}

export async function mockFailedJobs(): Promise<FailedJob[]> {
  await delay(250);
  return [
    { id: 'j1', queue: 'crawl', tenant: 'Acme Corp', kind: 'crawl', failed_at: '2026-10-10T22:14:00Z', error: 'Timeout after 30s (robots.txt fetch)' },
    { id: 'j2', queue: 'serp', tenant: 'Bakery Ltd', kind: 'rank-check', failed_at: '2026-10-10T21:02:00Z', error: 'Provider rate limit (429)' },
  ];
}

export async function mockSpend(): Promise<ProviderSpend[]> {
  await delay(250);
  return [
    { provider: 'DataForSEO', month_cents: 18420, budget_cents: 50000 },
    { provider: 'LLM (content + GEO)', month_cents: 9310, budget_cents: 30000 },
    { provider: 'PageSpeed API', month_cents: 120, budget_cents: 2000 },
  ];
}

export async function mockFlags(): Promise<FeatureFlag[]> {
  await delay(200);
  return [
    { key: 'geo_v2', description: 'Multi-engine GEO tracking', enabled: true, rollout_pct: 100 },
    { key: 'white_label', description: 'White-label reports', enabled: true, rollout_pct: 100 },
    { key: 'api_public', description: 'Public API keys', enabled: false, rollout_pct: 0 },
  ];
}

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}
