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
  path?: string;
}

export class ApiError extends Error {
  code: string;
  upgrade?: boolean;
  used?: number;
  limit?: number;
  status: number;
  path?: string;
  constructor(shape: ApiErrorShape) {
    super(shape.message);
    this.code = shape.code;
    this.upgrade = shape.upgrade;
    this.used = shape.used;
    this.limit = shape.limit;
    this.status = shape.status;
    this.path = shape.path;
  }
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
    // FIX (Oct 2026, bug #3): only send Content-Type when there is a body.
    // Sending `Content-Type: application/json` with an empty body makes
    // Fastify reject the request with FST_ERR_CTP_EMPTY_JSON_BODY, which
    // broke every bodyless POST (audit start, logout, track/untrack, ...).
    const headers: Record<string, string> = { ...csrfHeader() };
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    res = await fetch(`${BASE_URL}${path}`, {
      method: opts.method || 'GET',
      credentials: 'include',
      headers,
      body,
    });
  } catch {
    throw new ApiError({
      code: 'NETWORK_ERROR',
      message: "We couldn't reach the server. Check your connection and try again.",
      status: 0,
      path,
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
      path,
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
  /** Present on signup/login/me responses (S-01 email verification). */
  emailVerified?: boolean;
}
export interface Tenant {
  id: string;
  name: string;
  plan_id: string;
}
// JWT-in-body fix (backend): the session JWT is delivered ONLY via the
// httpOnly `bseo_token` cookie set by the API — never in a JSON response
// body. The frontend never reads the body token (cookie auth via
// credentials:'include'), so it is not part of this type.
export interface AuthResponse {
  user: User;
  tenant: Tenant;
}
/**
 * S-05: password login returns this instead of a session when 2FA is
 * enabled. The short-lived totpToken can only be exchanged for a session
 * at POST /api/v1/auth/totp/verify — it is NOT a session JWT and must not
 * be stored (it lives only in page state until the URL is scrubbed).
 */
export interface TotpChallenge {
  totpRequired: true;
  totpToken: string;
}
/** S-05: POST /api/v1/auth/totp/verify response. Session JWT arrives only
 * via the httpOnly cookie — never in this body. */
export interface TotpVerifyResponse {
  user: { id: string; email: string; name: string | null; emailVerified: boolean };
  tenant: { id: string; name: string; plan_id: string };
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
  // F-02 (wired): backend enum is open|ignored|resolved|wont-fix
  // (migration-era 'fixed' is REJECTED by validation — see bb-f02 tests).
  status: 'open' | 'ignored' | 'resolved' | 'wont-fix';
  impact?: number;
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

/**
 * A3-M1/M2: provenance of provider-backed numbers. The backend returns
 * `dataSource: 'mock' | 'real'` on ranks/keywords research/expand/import;
 * the frontend must surface it so seeded mock data is never presented as
 * measured. Optional on responses whose endpoint never returns it.
 */
export type DataSource = 'mock' | 'real';

export interface ContentPiece {
  id: string;
  site_id: string;
  keyword_id: string | null;
  title: string;
  outline: string | null;
  draft: string | null;
  // F-04 (wired): backend workflow statuses (services/contentWorkflow.ts).
  status: 'brief' | 'outline' | 'draft' | 'review' | 'changes_requested' | 'approved' | 'published';
  brief?: string | null;
  tone?: string | null;
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
  sentiment?: string | null;
  citations?: unknown;
  simulated?: boolean;
  engine_version?: string | null;
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
  sections?: string[] | null;
  branding?: TenantBranding | null;
  created_at: string;
}
/**
 * F-11 (wired, Wave 2): real GET /api/v1/billing/subscription shape
 * (backend/src/routes/billing.ts). When the tenant has no subscription
 * row the API returns only { plan_id, status: 'none', read_only }.
 */
export interface Subscription {
  plan_id: string;
  status: string; // active|trialing|past_due|incomplete|canceled|mock|none
  stripe_sub_id?: string | null;
  current_period_start?: string | null;
  current_period_end?: string | null;
  trial_ends_at?: string | null;
  cancel_at_period_end?: boolean;
  billing_interval?: 'monthly' | 'annual' | null;
  coupon_code?: string | null;
  grace_until?: string | null;
  read_only?: boolean;
  /** E3-MED-1: server-side trial expiry (tenants.trial_ends_at), for the trial countdown. */
  tenant_trial_ends_at?: string | null;
}
/**
 * F-11 (wired, Wave 2): real invoice ledger row from
 * GET /api/v1/billing/invoices (backend migration 010 + routes/billing.ts).
 * Amounts are minor units (cents) in `amount_due_cents`; the human-facing
 * invoice link is `hosted_invoice_url` (Stripe-hosted page, may be null
 * for mock-provider invoices).
 */
export interface Invoice {
  id: string;
  stripe_invoice_id: string | null;
  amount_due_cents: number;
  currency: string;
  status: 'paid' | 'open' | 'failed' | 'refunded' | 'void';
  period_start: string | null;
  period_end: string | null;
  hosted_invoice_url: string | null;
  created_at: string;
}
export interface UsageInfo {
  limits: Record<string, { used: number; limit: number }>;
}
/** Real GET /api/v1/settings shape (backend/src/routes/settings.ts). */
export interface Settings {
  name: string;
  plan_id: string;
  notify_email: string | null;
  telegram_chat_id: string | null;
  llm_provider: string | null;
  llm_key_set: boolean;
}

// ---------- Domain helpers ----------

export const authApi = {
  signup: (input: { email: string; password: string; name: string }) =>
    api<AuthResponse>('/api/v1/auth/signup', { method: 'POST', body: input }),
  login: (input: { email: string; password: string }) =>
    api<AuthResponse | TotpChallenge>('/api/v1/auth/login', { method: 'POST', body: input }),
  /**
   * S-05: exchanges the short-lived 2FA challenge token (+ TOTP code) for a
   * full session. Public — the totpToken is the auth. The session JWT is
   * delivered ONLY via the httpOnly cookie, never in the response body.
   */
  verifyTotp: (input: { totpToken: string; code: string }) =>
    api<TotpVerifyResponse>('/api/v1/auth/totp/verify', { method: 'POST', body: input }),
  logout: () => api<{ ok: boolean }>('/api/v1/auth/logout', { method: 'POST' }),
  /**
   * Real GET /api/v1/auth/me shape: { user, tenant, plan }. NOTE: the API
   * does NOT expose the caller's team role or platform-admin flag here —
   * admin UI must probe the /admin endpoints themselves (404 for
   * non-admins) instead of trusting a client-side role field.
   */
  me: () =>
    api<{ user: User; tenant: Tenant; plan: Record<string, unknown> }>('/api/v1/auth/me'),
  // ---------- Account security (G3-M-1) ----------
  /**
   * S-05: TOTP setup — generates a fresh (not yet enabled) secret. Returns
   * the base32 secret + otpauth:// URL for the QR step. Throws ApiError with
   * code TOTP_ALREADY_ENABLED when 2FA is already on — used as the
   * "is 2FA enabled?" probe (no dedicated status endpoint exists).
   */
  totpSetup: () =>
    api<{ secret: string; otpauthUrl: string }>('/api/v1/auth/totp/setup', {
      method: 'POST',
    }),
  /**
   * S-05: verifies the 6-digit code against the pending secret, enables 2FA
   * and returns one-time backup codes (shown ONCE — store the hashes only).
   * Throws INVALID_CODE when the code doesn't match.
   */
  totpEnable: (code: string) =>
    api<{ ok: boolean; backupCodes: string[] }>('/api/v1/auth/totp/enable', {
      method: 'POST',
      body: { code },
    }),
  /**
   * S-05: disables 2FA. Requires the account password (INVALID_CREDENTIALS
   * when it doesn't match).
   */
  totpDisable: (password: string) =>
    api<{ ok: boolean }>('/api/v1/auth/totp/disable', { method: 'POST', body: { password } }),
  /**
   * S-05: changes the password. Requires the current password; revokes ALL
   * sessions (including the caller's) — the UI must send the user back to
   * the login page afterwards.
   */
  changePassword: (currentPassword: string, newPassword: string) =>
    api<{ ok: boolean }>('/api/v1/auth/password/change', {
      method: 'POST',
      body: { currentPassword, newPassword },
    }),
  /**
   * S-05: requests a password-reset email. ALWAYS resolves (the backend
   * returns success even for unknown emails) — the UI must never reveal
   * whether the address is registered.
   */
  requestPasswordReset: (email: string) =>
    api<{ ok: boolean }>('/api/v1/auth/password/reset-request', {
      method: 'POST',
      body: { email },
    }),
  /**
   * S-05: consumes a reset token and sets the new password. Throws
   * INVALID_TOKEN when the link is invalid/expired. All sessions revoked.
   */
  resetPassword: (token: string, password: string) =>
    api<{ ok: boolean }>('/api/v1/auth/password/reset', {
      method: 'POST',
      body: { token, password },
    }),
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
  setIssueStatus: (issueId: string, status: 'open' | 'ignored' | 'resolved' | 'wont-fix') =>
    api<AuditIssue>(`/api/v1/issues/${issueId}`, { method: 'PATCH', body: { status } }),
};

export const keywordsApi = {
  // C3-L2: the backend research schema accepts only { seeds } — there is no
  // `limit` option, so none is offered here.
  research: (siteId: string, seeds: string[]) =>
    api<{ data: Keyword[]; total: number; dataSource?: DataSource }>(
      `/api/v1/sites/${siteId}/keywords/research`,
      {
        method: 'POST',
        body: { seeds },
      },
    ),
  list: (siteId: string, tracked?: boolean) =>
    api<Paged<Keyword>>(
      `/api/v1/sites/${siteId}/keywords${tracked !== undefined ? `?tracked=${tracked}` : ''}`,
    ),
  remove: (kwId: string) => api<{ ok: boolean }>(`/api/v1/keywords/${kwId}`, { method: 'DELETE' }),
  track: (kwId: string) => api<Keyword>(`/api/v1/keywords/${kwId}/track`, { method: 'POST' }),
  untrack: (kwId: string) => api<Keyword>(`/api/v1/keywords/${kwId}/untrack`, { method: 'POST' }),
};

export const ranksApi = {
  // A3-M1: backend returns dataSource 'mock'|'real' on this endpoint.
  latest: (siteId: string) =>
    api<{ data: RankEntry[]; dataSource?: DataSource }>(`/api/v1/sites/${siteId}/ranks`),
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
  exportUrl: (id: string, format: 'html' | 'markdown' | 'docx') =>
    `${BASE_URL}/api/v1/content/${encodeURIComponent(id)}/export?format=${format}`,
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

// Autopilot v2.0
export interface WpStatus {
  connected: boolean;
  site_url?: string;
  seo_plugin?: string;
  status?: string;
  mode?: 'copilot' | 'autopilot';
  enabled?: boolean;
}
export interface AutopilotProposal {
  id: string;
  change_type: string;
  field_key: string;
  wp_post_id: number;
  page_url: string;
  previous_value: string | null;
  proposed_value: string;
  reason: string;
  status: string;
  created_at: string;
}
export interface SiteChange {
  id: string;
  wp_post_id: number;
  change_type: string;
  field_key: string;
  previous_value: string | null;
  new_value: string | null;
  page_url: string;
  status: string;
  mode: string;
  created_at: string;
  applied_at: string | null;
  reverted_at: string | null;
}

export const autopilotApi = {
  status: (siteId: string) => api<WpStatus>(`/api/v1/sites/${siteId}/wp-status`),
  connect: (siteId: string, input: { siteUrl: string; username: string; appPassword: string }) =>
    api<{ ok: boolean; seoPlugin: string }>(`/api/v1/sites/${siteId}/wp-connect`, {
      method: 'POST',
      body: input,
    }),
  settings: (siteId: string, input: { mode?: 'copilot' | 'autopilot'; enabled?: boolean }) =>
    api<WpStatus>(`/api/v1/sites/${siteId}/autopilot/settings`, { method: 'PUT', body: input }),
  scan: (siteId: string) =>
    api<{ scanned: number; proposals: number; autoApplied: number; mode: string }>(
      `/api/v1/sites/${siteId}/autopilot/scan`,
      { method: 'POST' },
    ),
  proposals: (siteId: string) =>
    api<{ data: AutopilotProposal[] }>(`/api/v1/sites/${siteId}/autopilot/proposals`),
  approve: (siteId: string, proposalId: string) =>
    api<{ ok: boolean }>(`/api/v1/sites/${siteId}/autopilot/proposals/${proposalId}/approve`, {
      method: 'POST',
    }),
  reject: (siteId: string, proposalId: string) =>
    api<{ ok: boolean }>(`/api/v1/sites/${siteId}/autopilot/proposals/${proposalId}/reject`, {
      method: 'POST',
    }),
  history: (siteId: string) =>
    api<{ data: SiteChange[] }>(`/api/v1/sites/${siteId}/autopilot/history`),
  revert: (siteId: string, changeId: string) =>
    api<{ ok: boolean }>(`/api/v1/sites/${siteId}/autopilot/changes/${changeId}/revert`, {
      method: 'POST',
    }),
};

export interface CheckoutOptions {
  /** Billing cadence; backend defaults to 'monthly' when omitted. */
  interval?: 'monthly' | 'annual';
  /** Coupon code from the billing_coupons catalog (validated server-side). */
  couponCode?: string;
  // NOTE (C3-L1): trial length is server-side plan config — the backend
  // checkout schema has additionalProperties: false and REJECTS trialDays.
  // There is intentionally no trialDays option here.
}

export const billingApi = {
  subscription: () => api<Subscription>('/api/v1/billing/subscription'),
  /**
   * F-11 (wired, Wave 2): real checkout schema is
   * { planId, interval?, couponCode? }
   * (backend/src/routes/billing.ts, additionalProperties: false — field
   * names must match exactly; the coupon field is `couponCode`, not
   * `coupon`. Trial length is server-side plan config and must NOT be
   * sent — the backend 400s any extra property.) Returns the Stripe
   * (or mock) checkout URL to redirect to.
   */
  checkout: (planId: string, opts: CheckoutOptions = {}) =>
    api<{ url: string }>('/api/v1/billing/checkout', {
      method: 'POST',
      body: {
        planId,
        ...(opts.interval ? { interval: opts.interval } : {}),
        ...(opts.couponCode ? { couponCode: opts.couponCode } : {}),
      },
    }),
  portal: () => api<{ url: string }>('/api/v1/billing/portal', { method: 'POST' }),
  /** F-11 (wired): paged invoice ledger. */
  invoices: (page = 1, limit = 20) =>
    api<Paged<Invoice>>(`/api/v1/billing/invoices?page=${page}&limit=${limit}`),
  // NOTE (shape discrepancy flagged for LA): the backend has NO dedicated
  // billing-email endpoint (PATCH /api/v1/billing/email does not exist) and
  // NO DELETE /api/v1/billing/subscription cancellation endpoint.
  // Receipts/dunning are sent to the tenant's notify_email (see
  // backend/src/services/billing.ts), so the billing page edits that field
  // via settingsApi. Cancellation happens in the Stripe customer portal
  // (portal() above), which sets cancel_at_period_end via webhook.
};

export const settingsApi = {
  get: () => api<Settings>('/api/v1/settings'),
  /** Backend schema accepts explicit null to clear notify_email /
   *  telegram_chat_id / llm_provider. */
  update: (body: {
    name?: string;
    notify_email?: string | null;
    telegram_chat_id?: string | null;
    llm_provider?: string | null;
    llm_api_key?: string;
  }) => api<Settings>('/api/v1/settings', { method: 'PATCH', body }),
  usage: () => api<UsageInfo>('/api/v1/usage'),
};

export const PLAN_NAMES: Record<string, string> = {
  starter: 'Starter',
  growth: 'Growth',
  pro: 'Pro',
};

// ===========================================================================
// Wave 2 wiring (Frontend Lead): F-09 team, F-10 notifications/webhooks,
// F-13 API keys, F-14 admin. All shapes below are read from the merged
// backend route files on main (routes/account.ts, routes/webhooks.ts,
// routes/apikeys.ts, routes/admin.ts) — not from the earlier mock adapters.
// ===========================================================================

// ---------- F-09: team, invitations, workspaces, activity ----------

export type TeamRole = 'owner' | 'admin' | 'editor' | 'viewer';

/** GET /api/v1/account/members row (users table projection). */
export interface TeamMember {
  id: string;
  email: string;
  name: string | null;
  role: TeamRole;
  created_at: string;
}

/** GET /api/v1/account/invitations row (token_hash is never returned). */
export interface Invitation {
  id: string;
  email: string;
  role: Exclude<TeamRole, 'owner'>;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/**
 * POST /api/v1/account/invitations — ALWAYS 202 with this generic body
 * (anti-enumeration). The debug fields (id/email/role/expires_at/token)
 * are present ONLY when mail runs in mock mode / non-production; with
 * real SMTP the token travels by email only and these are absent.
 */
export interface InviteCreated {
  ok: true;
  message: string;
  id?: string;
  email?: string;
  role?: string;
  expires_at?: string;
  token?: string;
}

/** POST /api/v1/account/invitations/accept response. The fresh session token
 *  is set via httpOnly cookie only — the browser-facing contract MUST NOT
 *  include it in the body (D3-M-1). `token?: never` so no future caller can
 *  adopt the insecure JWT-in-body pattern. */
export interface InviteAccepted {
  ok: true;
  tenantId: string;
  role: string;
  token?: never;
}

/** GET /api/v1/account/workspaces row (sites = live site count). */
export interface Workspace {
  id: string;
  name: string;
  limits: Record<string, number> | null;
  created_at: string;
  sites?: number;
}

/** GET /api/v1/account/activity row. */
export interface ActivityEntry {
  id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  user_email: string | null;
  workspace_name: string | null;
}

export const teamApi = {
  members: () => api<{ data: TeamMember[] }>('/api/v1/account/members'),
  updateRole: (memberId: string, role: Exclude<TeamRole, 'owner'>) =>
    api<{ ok: boolean }>(`/api/v1/account/members/${memberId}`, {
      method: 'PATCH',
      body: { role },
    }),
  removeMember: (memberId: string) =>
    api<{ ok: boolean }>(`/api/v1/account/members/${memberId}`, { method: 'DELETE' }),
  invitations: () => api<{ data: Invitation[] }>('/api/v1/account/invitations'),
  invite: (email: string, role: Exclude<TeamRole, 'owner'>) =>
    api<InviteCreated>('/api/v1/account/invitations', {
      method: 'POST',
      body: { email, role },
    }),
  revokeInvitation: (id: string) =>
    api<{ ok: boolean }>(`/api/v1/account/invitations/${id}`, { method: 'DELETE' }),
  acceptInvitation: (token: string) =>
    api<InviteAccepted>('/api/v1/account/invitations/accept', {
      method: 'POST',
      body: { token },
    }),
  activity: (page = 1, limit = 20) =>
    api<Paged<ActivityEntry>>(`/api/v1/account/activity?page=${page}&limit=${limit}`),
};

export const workspacesApi = {
  list: (page = 1, limit = 50) =>
    api<Paged<Workspace>>(`/api/v1/account/workspaces?page=${page}&limit=${limit}`),
  create: (name: string, limits?: Record<string, number>) =>
    api<Workspace>('/api/v1/account/workspaces', {
      method: 'POST',
      body: { name, ...(limits ? { limits } : {}) },
    }),
  /** Backend PATCH reuses the create schema: `name` is always required. */
  update: (id: string, name: string, limits?: Record<string, number> | null) =>
    api<Workspace>(`/api/v1/account/workspaces/${id}`, {
      method: 'PATCH',
      body: { name, ...(limits ? { limits } : {}) },
    }),
  remove: (id: string) =>
    api<{ ok: boolean }>(`/api/v1/account/workspaces/${id}`, { method: 'DELETE' }),
  assignSite: (id: string, siteId: string) =>
    api<{ ok: boolean }>(`/api/v1/account/workspaces/${id}/sites`, {
      method: 'POST',
      body: { siteId },
    }),
  unassignSite: (id: string, siteId: string) =>
    api<{ ok: boolean }>(`/api/v1/account/workspaces/${id}/sites/${siteId}`, {
      method: 'DELETE',
    }),
};

// ---------- F-01: onboarding state (backend is the source of truth) ----------

/** Backend step keys (routes/account.ts ONBOARDING_STEPS). */
export type OnboardingStepKey =
  | 'verify_site'
  | 'connect_gsc'
  | 'first_crawl'
  | 'add_keywords'
  | 'first_report';

/** GET /api/v1/account/sites/:siteId/onboarding response. */
export interface OnboardingState {
  siteId: string;
  steps: Array<{
    step: OnboardingStepKey;
    completed: boolean;
    completed_at: string | null;
  }>;
}

export const onboardingApi = {
  get: (siteId: string) =>
    api<OnboardingState>(`/api/v1/account/sites/${siteId}/onboarding`),
  setStep: (siteId: string, step: OnboardingStepKey, completed: boolean) =>
    api<{ step: OnboardingStepKey; completed: boolean; completed_at: string | null }>(
      `/api/v1/account/sites/${siteId}/onboarding`,
      { method: 'PUT', body: { step, completed } },
    ),
};

// ---------- F-10: alert rules, digests, notification log, webhooks ----------

export type AlertRuleType = 'rank_drop' | 'critical_issue' | 'site_down' | 'limit_near';
export type NotifyChannel = 'email' | 'telegram' | 'slack' | 'webhook' | 'inapp';

/** GET /api/v1/account/alert-rules row (notification_rules projection). */
export interface AlertRule {
  id: string;
  rule_type: AlertRuleType;
  channels: NotifyChannel[];
  config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
}

/** GET/PUT /api/v1/account/digest shape. frequency 'off' disables digests. */
export interface DigestSettings {
  frequency: 'daily' | 'weekly' | 'off';
  channels: string[];
  last_sent_at: string | null;
}

/** GET /api/v1/account/notifications row (notification_log projection).
 *  There is no read/unread flag in the backend — this is a delivery log. */
export interface NotificationLogEntry {
  id: string;
  notification_type: string;
  channel: string;
  status: string; // sent|failed|skipped
  detail: string | null;
  created_at: string;
}

export const notificationsApi = {
  rules: () => api<{ data: AlertRule[] }>('/api/v1/account/alert-rules'),
  /** POST upserts on (tenant, user, rule_type) — one rule per type. */
  upsertRule: (input: {
    ruleType: AlertRuleType;
    channels: NotifyChannel[];
    config?: Record<string, unknown>;
    enabled?: boolean;
  }) => api<AlertRule>('/api/v1/account/alert-rules', { method: 'POST', body: input }),
  deleteRule: (id: string) =>
    api<{ ok: boolean }>(`/api/v1/account/alert-rules/${id}`, { method: 'DELETE' }),
  digest: () => api<DigestSettings>('/api/v1/account/digest'),
  updateDigest: (input: { frequency: DigestSettings['frequency']; channels?: string[] }) =>
    api<DigestSettings>('/api/v1/account/digest', { method: 'PUT', body: input }),
  log: (page = 1, limit = 20) =>
    api<Paged<NotificationLogEntry>>(
      `/api/v1/account/notifications?page=${page}&limit=${limit}`,
    ),
};

/** GET /api/v1/webhooks row (the signing secret is never listed). */
export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  created_at: string;
}

/** POST /api/v1/webhooks response — `secret` is shown exactly once. */
export interface WebhookCreated {
  id: string;
  url: string;
  events: string[];
  secret: string;
}

/** GET /api/v1/webhooks/deliveries row. */
export interface WebhookDelivery {
  id: string;
  event: string;
  status: string; // pending|delivered|failed
  attempts: number;
  last_error: string | null;
  last_status_code: number | null;
  created_at: string;
  delivered_at: string | null;
  endpoint_url: string;
}

export const webhooksApi = {
  eventCatalog: () => api<{ events: string[] }>('/api/v1/webhooks/events'),
  list: () => api<{ data: WebhookEndpoint[] }>('/api/v1/webhooks'),
  create: (url: string, events: string[]) =>
    api<WebhookCreated>('/api/v1/webhooks', { method: 'POST', body: { url, events } }),
  remove: (id: string) =>
    api<{ ok: boolean }>(`/api/v1/webhooks/${id}`, { method: 'DELETE' }),
  test: (id: string) =>
    api<{ ok: boolean }>(`/api/v1/webhooks/${id}/test`, { method: 'POST' }),
  deliveries: (page = 1, limit = 20) =>
    api<Paged<WebhookDelivery>>(`/api/v1/webhooks/deliveries?page=${page}&limit=${limit}`),
  replay: (deliveryId: string) =>
    api<{ ok: boolean }>(`/api/v1/webhooks/deliveries/${deliveryId}/replay`, {
      method: 'POST',
    }),
};

// ---------- F-13: public API keys ----------

/** GET /api/v1/apikeys row (only the hash is stored; prefix is display-only). */
export interface ApiKeyRecord {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  rate_limit_per_min: number;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

/** POST /api/v1/apikeys response — `key` is the raw secret, shown once. */
export interface ApiKeyCreated {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  rate_limit_per_min: number;
  created_at: string;
  key: string;
}

export const apiKeysApi = {
  /** Full server scope catalog (includes 'admin', which the UI must
   *  filter out — the backend rejects it with 400 SCOPE_NOT_ALLOWED). */
  scopes: () => api<{ scopes: string[] }>('/api/v1/apikeys/scopes'),
  list: (page = 1, limit = 50) =>
    api<Paged<ApiKeyRecord>>(`/api/v1/apikeys?page=${page}&limit=${limit}`),
  create: (input: { name: string; scopes: string[]; rateLimitPerMin?: number }) =>
    api<ApiKeyCreated>('/api/v1/apikeys', { method: 'POST', body: input }),
  /** Soft-revoke: the key stops working immediately; the row is kept. */
  revoke: (id: string) =>
    api<{ ok: boolean }>(`/api/v1/apikeys/${id}`, { method: 'DELETE' }),
};

// ---------- F-14: admin back-office ----------

/** GET /api/v1/admin/tenants row. Status is derived: suspended_at set ⇒
 *  suspended; otherwise the subscription status (sub_status) applies. */
export interface AdminTenant {
  id: string;
  name: string;
  plan_id: string;
  read_only: boolean;
  suspended_at: string | null;
  created_at: string;
  sub_status: string | null;
  current_period_end: string | null;
  users: number;
  sites: number;
}

/** GET /api/v1/admin/tenants/:id — tenant row plus users/spend/credits. */
export interface AdminTenantDetail {
  id: string;
  name: string;
  plan_id: string;
  read_only: boolean;
  suspended_at: string | null;
  suspended_reason: string | null;
  stripe_customer_id: string | null;
  created_at: string;
  sub_status: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  grace_until: string | null;
  billing_interval: string | null;
  coupon_code: string | null;
  users: Array<{
    id: string;
    email: string;
    name: string | null;
    role: string;
    created_at: string;
  }>;
  spend: Array<{ provider: string; units: number; cost_cents: number }>;
  credits_cents: number;
  [key: string]: unknown;
}

/** GET /api/v1/admin/jobs/failed row (dead_letter_jobs + tenant name). */
export interface AdminFailedJob {
  id: string;
  queue: string;
  job_name: string;
  tenant_id: string | null;
  payload: Record<string, unknown> | null;
  attempts: number;
  error: string | null;
  status: string; // pending|replayed|discarded
  failed_at: string;
  tenant_name: string | null;
}

/** GET /api/v1/admin/spend row + per-provider totals. */
export interface AdminSpendRow {
  tenant_id: string;
  tenant_name: string;
  provider: string;
  units: number;
  cost_cents: number;
  last_spend_at: string;
}
export interface AdminSpendTotal {
  provider: string;
  units: number;
  cost_cents: number;
}

/** GET /api/v1/admin/feature-flags row (no rollout % in the backend). */
export interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string | null;
  updated_at: string;
}

/** GET /api/v1/admin/audit-log row. */
export interface AdminAuditEntry {
  id: string;
  action: string;
  target_tenant_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  actor_email: string | null;
}

export const adminApi = {
  tenants: (page = 1, limit = 20, search = '') =>
    api<Paged<AdminTenant>>(
      `/api/v1/admin/tenants?page=${page}&limit=${limit}${search ? `&search=${encodeURIComponent(search)}` : ''}`,
    ),
  tenant: (id: string) => api<AdminTenantDetail>(`/api/v1/admin/tenants/${id}`),
  suspend: (id: string, reason: string) =>
    api<{ ok: boolean }>(`/api/v1/admin/tenants/${id}/suspend`, {
      method: 'POST',
      body: { reason },
    }),
  unsuspend: (id: string) =>
    api<{ ok: boolean }>(`/api/v1/admin/tenants/${id}/unsuspend`, { method: 'POST' }),
  planOverride: (id: string, planId: string, reason: string) =>
    api<{ ok: boolean; planId: string }>(`/api/v1/admin/tenants/${id}/plan`, {
      method: 'POST',
      body: { planId, reason },
    }),
  credit: (id: string, amountCents: number, reason: string) =>
    api<{ id: string; amount_cents: number; reason: string; created_at: string }>(
      `/api/v1/admin/tenants/${id}/credit`,
      { method: 'POST', body: { amountCents, reason } },
    ),
  // SEC-REVIEW (Wave-4): the old impersonate() helper returned the raw JWT
  // to JS, which led to the document.cookie anti-pattern (A3-H1). It is
  // intentionally removed — impersonation now goes through the same-origin
  // route /api/admin/impersonate, which sets the session via HttpOnly
  // Set-Cookie. Do not re-add a JSON-token impersonate helper.
  failedJobs: (page = 1, limit = 20, status?: string) =>
    api<Paged<AdminFailedJob>>(
      `/api/v1/admin/jobs/failed?page=${page}&limit=${limit}${status ? `&status=${status}` : ''}`,
    ),
  replayJob: (id: string) =>
    api<{ ok: boolean }>(`/api/v1/admin/jobs/failed/${id}/replay`, { method: 'POST' }),
  discardJob: (id: string) =>
    api<{ ok: boolean }>(`/api/v1/admin/jobs/failed/${id}/discard`, { method: 'POST' }),
  spend: (page = 1, limit = 20) =>
    api<Paged<AdminSpendRow> & { totals: AdminSpendTotal[] }>(
      `/api/v1/admin/spend?page=${page}&limit=${limit}`,
    ),
  featureFlags: () => api<{ data: FeatureFlag[] }>('/api/v1/admin/feature-flags'),
  setFlag: (key: string, enabled: boolean, description?: string) =>
    api<FeatureFlag>(`/api/v1/admin/feature-flags/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: { enabled, ...(description !== undefined ? { description } : {}) },
    }),
  auditLog: (page = 1, limit = 20) =>
    api<Paged<AdminAuditEntry>>(`/api/v1/admin/audit-log?page=${page}&limit=${limit}`),
};

// ===========================================================================
// Wave 2 wiring round 2 (Frontend Lead): F-02..F-08 backends (Backend-B,
// merged to main). All shapes below are read from the merged backend route
// files (routes/audit.ts, keywords.ts, content.ts, geo.ts, backlinks.ts,
// competitors.ts, reports.ts) and their services — not from mock adapters.
// ===========================================================================

// ---------- shared: share links (F-02 audits / F-08 reports) ----------

/** GET .../shares row — id/timestamps ONLY; the token/hash is never listed. */
export interface ShareLink {
  id: string;
  resource_type: string;
  resource_id: string;
  created_at: string;
  expires_at: string;
}

/** POST .../share response (201) — the raw token is shown exactly once. */
export interface ShareCreated {
  url: string;
  token: string;
  expires_at: string;
}

// ---------- F-02: audit v2 ----------

export interface AuditGroup {
  type: string;
  severity: string;
  count: number;
  total_impact: number;
  fix_suggestion: string;
  urls: string[];
}

export interface AuditDiff {
  prev_audit_id: string | null;
  new_issues: number;
  resolved_issues: number;
  new_errors: number;
  by_type: Record<string, { new: number; resolved: number }>;
  created_at: string;
}

export type AuditIssueStatus = 'open' | 'ignored' | 'resolved' | 'wont-fix';

export const auditsV2Api = {
  groups: (auditId: string, status?: AuditIssueStatus) =>
    api<{ data: AuditGroup[] }>(
      `/api/v1/audits/${auditId}/groups${status ? `?status=${status}` : ''}`,
    ),
  diff: (auditId: string) => api<{ diff: AuditDiff | null }>(`/api/v1/audits/${auditId}/diff`),
  createShare: (auditId: string, expiresInDays = 30) =>
    api<ShareCreated>(`/api/v1/audits/${auditId}/share`, {
      method: 'POST',
      body: { expiresInDays },
    }),
  listShares: (auditId: string) =>
    api<{ data: ShareLink[] }>(`/api/v1/audits/${auditId}/shares`),
  revokeShare: (auditId: string, tokenId: string) =>
    api<null>(`/api/v1/audits/${auditId}/shares/${tokenId}`, { method: 'DELETE' }),
  exportUrl: (auditId: string, format: 'pdf' | 'csv') =>
    `${BASE_URL}/api/v1/audits/${encodeURIComponent(auditId)}/export?format=${format}`,
};

// ---------- F-03: keywords v2 ----------

export interface KeywordCluster {
  group_key: string;
  keywords: string[];
  intents: Record<string, number>;
  total_volume: number;
  avg_difficulty: number | null;
}

export interface CannibalizationHit {
  kind: 'same-url-multiple-keywords' | 'multiple-urls-one-keyword';
  keyword: string;
  keyword_id: string;
  urls: string[];
  detail: string;
}

/** GET /keywords/gap — dataSource honestly labels mock-provider data. */
export interface KeywordGapResult {
  gaps: Array<{
    keyword: string;
    competitor_position: number;
    competitor_url: string;
    volume: number | null;
    difficulty: number | null;
  }>;
  dataSource: 'mock' | 'real';
  fetchedAt: string;
}

export interface KeywordList {
  id: string;
  site_id: string;
  name: string;
  tags: string[];
  members?: number;
  created_at: string;
}

export const keywordsV2Api = {
  expand: (siteId: string, seeds: string[]) =>
    api<{ data: Keyword[]; total: number }>(`/api/v1/sites/${siteId}/keywords/expand`, {
      method: 'POST',
      body: { seeds },
    }),
  clusters: (siteId: string) =>
    api<{ data: KeywordCluster[] }>(`/api/v1/sites/${siteId}/keywords/clusters`),
  questions: (siteId: string) =>
    api<{ data: Keyword[]; total: number }>(`/api/v1/sites/${siteId}/keywords/questions`),
  cannibalization: (siteId: string) =>
    api<{ data: CannibalizationHit[]; total: number }>(
      `/api/v1/sites/${siteId}/keywords/cannibalization`,
    ),
  gap: (siteId: string, competitor: string) =>
    api<KeywordGapResult>(
      `/api/v1/sites/${siteId}/keywords/gap?competitor=${encodeURIComponent(competitor)}`,
    ),
  importCsv: (siteId: string, csv: string) =>
    api<{ imported: number; skipped: number }>(`/api/v1/sites/${siteId}/keywords/import`, {
      method: 'POST',
      body: { csv },
    }),
  exportUrl: (siteId: string) => `${BASE_URL}/api/v1/sites/${encodeURIComponent(siteId)}/keywords/export`,
  lists: (siteId: string) => api<{ data: KeywordList[] }>(`/api/v1/sites/${siteId}/keyword-lists`),
  createList: (siteId: string, name: string, tags: string[]) =>
    api<{ list: KeywordList; existed?: boolean }>(`/api/v1/sites/${siteId}/keyword-lists`, {
      method: 'POST',
      body: { name, tags },
    }),
  updateList: (listId: string, body: { name?: string; tags?: string[] }) =>
    api<{ list: KeywordList }>(`/api/v1/keyword-lists/${listId}`, { method: 'PATCH', body }),
  deleteList: (listId: string) =>
    api<{ deleted: boolean }>(`/api/v1/keyword-lists/${listId}`, { method: 'DELETE' }),
  listMembers: (listId: string) =>
    api<{ data: Keyword[]; total: number }>(`/api/v1/keyword-lists/${listId}/keywords`),
  addMembers: (listId: string, keywordIds: string[]) =>
    api<{ added: number }>(`/api/v1/keyword-lists/${listId}/keywords`, {
      method: 'POST',
      body: { keywordIds },
    }),
  removeMember: (listId: string, kwId: string) =>
    api<{ deleted: boolean }>(`/api/v1/keyword-lists/${listId}/keywords/${kwId}`, {
      method: 'DELETE',
    }),
};

// ---------- F-04: content v2 ----------

export type ContentStatus =
  | 'brief' | 'outline' | 'draft' | 'review' | 'changes_requested' | 'approved' | 'published';

export interface ContentVersion {
  id: string;
  title: string | null;
  status: string;
  changed_by: string | null;
  created_at: string;
  outline_preview: string;
  draft_preview: string;
}

export interface OptimizeResult {
  coveragePct: number;
  present: string[];
  missing: string[];
  topTerms: Array<{ term: string; count?: number } | string>;
  sourcesAnalyzed: number;
  keyword: string | null;
}

export interface SeoAssets {
  altTexts: string[];
  metaTitle: string;
  metaDescription: string;
  faqSchema: Record<string, unknown> | null;
}

export interface ContentProfile {
  id?: string;
  tone: string | null;
  vocabulary: string | null;
  do_rules: string | null;
  dont_rules: string | null;
  sample: string | null;
}

/** POST /sites/:id/publish — mock:true means NOTHING was published. */
export interface PublishResult {
  ok: boolean;
  mock: boolean;
  message: string;
  url?: string;
}

export const contentV2Api = {
  createWithBrief: (
    siteId: string,
    input: { keywordId?: string; title: string; tone?: string; length?: string; brief: string },
  ) =>
    api<ContentPiece>(`/api/v1/sites/${siteId}/content`, { method: 'POST', body: input }),
  setBrief: (id: string, brief: string) =>
    api<ContentPiece>(`/api/v1/content/${id}/brief`, { method: 'POST', body: { brief } }),
  generateOutline: (id: string) =>
    api<ContentPiece>(`/api/v1/content/${id}/outline`, { method: 'POST' }),
  optimize: (id: string) => api<OptimizeResult>(`/api/v1/content/${id}/optimize`, { method: 'POST' }),
  internalLinks: (id: string) =>
    api<{ data: Array<{ url: string; title: string; anchor: string; score: number }> }>(
      `/api/v1/content/${id}/internal-links`,
    ),
  duplication: (id: string, text?: string) =>
    api<{ data: Array<{ source: string; similarityPct: number }> }>(
      `/api/v1/content/${id}/duplication`,
      { method: 'POST', body: text ? { text } : {} },
    ),
  seoAssets: (id: string, topics: string[] = [], imageCount = 3) =>
    api<SeoAssets>(`/api/v1/content/${id}/seo-assets`, {
      method: 'POST',
      body: { topics, imageCount },
    }),
  setStatus: (id: string, status: ContentStatus) =>
    api<ContentPiece>(`/api/v1/content/${id}/status`, { method: 'PATCH', body: { status } }),
  versions: (id: string) =>
    api<{ data: ContentVersion[]; total: number }>(`/api/v1/content/${id}/versions`),
  profile: (siteId: string) =>
    api<{ profile: ContentProfile | null }>(`/api/v1/sites/${siteId}/content-profile`),
  saveProfile: (siteId: string, body: Partial<Omit<ContentProfile, 'id'>>) =>
    api<{ profile: ContentProfile }>(`/api/v1/sites/${siteId}/content-profile`, {
      method: 'PUT',
      body,
    }),
  publish: (
    siteId: string,
    body: {
      pieceId: string;
      target: 'wordpress' | 'webflow';
      status?: 'draft' | 'publish';
      siteUrl?: string;
      username?: string;
      appPassword?: string;
      apiToken?: string;
      collectionId?: string;
    },
  ) => api<PublishResult>(`/api/v1/sites/${siteId}/publish`, { method: 'POST', body }),
};

// ---------- F-05: GEO v2 (ALL data simulated — backend marks simulated:true) ----------

export interface GeoPrompt {
  id: string;
  prompt: string;
  created_at: string;
}

export interface GeoRunResult {
  results: unknown;
  simulated: true;
  disclaimer: string;
}

export const geoV2Api = {
  prompts: (siteId: string) =>
    api<{ prompts: GeoPrompt[]; total: number }>(`/api/v1/sites/${siteId}/geo/prompts`),
  addPrompt: (siteId: string, prompt: string) =>
    api<GeoPrompt>(`/api/v1/sites/${siteId}/geo/prompts`, { method: 'POST', body: { prompt } }),
  deletePrompt: (siteId: string, promptId: string) =>
    api<null>(`/api/v1/sites/${siteId}/geo/prompts/${promptId}`, { method: 'DELETE' }),
  runSet: (siteId: string, engines?: string[], maxPrompts?: number) =>
    api<GeoRunResult>(`/api/v1/sites/${siteId}/geo/run-set`, {
      method: 'POST',
      body: { ...(engines ? { engines } : {}), ...(maxPrompts ? { maxPrompts } : {}) },
    }),
  history: (siteId: string, days = 30) =>
    api<{
      simulated: true;
      points: Array<{
        date: string;
        platform: string;
        checks: number;
        mentions: number;
        mentionRatePct: number;
      }>;
    }>(`/api/v1/sites/${siteId}/geo/history?days=${days}`),
  shareOfVoice: (siteId: string, days = 30) =>
    api<{
      simulated: true;
      rows: Array<{ domain: string; mentions: number; checks: number; mentionRatePct: number }>;
    }>(`/api/v1/sites/${siteId}/geo/share-of-voice?days=${days}`),
  recommendations: (siteId: string) =>
    api<{
      score: number;
      simulated: true;
      recommendations: Array<{ priority: 'high' | 'medium' | 'low'; title: string; detail: string }>;
    }>(`/api/v1/sites/${siteId}/geo/recommendations`),
  llmsTxtUrl: (siteId: string) => `${BASE_URL}/api/v1/sites/${encodeURIComponent(siteId)}/geo/llms-txt`,
};

export const GEO_ENGINES = ['chatgpt', 'perplexity', 'gemini', 'claude', 'ai_overview'] as const;

// ---------- F-06: backlinks v2 ----------

export interface ToxicLink {
  id: string;
  source_url: string;
  target_url: string;
  anchor_text: string | null;
  toxic_flags: string[] | null;
  toxic_score: number;
  referring_domain: string | null;
  last_seen: string;
}

export interface LinkOpportunity {
  id: string;
  source_url: string;
  source_domain: string;
  kind: 'reclaim' | 'unlinked-mention';
  reason: string;
  created_at: string;
}

export const backlinksV2Api = {
  anchors: (siteId: string) =>
    api<{ anchors: Array<{ anchor: string; links: number }>; toxic_heuristic: boolean }>(
      `/api/v1/sites/${siteId}/backlinks/anchors`,
    ),
  toxic: (siteId: string, minScore?: number) =>
    api<{
      links: ToxicLink[];
      total: number;
      threshold: number;
      heuristic: true;
      note: string;
    }>(`/api/v1/sites/${siteId}/backlinks/toxic${minScore ? `?minScore=${minScore}` : ''}`),
  rescore: (siteId: string) =>
    api<{ rescored: number; toxic: number; toxic_heuristic: boolean }>(
      `/api/v1/sites/${siteId}/backlinks/rescore`,
      { method: 'POST' },
    ),
  opportunities: (siteId: string) =>
    api<{ opportunities: LinkOpportunity[]; total: number; heuristic: boolean }>(
      `/api/v1/sites/${siteId}/backlinks/opportunities`,
    ),
  refreshOpportunities: (siteId: string) =>
    api<{ opportunities: LinkOpportunity[]; total: number; heuristic: boolean }>(
      `/api/v1/sites/${siteId}/backlinks/opportunities/refresh`,
      { method: 'POST' },
    ),
  disavowUrl: (siteId: string, minScore?: number) =>
    `${BASE_URL}/api/v1/sites/${encodeURIComponent(siteId)}/backlinks/disavow${minScore ? `?minScore=${minScore}` : ''}`,
};

// ---------- F-07: competitors ----------

export interface Competitor {
  id: string;
  domain: string;
  label: string | null;
  discovery_source?: 'auto' | 'manual';
  overlap_score?: number | null;
  shared_keywords?: number | null;
  avg_position?: number | null;
  last_discovered_at?: string | null;
  created_at: string;
}

export interface DiscoveredCompetitor {
  domain: string;
  sharedKeywords: number;
  avgPosition: number;
  overlapScore: number;
  keywords: string[];
}

export interface CompetitorCompare {
  site: string;
  competitors: string[];
  keywords: Array<{
    keyword: string;
    volume: number | null;
    sitePosition: number | null;
    competitors: Record<string, number | null>;
  }>;
  summary: Array<{ domain: string; keywords: number; visibilitySharePct: number }>;
}

export interface CompetitorGap {
  keyword: string;
  volume: number | null;
  sitePosition: number | null;
  competitor: string;
  competitorPosition: number;
}

export const competitorsApi = {
  list: (siteId: string) =>
    api<{ competitors: Competitor[]; total: number }>(`/api/v1/sites/${siteId}/competitors`),
  add: (siteId: string, domain: string, label?: string) =>
    api<Competitor>(`/api/v1/sites/${siteId}/competitors`, {
      method: 'POST',
      body: { domain, ...(label ? { label } : {}) },
    }),
  remove: (siteId: string, competitorId: string) =>
    api<null>(`/api/v1/sites/${siteId}/competitors/${competitorId}`, { method: 'DELETE' }),
  discover: (siteId: string) =>
    api<{ competitors: DiscoveredCompetitor[]; keywordsChecked: number; note?: string }>(
      `/api/v1/sites/${siteId}/competitors/discover`,
      { method: 'POST' },
    ),
  gaps: (siteId: string, competitorId: string) =>
    api<{ competitor: string; gaps: CompetitorGap[]; keywordsChecked: number }>(
      `/api/v1/sites/${siteId}/competitors/${competitorId}/gaps`,
    ),
  compare: (siteId: string) =>
    api<CompetitorCompare>(`/api/v1/sites/${siteId}/competitors/compare`),
  keywordGaps: (siteId: string, limit = 50) =>
    api<{ gaps: CompetitorGap[]; total: number; note?: string }>(
      `/api/v1/sites/${siteId}/competitors/keyword-gaps?limit=${limit}`,
    ),
  contentGaps: (siteId: string, limit = 50) =>
    api<{
      gaps: Array<CompetitorGap & { suggestion: string }>;
      total: number;
    }>(`/api/v1/sites/${siteId}/competitors/content-gaps?limit=${limit}`),
  backlinks: (siteId: string) =>
    api<{
      site: { domain: string; links: number; referringDomains: number };
      competitors: Array<{
        domain: string;
        links: null;
        referringDomains: null;
        data: 'unavailable';
      }>;
      note: string;
    }>(`/api/v1/sites/${siteId}/competitors/backlinks`),
};

// ---------- F-08: white-label reports v2 ----------

export interface TenantBranding {
  company_name: string | null;
  logo_url: string | null;
  primary_color: string | null;
  accent_color: string | null;
}

export const REPORT_SECTIONS = [
  'executive',
  'audit',
  'keywords',
  'backlinks',
  'geo',
  'content',
] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

export interface ReportComparison {
  current: { id: string; period_start: string; period_end: string };
  previous: { id: string; period_start: string; period_end: string } | null;
  deltas: {
    auditScore: number | null;
    openErrors: number | null;
    keywordsImproved: number | null;
    geoScore: number | null;
  };
}

export interface ReportSchedule {
  id: string;
  frequency: 'weekly' | 'monthly';
  recipients: string[];
  sections: string[];
  enabled: boolean;
  [key: string]: unknown;
}

export const reportsV2Api = {
  branding: () => api<TenantBranding>('/api/v1/branding'),
  saveBranding: (body: Partial<TenantBranding>) =>
    api<TenantBranding>('/api/v1/branding', { method: 'PUT', body }),
  build: (siteId: string, sections: string[], periodDays = 7) =>
    api<Report>(`/api/v1/sites/${siteId}/reports/build`, {
      method: 'POST',
      body: { sections, periodDays },
    }),
  pdfUrl: (reportId: string) => `${BASE_URL}/api/v1/reports/${encodeURIComponent(reportId)}/pdf`,
  htmlUrl: (reportId: string) => `${BASE_URL}/api/v1/reports/${encodeURIComponent(reportId)}/html`,
  compare: (reportId: string) => api<ReportComparison>(`/api/v1/reports/${reportId}/compare`),
  createShare: (reportId: string, expiresInDays = 30) =>
    api<ShareCreated>(`/api/v1/reports/${reportId}/share`, {
      method: 'POST',
      body: { expiresInDays },
    }),
  listShares: (reportId: string) =>
    api<{ data: ShareLink[] }>(`/api/v1/reports/${reportId}/shares`),
  revokeShare: (reportId: string, tokenId: string) =>
    api<null>(`/api/v1/reports/${reportId}/shares/${tokenId}`, { method: 'DELETE' }),
  schedule: (siteId: string) =>
    api<{ schedule: ReportSchedule | null }>(`/api/v1/sites/${siteId}/reports/schedule`),
  saveSchedule: (
    siteId: string,
    body: { frequency?: string; recipients?: string[]; sections?: string[]; enabled?: boolean },
  ) =>
    api<{ schedule: ReportSchedule }>(`/api/v1/sites/${siteId}/reports/schedule`, {
      method: 'PUT',
      body,
    }),
  deleteSchedule: (siteId: string) =>
    api<null>(`/api/v1/sites/${siteId}/reports/schedule`, { method: 'DELETE' }),
};

// ===========================================================================
// Wave 3 — W-04 Insights engine UI + W-05 SSE job-progress stream
// (frontend slice; backend contracts land in parallel — assumptions noted)
// ===========================================================================

// ---------- W-05: SSE job-progress stream ----------

/**
 * W-05: Backend `GET /api/v1/sites/:id/jobs/stream` (SSE) — merged; the
 * consumer (lib/useJobStream.ts) normalizes the real snapshot/done/error
 * shapes (wire→UI mapping documented there). The path goes through the
 * same-origin /api proxy, so the API URL is never baked into the bundle.
 * encodeURIComponent guards the site id (path-injection hygiene).
 */
export const jobsApi = {
  streamUrl: (siteId: string) =>
    `${BASE_URL}/api/v1/sites/${encodeURIComponent(siteId)}/jobs/stream`,
};

// ---------- W-04: Insights engine UI ----------

/**
 * W-04: site-level "do this next" actions from the Insights engine.
 * REAL backend contract (merged; backend/src/routes/insights.ts +
 * backend/src/services/insights.ts — authoritative):
 *   GET /api/v1/sites/:id/insights (scope ranks:read)
 *   → { engine: 'rules-v1', computedAt,
 *       actions: [{ type: 'critical_audit_issue' | 'rank_drop' |
 *                           'content_gap' | 'unranked_keyword',
 *                   priority: 0–100 (higher first), title, detail, evidence,
 *                   target: { kind, id?, href }, source: 'computed' }],
 *       forecast: { kind: 'projection', label, method,
 *                   visibilityIndexNow, visibilityIndexProjected,
 *                   horizonDays, basedOnDays } }
 * `target.href` is always an absolute path shaped like
 * `/dashboard/sites/<id>?tab=<slug>` — resolveInsightHref() translates it
 * to this app's path-segment tab routing (`/dashboard/sites/<id>/<slug>`).
 * The forecast is a PROJECTION (linear trend on the rank-visibility index) —
 * the UI must label it as estimated, never as measured traffic or a promise.
 * Legacy shapes (bare array, { data }, { insights }, Paged) are still
 * accepted by normalizeInsightList as fallback; the real envelope is primary.
 */
export interface SiteInsight {
  id?: string;
  type: string;
  /** Number (higher = more important) or 'critical'|'high'|'medium'|'low'. */
  priority: number | string;
  title: string;
  detail?: string | null;
  /** Evidence: string, string[], or a record of label→value pairs. */
  evidence?: unknown;
  /**
   * Real: { kind, id?, href }. Legacy: tab slug, absolute path,
   * or { tab?, url? }.
   */
  target?: string | { tab?: string; url?: string } | { kind?: string; id?: string; href?: string } | null;
  impact?: number | null;
  created_at?: string | null;
}

/**
 * Real forecast shape — a labeled projection, never measured traffic and
 * never a guarantee. Render with projection labeling (see InsightsTab).
 */
export interface SiteForecast {
  kind: 'projection';
  label: string;
  method: string;
  visibilityIndexNow: number;
  visibilityIndexProjected: number;
  horizonDays: number;
  basedOnDays: number;
}

const PRIORITY_RANK: Record<string, number> = {
  critical: 100,
  high: 80,
  medium: 50,
  low: 20,
};

/** Sort key for an insight's priority: bigger = do it first. */
export function insightPriorityRank(priority: SiteInsight['priority']): number {
  if (typeof priority === 'number' && Number.isFinite(priority)) return priority;
  const p = String(priority ?? '').toLowerCase();
  return PRIORITY_RANK[p] ?? 0;
}

export function insightPriorityLabel(priority: SiteInsight['priority']): string {
  if (typeof priority === 'number') {
    if (priority >= 90) return 'Critical';
    if (priority >= 70) return 'High';
    if (priority >= 40) return 'Medium';
    return 'Low';
  }
  const p = String(priority ?? '').toLowerCase();
  return p ? p[0].toUpperCase() + p.slice(1) : 'Low';
}

/** The deep-link slugs this frontend knows how to render for a site. */
const INSIGHT_TAB_SLUGS = new Set([
  'audit',
  'keywords',
  'rankings',
  'content',
  'onpage',
  'backlinks',
  'geo',
  'competitors',
  'reports',
  'insights',
]);

/**
 * Normalize a backend insight's `target` to an app deep link. Real shape
 * first: { kind, id?, href } where href looks like
 * `/dashboard/sites/<id>?tab=<slug>` — translated to this app's
 * path-segment tab routing (`/dashboard/sites/<id>/<slug>`); `kind` maps to
 * a tab slug when href is absent. Legacy tab slugs / absolute paths /
 * { tab, url } still work. Falls back to the site overview for anything
 * unrecognized — never renders a broken or external link.
 */
export function resolveInsightHref(siteId: string, target: SiteInsight['target'], type?: string): string {
  const base = `/dashboard/sites/${siteId}`;
  const safePath = (h: string): string | null => {
    const t = h.trim();
    // Absolute same-origin path only — never protocol-relative or external.
    if (!t.startsWith('/') || t.startsWith('//')) return null;
    // Backend query-param form → path-segment tab routing.
    const m = t.match(/^\/dashboard\/sites\/[^/?]+\?tab=([A-Za-z0-9_-]+)/);
    if (m) {
      const slug = m[1].toLowerCase();
      if (INSIGHT_TAB_SLUGS.has(slug)) return slug === 'insights' ? base : `${base}/${slug}`;
      return base;
    }
    return t;
  };
  if (target && typeof target === 'object') {
    if ('href' in target && typeof target.href === 'string') {
      const p = safePath(target.href);
      if (p) return p;
      // href present but unusable — fall through to kind/type fallbacks.
    } else if ('url' in target && typeof target.url === 'string') {
      const p = safePath(target.url);
      if (p) return p;
    }
    const tab = 'tab' in target ? target.tab : 'kind' in target ? target.kind : undefined;
    if (typeof tab === 'string' && tab) return resolveInsightHref(siteId, tab, type);
  }
  if (typeof target === 'string') {
    const t = target.trim();
    if (t.startsWith('/')) {
      const p = safePath(t);
      if (p) return p;
    }
    const slug = t.replace(/^#/, '').toLowerCase();
    if (INSIGHT_TAB_SLUGS.has(slug)) return slug === 'insights' ? base : `${base}/${slug}`;
  }
  // Fallback: map the insight type to a tab when target is absent.
  const ty = (type ?? '').toLowerCase();
  if (ty.includes('keyword')) return `${base}/keywords`;
  if (ty.includes('backlink') || ty.includes('link')) return `${base}/backlinks`;
  if (ty.includes('content')) return `${base}/content`;
  if (ty.includes('rank')) return `${base}/rankings`;
  if (ty.includes('geo') || ty.includes('ai_visibility')) return `${base}/geo`;
  if (ty.includes('audit') || ty.includes('crawl') || ty.includes('technical')) return `${base}/audit`;
  if (ty.includes('competitor')) return `${base}/competitors`;
  return base;
}

/**
 * Normalize the backend response into a priority-sorted insight list.
 * Real envelope first: { actions: [...] }; then legacy bare array,
 * { data: [] }, { insights: [] }.
 */
export function normalizeInsightList(raw: unknown): SiteInsight[] {
  let arr: unknown[] = [];
  if (Array.isArray(raw)) arr = raw;
  else if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.actions)) arr = r.actions;
    else if (Array.isArray(r.data)) arr = r.data;
    else if (Array.isArray(r.insights)) arr = r.insights;
  }
  const list: SiteInsight[] = arr
    .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
    .map((i) => ({
      id: typeof i.id === 'string' ? i.id : undefined,
      type: typeof i.type === 'string' ? i.type : 'general',
      priority: (typeof i.priority === 'number' || typeof i.priority === 'string'
        ? i.priority
        : 'low') as SiteInsight['priority'],
      title: typeof i.title === 'string' ? i.title : 'Action',
      detail: typeof i.detail === 'string' ? i.detail : null,
      evidence: (i as Record<string, unknown>).evidence,
      target: (i.target as SiteInsight['target']) ?? null,
      impact: typeof i.impact === 'number' ? i.impact : null,
      created_at: typeof i.created_at === 'string' ? i.created_at : null,
    }));
  return list.sort((a, b) => insightPriorityRank(b.priority) - insightPriorityRank(a.priority));
}

/**
 * Normalize the real forecast envelope ({ kind: 'projection', … }).
 * Returns null for anything else — the UI renders no projection rather than
 * a mislabeled one.
 */
export function normalizeForecast(raw: unknown): SiteForecast | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'projection') return null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const now = num(r.visibilityIndexNow);
  const projected = num(r.visibilityIndexProjected);
  const horizon = num(r.horizonDays);
  const basedOn = num(r.basedOnDays);
  if (now === null || projected === null || horizon === null || basedOn === null) return null;
  return {
    kind: 'projection',
    label: typeof r.label === 'string' ? r.label : 'Visibility projection',
    method: typeof r.method === 'string' ? r.method : '',
    visibilityIndexNow: now,
    visibilityIndexProjected: projected,
    horizonDays: horizon,
    basedOnDays: basedOn,
  };
}

export interface SiteInsightsResult {
  insights: SiteInsight[];
  forecast: SiteForecast | null;
  computedAt: string | null;
  engine: string | null;
}

export const insightsApi = {
  /**
   * Real endpoint: GET /api/v1/sites/:id/insights → SiteInsightsResult.
   * normalizeInsightList/normalizeForecast accept the real envelope;
   * legacy list shapes still parse as fallback.
   */
  get: async (siteId: string): Promise<SiteInsightsResult> => {
    const raw = await api<unknown>(`/api/v1/sites/${encodeURIComponent(siteId)}/insights`);
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
      insights: normalizeInsightList(raw),
      forecast: normalizeForecast(r.forecast),
      computedAt: typeof r.computedAt === 'string' ? r.computedAt : null,
      engine: typeof r.engine === 'string' ? r.engine : null,
    };
  },
  /** Actions only — back-compat. Prefer get() to also render the forecast. */
  list: async (siteId: string): Promise<SiteInsight[]> => (await insightsApi.get(siteId)).insights,
};
