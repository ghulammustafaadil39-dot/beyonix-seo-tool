import { google } from 'googleapis';
import { CodeChallengeMethod } from 'google-auth-library';
import { config, hasGoogle } from '../config.js';
import { decrypt } from '../crypto.js';
import type { GoogleProfile, GoogleProvider, GscQuery, GscLink, Ga4Property, Ga4Overview, Ga4TopEntry } from './types.js';

function oauthClient() {
  return new google.auth.OAuth2(config.googleClientId, config.googleClientSecret, config.googleRedirectUri);
}

class RealGoogleProvider implements GoogleProvider {
  name = 'google';
  isMock = false;

  getAuthUrl(state: string, opts?: { codeChallenge?: string }): string {
    return oauthClient().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/webmasters.readonly',
        'https://www.googleapis.com/auth/analytics.readonly',
      ],
      state,
      // S-04 PKCE: the caller generates the verifier and keeps it server-side.
      ...(opts?.codeChallenge
        ? { code_challenge: opts.codeChallenge, code_challenge_method: CodeChallengeMethod.S256 }
        : {}),
    });
  }

  async exchangeCode(code: string): Promise<{ refreshToken: string }> {
    const { tokens } = await oauthClient().getToken(code);
    if (!tokens.refresh_token) throw new Error('Google did not return a refresh token');
    return { refreshToken: tokens.refresh_token };
  }

  async getProfile(code: string, codeVerifier?: string): Promise<GoogleProfile> {
    const client = oauthClient();
    const { tokens } = codeVerifier
      ? await client.getToken({ code, codeVerifier })
      : await client.getToken(code);
    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const me = await oauth2.userinfo.get();
    const email = me.data.email;
    if (!email) throw new Error('Google did not return an email address');
    return {
      email,
      name: me.data.name ?? email,
      googleId: me.data.id ?? '',
      emailVerified: me.data.verified_email ?? false,
    };
  }

  private async authed(refreshTokenEnc: string) {
    const client = oauthClient();
    client.setCredentials({ refresh_token: decrypt(refreshTokenEnc) });
    return client;
  }

  async searchQueries(refreshTokenEnc: string, siteUrl: string, days = 28): Promise<GscQuery[]> {
    const auth = await this.authed(refreshTokenEnc);
    const gsc = google.searchconsole({ version: 'v1', auth });
    const end = new Date();
    const start = new Date(Date.now() - days * 86400000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const res = await gsc.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: fmt(start),
        endDate: fmt(end),
        dimensions: ['query'],
        rowLimit: 500,
      },
    });
    return (res.data.rows ?? []).map((r: any) => ({
      query: r.keys?.[0] ?? '',
      clicks: r.clicks ?? 0,
      impressions: r.impressions ?? 0,
      position: r.position ?? 0,
    }));
  }

  async backlinks(refreshTokenEnc: string, siteUrl: string): Promise<GscLink[]> {
    // GSC API has no links endpoint; use the Search Console UI export equivalent:
    // fall back to empty here and rely on mock/sample data until a links
    // provider is wired. Kept as a real-shaped method for the v2 upgrade.
    void refreshTokenEnc;
    void siteUrl;
    return [];
  }

  async listGa4Properties(refreshTokenEnc: string): Promise<Ga4Property[]> {
    const auth = await this.authed(refreshTokenEnc);
    const admin = google.analyticsadmin({ version: 'v1alpha', auth });
    const props: Ga4Property[] = [];
    let pageToken: string | undefined;
    do {
      const res = await admin.accountSummaries.list({ pageSize: 200, pageToken });
      for (const acct of res.data.accountSummaries ?? []) {
        for (const ps of acct.propertySummaries ?? []) {
          const m = /^properties\/(\d+)$/.exec(ps.property ?? '');
          if (m) props.push({ id: m[1], displayName: ps.displayName ?? `Property ${m[1]}` });
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return props;
  }

  async ga4Overview(refreshTokenEnc: string, propertyId: string, days = 28): Promise<Ga4Overview> {
    const auth = await this.authed(refreshTokenEnc);
    const data = google.analyticsdata({ version: 'v1beta', auth });
    const property = `properties/${propertyId}`;
    const end = new Date();
    const start = new Date(Date.now() - days * 86400000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const dateRanges = [{ startDate: fmt(start), endDate: fmt(end) }];

    const totals = await data.properties.runReport({
      property,
      requestBody: {
        dateRanges,
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'screenPageViews' },
          { name: 'averageSessionDuration' },
        ],
      },
    });
    const vals = totals.data.rows?.[0]?.metricValues ?? [];
    const num = (i: number) => Number(vals[i]?.value ?? 0);

    const byDimension = async (dimension: string): Promise<Ga4TopEntry[]> => {
      const res = await data.properties.runReport({
        property,
        requestBody: {
          dateRanges,
          dimensions: [{ name: dimension }],
          metrics: [{ name: 'sessions' }],
          orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
          limit: '10',
        },
      });
      return (res.data.rows ?? []).map((r: any) => ({
        name: r.dimensionValues?.[0]?.value ?? '(unknown)',
        sessions: Number(r.metricValues?.[0]?.value ?? 0),
      }));
    };

    return {
      sessions: num(0),
      users: num(1),
      pageviews: num(2),
      avgSessionDurationSec: Math.round(num(3)),
      topPages: await byDimension('pagePath'),
      topReferrers: await byDimension('sessionSource'),
    };
  }
}

const MOCK_QUERIES: GscQuery[] = [
  { query: 'ai chatbot development company', clicks: 42, impressions: 1800, position: 8.4 },
  { query: 'custom ai software development', clicks: 31, impressions: 1200, position: 11.2 },
  { query: 'hire ai developers', clicks: 18, impressions: 900, position: 14.7 },
  { query: 'ai automation agency', clicks: 25, impressions: 1500, position: 6.1 },
  { query: 'build ai app for business', clicks: 12, impressions: 640, position: 19.3 },
  { query: 'llm integration services', clicks: 9, impressions: 410, position: 22.8 },
];

const MOCK_LINKS: GscLink[] = [
  { sourceUrl: 'https://example-blog.com/ai-agencies-2026', targetUrl: 'https://example.com/' },
  { sourceUrl: 'https://directory.example.org/software-houses', targetUrl: 'https://example.com/' },
];

class MockGoogleProvider implements GoogleProvider {
  name = 'mock-google';
  isMock = true;

  getAuthUrl(state: string): string {
    // Local mock consent page that immediately "approves" and redirects back.
    return `${config.apiUrl}/api/v1/gsc/mock-consent?state=${encodeURIComponent(state)}`;
  }

  async exchangeCode(_code: string): Promise<{ refreshToken: string }> {
    return { refreshToken: 'mock-refresh-token' };
  }

  async getProfile(_code: string): Promise<GoogleProfile> {
    // Dev/test knobs: MOCK_GOOGLE_EMAIL_VERIFIED=false simulates a Google
    // account whose email is NOT verified (S-01 merge-rule tests).
    return {
      email: process.env.MOCK_GOOGLE_EMAIL ?? 'mock.user@example.com',
      name: 'Mock User',
      googleId: 'mock-google-id',
      emailVerified: process.env.MOCK_GOOGLE_EMAIL_VERIFIED !== 'false',
    };
  }

  async searchQueries(_refreshToken: string, _siteUrl: string, _days = 28): Promise<GscQuery[]> {
    return MOCK_QUERIES;
  }

  async backlinks(_refreshToken: string, _siteUrl: string): Promise<GscLink[]> {
    return MOCK_LINKS;
  }

  async listGa4Properties(): Promise<Ga4Property[]> {
    return [
      { id: '123456789', displayName: 'example.com — GA4' },
      { id: '987654321', displayName: 'example.com — Test property' },
    ];
  }

  async ga4Overview(): Promise<Ga4Overview> {
    return {
      sessions: 1842,
      users: 1520,
      pageviews: 4310,
      avgSessionDurationSec: 96,
      topPages: [
        { name: '/', sessions: 620 },
        { name: '/pricing', sessions: 210 },
        { name: '/blog/seo-guide', sessions: 154 },
      ],
      topReferrers: [
        { name: 'google', sessions: 980 },
        { name: '(direct)', sessions: 410 },
        { name: 'linkedin.com', sessions: 96 },
      ],
    };
  }
}

let cached: GoogleProvider | null = null;
export function getGoogle(): GoogleProvider {
  if (hasGoogle()) return new RealGoogleProvider();
  if (!cached) {
    console.log('[provider] using MOCK google (no GOOGLE_CLIENT_ID/SECRET configured)');
    cached = new MockGoogleProvider();
  }
  return cached;
}
