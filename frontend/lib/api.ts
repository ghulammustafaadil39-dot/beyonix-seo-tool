// Typed client for the Beyonix SEO Tool API.
// Auth is via the httpOnly cookie `bseo_token` set by the API, so every
// request uses credentials: 'include'.
//
// The browser always uses same-origin relative URLs: app/api/[...path]/route.ts
// proxies /api/* to the API origin read from the runtime environment, so the
// API URL is never baked into the client bundle. Set NEXT_PUBLIC_API_URL at
// build time to bypass the proxy and call the API directly (non-proxied deploys).
const BASE_URL = process.env.NEXT_PUBLIC_API_URL || '';

export interface ApiErrorShape {
  code: string;
  message: string;
  upgrade?: boolean;
  used?: number;
  limit?: number;
  status: number;
}

export class ApiError extends Error {
  code: string;
  upgrade?: boolean;
  used?: number;
  limit?: number;
  status: number;
  constructor(shape: ApiErrorShape) {
    super(shape.message);
    this.code = shape.code;
    this.upgrade = shape.upgrade;
    this.used = shape.used;
    this.limit = shape.limit;
    this.status = shape.status;
  }
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

/**
 * S-06: reads the readable CSRF double-submit cookie set by the API and
 * echoes it in the x-csrf-token header on mutations. SSR-safe (no document
 * on the server).
 */
function csrfHeader(): Record<string, string> {
  if (typeof document === 'undefined') return {};
  const m = /(?:^|; )bseo_csrf=([^;]*)/.exec(document.cookie);
  return m ? { 'x-csrf-token': decodeURIComponent(m[1]) } : {};
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: opts.method || 'GET',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...csrfHeader() },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError({
      code: 'NETWORK_ERROR',
      message: "We couldn't reach the server. Check your connection and try again.",
      status: 0,
    });
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (!res.ok) {
    // Expired/revoked session: bounce to login instead of stranding the user
    // on a broken page. Skip when already on an auth page.
    if (res.status === 401 && typeof window !== 'undefined') {
      const p = window.location.pathname;
      if (!p.startsWith('/login') && !p.startsWith('/signup')) {
        window.location.href = `/login?next=${encodeURIComponent(p)}`;
        // Throw anyway in case navigation is blocked; the redirect wins.
      }
    }
    const err = (json && json.error) || {};
    throw new ApiError({
      code: err.code || 'REQUEST_FAILED',
      message: friendlyMessage(res.status, err),
      upgrade: err.upgrade,
      used: err.used,
      limit: err.limit,
      status: res.status,
    });
  }
  return json as T;
}

/** Maps technical error codes to plain language for non-expert users. */
function friendlyMessage(status: number, err: { code?: string; message?: string }): string {
  const raw = err.message || '';
  // Never show internal limit keys like "geo_checks" to customers.
  const pretty = raw
    .replace(/\bgeo_checks\b/g, 'AI visibility checks')
    .replace(/\bai_words\b/g, 'AI words')
    .replace(/\bserp_checks\b/g, 'rank checks')
    .replace(/\bkeyword_metrics\b/g, 'keyword lookups')
    .replace(/\bcrawl_pages\b/g, 'crawled pages')
    .replace(/\bkeywords_tracked\b/g, 'tracked keywords');
  if (status === 401) return 'Your session expired. Please log in again.';
  if (!pretty) return `Request failed (${status})`;
  return pretty;
}

// ---------- Types (mirror CONTRACTS.md shapes) ----------

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: string;
}
export interface Tenant {
  id: string;
  name: string;
  plan_id: string;
}
export interface AuthResponse {
  token: string;
  user: User;
  tenant: Tenant;
}

export interface Site {
  id: string;
  domain: string;
  verified: boolean;
  gsc_connected: boolean;
  ga4_connected: boolean;
  ga4_property_id: string | null;
  serp_location_code: number;
  serp_location_name: string;
  created_at: string;
}
export interface VerifyResult {
  token: string;
  instructions: string;
  verified: boolean;
}
export interface SiteOverview {
  score: number | null;
  sites?: unknown;
  issues?: unknown;
  [key: string]: unknown;
}
export interface Paged<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
}

export interface Audit {
  id: string;
  site_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  started_at: string | null;
  finished_at: string | null;
  score: number | null;
  issues_count: number;
  pages_crawled: number;
  error: string | null;
}
export interface AuditIssue {
  id: string;
  audit_id: string;
  site_id: string;
  type: string;
  severity: 'info' | 'warning' | 'error';
  url: string;
  detail: string;
  fix_suggestion: string;
  status: 'open' | 'fixed' | 'ignored';
}

export interface Keyword {
  id: string;
  site_id: string;
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  intent: string | null;
  priority_score: number | null;
  added_from: string | null;
  group_key: string | null;
  tracked: boolean;
  created_at: string;
}
export interface RankEntry {
  keyword_id: string;
  keyword: string;
  position: number | null;
  url: string | null;
  checked_at: string | null;
  spark?: number[];
  serp_features?: string[];
}
export interface RankHistoryPoint {
  checked_at: string;
  position: number | null;
  url: string | null;
}

export interface ContentPiece {
  id: string;
  site_id: string;
  keyword_id: string | null;
  title: string;
  outline: string | null;
  draft: string | null;
  status: 'draft' | 'review' | 'approved';
  ai_words_used: number;
  created_at: string;
  updated_at: string;
}
export interface QualityBreakdown {
  label: string;
  points: number;
  max: number;
  note: string;
}
export interface PageQuality {
  score: number;
  grade: string;
  breakdown: QualityBreakdown[];
}
export interface OnpageSuggestionItem {
  area: string;
  current?: string;
  suggested?: string;
  note: string;
}
export interface OnpageSuggestion {
  url: string;
  basics: {
    title: string;
    metaDescription: string;
    h1: string;
    statusCode: number;
  };
  quality: PageQuality;
  suggestions: OnpageSuggestionItem[];
  words: number;
}

export interface Backlink {
  id: string;
  source_url: string;
  target_url: string;
  first_seen: string;
  last_seen: string;
  status: 'active' | 'lost';
}
export interface GeoCheck {
  id: string;
  query: string;
  platform: string;
  mentioned: boolean | null;
  context_snippet: string | null;
  checked_at: string;
}
export interface GeoScore {
  score: number | null;
  checks: GeoCheck[];
}
export interface Report {
  id: string;
  site_id: string;
  period_start: string;
  period_end: string;
  summary: string;
  highlights: Record<string, unknown> | null;
  created_at: string;
}
export interface Subscription {
  plan_id: string;
  status: string;
  current_period_end: string | null;
}
export interface UsageInfo {
  limits: Record<string, { used: number; limit: number }>;
}
export interface Settings {
  notify_email: string | null;
  telegram_chat_id: string | null;
  llm_provider: string | null;
}

// ---------- Domain helpers ----------

export const authApi = {
  signup: (input: { email: string; password: string; name: string }) =>
    api<AuthResponse>('/api/v1/auth/signup', { method: 'POST', body: input }),
  login: (input: { email: string; password: string }) =>
    api<AuthResponse>('/api/v1/auth/login', { method: 'POST', body: input }),
  logout: () => api<{ ok: boolean }>('/api/v1/auth/logout', { method: 'POST' }),
  me: () => api<{ user: User; tenant: Tenant }>('/api/v1/auth/me'),
};

export const sitesApi = {
  list: () => api<Paged<Site>>('/api/v1/sites'),
  create: (domain: string) =>
    api<Site>('/api/v1/sites', { method: 'POST', body: { domain } }),
  get: (id: string) => api<Site>(`/api/v1/sites/${id}`),
  update: (id: string, body: Partial<Site>) =>
    api<Site>(`/api/v1/sites/${id}`, { method: 'PATCH', body }),
  updateLocation: (id: string, serp_location_code: number) =>
    api<Site>(`/api/v1/sites/${id}`, { method: 'PATCH', body: { serp_location_code } }),
  remove: (id: string) =>
    api<{ ok: boolean }>(`/api/v1/sites/${id}`, { method: 'DELETE' }),
  verify: (id: string, method: 'meta' | 'file' | 'dns') =>
    api<VerifyResult>(`/api/v1/sites/${id}/verify`, {
      method: 'POST',
      body: { method },
    }),
  overview: (id: string) =>
    api<SiteOverview>(`/api/v1/sites/${id}/overview`),
  gscAuthUrl: (id: string) =>
    api<{ url: string }>(`/api/v1/sites/${id}/gsc/auth-url`),
  gscQueries: (id: string) =>
    api<{ data: Array<{ query: string; clicks: number; impressions: number; position: number }> }>(
      `/api/v1/sites/${id}/gsc/queries`,
    ),
};

export interface Ga4Property {
  id: string;
  displayName: string;
}
export interface Ga4Overview {
  sessions: number;
  users: number;
  pageviews: number;
  avgSessionDurationSec: number;
  topPages: Array<{ name: string; sessions: number }>;
  topReferrers: Array<{ name: string; sessions: number }>;
}
export const ga4Api = {
  authUrl: (id: string) =>
    api<{ url: string }>(`/api/v1/sites/${id}/ga4/auth-url`),
  properties: (id: string) =>
    api<{ data: Ga4Property[] }>(`/api/v1/sites/${id}/ga4/properties`),
  connect: (id: string, property_id: string) =>
    api<{ ok: boolean }>(`/api/v1/sites/${id}/ga4/connect`, {
      method: 'POST',
      body: { property_id },
    }),
  overview: (id: string) => api<Ga4Overview>(`/api/v1/sites/${id}/ga4/overview`),
  disconnect: (id: string) =>
    api<{ ok: boolean }>(`/api/v1/sites/${id}/ga4/disconnect`, { method: 'POST' }),
};

export const auditsApi = {
  start: (siteId: string) => api<Audit>(`/api/v1/sites/${siteId}/audits`, { method: 'POST' }),
  list: (siteId: string) => api<Paged<Audit>>(`/api/v1/sites/${siteId}/audits`),
  get: (auditId: string) => api<Audit>(`/api/v1/audits/${auditId}`),
  issues: (auditId: string, params?: { severity?: string; status?: string }) => {
    const q = new URLSearchParams();
    if (params?.severity) q.set('severity', params.severity);
    if (params?.status) q.set('status', params.status);
    const qs = q.toString();
    return api<Paged<AuditIssue>>(`/api/v1/audits/${auditId}/issues${qs ? `?${qs}` : ''}`);
  },
  setIssueStatus: (issueId: string, status: 'open' | 'fixed' | 'ignored') =>
    api<AuditIssue>(`/api/v1/issues/${issueId}`, { method: 'PATCH', body: { status } }),
};

export const keywordsApi = {
  research: (siteId: string, seeds: string[], limit?: number) =>
    api<{ data: Keyword[] }>(`/api/v1/sites/${siteId}/keywords/research`, {
      method: 'POST',
      body: { seeds, limit },
    }),
  list: (siteId: string, tracked?: boolean) =>
    api<Paged<Keyword>>(
      `/api/v1/sites/${siteId}/keywords${tracked !== undefined ? `?tracked=${tracked}` : ''}`,
    ),
  remove: (kwId: string) => api<{ ok: boolean }>(`/api/v1/keywords/${kwId}`, { method: 'DELETE' }),
  track: (kwId: string) => api<Keyword>(`/api/v1/keywords/${kwId}/track`, { method: 'POST' }),
  untrack: (kwId: string) => api<Keyword>(`/api/v1/keywords/${kwId}/untrack`, { method: 'POST' }),
};

export const ranksApi = {
  latest: (siteId: string) => api<{ data: RankEntry[] }>(`/api/v1/sites/${siteId}/ranks`),
  history: (kwId: string, days = 90) =>
    api<{ data: RankHistoryPoint[] }>(`/api/v1/keywords/${kwId}/history?days=${days}`),
  refresh: (siteId: string) =>
    api<{ ok: boolean }>(`/api/v1/sites/${siteId}/ranks/refresh`, { method: 'POST' }),
};

export const contentApi = {
  list: (siteId: string) => api<Paged<ContentPiece>>(`/api/v1/sites/${siteId}/content`),
  create: (siteId: string, input: { keywordId?: string; title: string; tone?: string; length?: string }) =>
    api<ContentPiece>(`/api/v1/sites/${siteId}/content`, { method: 'POST', body: input }),
  get: (id: string) => api<ContentPiece>(`/api/v1/content/${id}`),
  update: (id: string, body: { title?: string; outline?: string; draft?: string }) =>
    api<ContentPiece>(`/api/v1/content/${id}`, { method: 'PATCH', body }),
  generate: (id: string) =>
    api<{ ok: boolean }>(`/api/v1/content/${id}/generate`, { method: 'POST' }),
  approve: (id: string) => api<ContentPiece>(`/api/v1/content/${id}/approve`, { method: 'POST' }),
  exportUrl: (id: string, format: 'html' | 'markdown') =>
    `${BASE_URL}/api/v1/content/${id}/export?format=${format}`,
};

export const onpageApi = {
  analyze: (siteId: string, url: string) =>
    api<OnpageSuggestion>(`/api/v1/sites/${siteId}/onpage/analyze`, {
      method: 'POST',
      body: { url },
    }),
};

export const backlinksApi = {
  list: (siteId: string, status?: string) =>
    api<Paged<Backlink>>(
      `/api/v1/sites/${siteId}/backlinks${status ? `?status=${status}` : ''}`,
    ),
  refresh: (siteId: string) =>
    api<{ ok: boolean }>(`/api/v1/sites/${siteId}/backlinks/refresh`, { method: 'POST' }),
  upload: (siteId: string, csv: string) =>
    api<{ ok: boolean; imported: number }>(`/api/v1/sites/${siteId}/backlinks/upload`, {
      method: 'POST',
      body: { csv },
    }),
};

export const geoApi = {
  score: (siteId: string) => api<GeoScore>(`/api/v1/sites/${siteId}/geo`),
  check: (siteId: string, input: { query: string; platforms?: string[] }) =>
    api<{ ok: boolean }>(`/api/v1/sites/${siteId}/geo/check`, {
      method: 'POST',
      body: input,
    }),
};

export const reportsApi = {
  list: (siteId: string) => api<Paged<Report>>(`/api/v1/sites/${siteId}/reports`),
  get: (id: string) => api<Report>(`/api/v1/reports/${id}`),
  generate: (siteId: string) =>
    api<{ ok: boolean }>(`/api/v1/sites/${siteId}/reports/generate`, { method: 'POST' }),
};

export const billingApi = {
  subscription: () => api<Subscription>('/api/v1/billing/subscription'),
  checkout: (planId: string) =>
    api<{ url: string }>('/api/v1/billing/checkout', {
      method: 'POST',
      body: { planId },
    }),
  portal: () => api<{ url: string }>('/api/v1/billing/portal', { method: 'POST' }),
};

export const settingsApi = {
  get: () => api<Settings>('/api/v1/settings'),
  update: (body: {
    notify_email?: string;
    telegram_chat_id?: string;
    llm_provider?: string;
    llm_api_key?: string;
  }) => api<Settings>('/api/v1/settings', { method: 'PATCH', body }),
  usage: () => api<UsageInfo>('/api/v1/usage'),
};

export const PLAN_NAMES: Record<string, string> = {
  starter: 'Starter',
  growth: 'Growth',
  pro: 'Pro',
};
