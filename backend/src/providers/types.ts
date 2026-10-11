import type { PlanId } from '../plans.js';

// ---------- LLM ----------
export interface LLMGenerateOpts {
  prompt: string;
  maxWords?: number;
  temperature?: number;
}
export interface LLMResult {
  text: string;
  words: number;
}
export interface LLMProvider {
  name: string;
  isMock: boolean;
  generate(opts: LLMGenerateOpts): Promise<LLMResult>;
}

// ---------- Keyword + SERP data ----------
export interface KeywordMetric {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
}
export interface SerpResult {
  position: number | null;
  url: string | null;
  features: string[];
}
/** One result item of a full SERP snapshot (C-05). */
export interface SerpItem {
  /** 1-based absolute rank (DataForSEO rank_absolute — pixel-rank approximation) */
  position: number;
  url: string;
  domain: string;
  title: string | null;
  /** DataForSEO item type: organic, ai_overview, featured_snippet, local_pack, ... */
  itemType: string;
}
export interface SerpSnapshotResult {
  items: SerpItem[];
  /** page-level SERP features present */
  features: string[];
}
export interface KeywordSerpProvider {
  name: string;
  isMock: boolean;
  /** locationCode = DataForSEO location_code (default 2840 = United States). */
  keywordMetrics(keywords: string[], locationCode?: number): Promise<KeywordMetric[]>;
  serp(keyword: string, domain: string, locationCode?: number): Promise<SerpResult>;
  /**
   * C-05: full top-100 SERP snapshot (optional — backwards compatible).
   * Implementations that cannot fetch a full page may omit this; callers
   * fall back to `serp()`.
   */
  serpFull?(keyword: string, domain: string, locationCode?: number, device?: string): Promise<SerpSnapshotResult>;
  /**
   * F-03/F-07: keywords a competitor domain ranks for (optional).
   * Real: DataForSEO Labs ranked_keywords. Mock: deterministic fake list.
   */
  competitorKeywords?(competitorDomain: string, locationCode?: number): Promise<Array<{ keyword: string; position: number; url: string }>>;
}

// ---------- Payments ----------
export interface PaymentsProvider {
  name: string;
  isMock: boolean;
  createCustomer(email: string, tenantId: string): Promise<{ customerId: string }>;
  createCheckoutSession(p: {
    customerId: string; planId: PlanId; successUrl: string; cancelUrl: string;
    metadata?: Record<string, string>;
  }): Promise<{ url: string; sessionId: string }>;
  createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }>;
  constructWebhookEvent(rawBody: Buffer | string, signature: string): Promise<{ type: string; data: any }>;
  /**
   * A2-L5: ensures a Stripe coupon exists for a local coupon definition and
   * returns the Stripe coupon ID. Implementations may create the coupon
   * remotely on first use.
   */
  ensureCoupon(def: {
    code: string;
    percentOff?: number | null;
    amountOffCents?: number | null;
    duration: string;
  }): Promise<string>;
  /**
   * C1-H-1/H-2: cancels every active subscription owned by the Stripe
   * customer (immediate cancel, not at-period-end — the account is being
   * deleted, so there is nobody left to use the remaining period).
   * Returns the canceled subscription ids; empty when the customer has no
   * active subscriptions. Must be called BEFORE deleting tenant/user rows.
   */
  cancelSubscription(customerId: string): Promise<{ canceled: string[] }>;
}

// ---------- Google ----------
export interface GscQuery {
  query: string;
  clicks: number;
  impressions: number;
  position: number;
}
export interface GscLink {
  sourceUrl: string;
  targetUrl: string;
}
export interface Ga4Property {
  id: string;
  displayName: string;
}
export interface Ga4TopEntry {
  name: string;
  sessions: number;
}
export interface Ga4Overview {
  sessions: number;
  users: number;
  pageviews: number;
  avgSessionDurationSec: number;
  topPages: Ga4TopEntry[];
  topReferrers: Ga4TopEntry[];
}
/** Profile returned by Google sign-in. emailVerified comes from Google's userinfo. */
export interface GoogleProfile {
  email: string;
  name: string;
  googleId: string;
  /** S-01: true only when Google attests the email is verified. */
  emailVerified: boolean;
}

export interface GoogleProvider {
  name: string;
  isMock: boolean;
  getAuthUrl(state: string, opts?: { codeChallenge?: string }): string;
  // S-04: codeVerifier is OPTIONAL (backwards-compatible addition to the
  // frozen interface): PKCE flows pass the verifier stored with the OAuth
  // state; the mock provider ignores it.
  exchangeCode(code: string, codeVerifier?: string): Promise<{ refreshToken: string }>;
  /** Email/profile for the user who completed OAuth (used for signup/login via Google). */
  getProfile(code: string, codeVerifier?: string): Promise<GoogleProfile>;
  searchQueries(refreshToken: string, siteUrl: string, days?: number): Promise<GscQuery[]>;
  backlinks(refreshToken: string, siteUrl: string): Promise<GscLink[]>;
  /** GA4: list Analytics properties the Google account can access. */
  listGa4Properties(refreshToken: string): Promise<Ga4Property[]>;
  /** GA4: traffic overview for the last `days` days (sessions, top pages, top referrers). */
  ga4Overview(refreshToken: string, propertyId: string, days?: number): Promise<Ga4Overview>;
}

// ---------- Notifications ----------
export interface NotifyProvider {
  name: string;
  sendEmail(to: string, subject: string, html: string): Promise<void>;
  sendTelegram(chatId: string, text: string): Promise<void>;
}
