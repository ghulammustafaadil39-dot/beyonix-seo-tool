import { describe, expect, it } from 'vitest';
import { toPublicSite } from '../src/services/sites.js';
import { isKnownGa4Property } from '../src/routes/ga4.js';
import { slugify } from '../src/routes/content.js';
import { getGoogle } from '../src/providers/google.js';

describe('toPublicSite (no secret leakage)', () => {
  const row = {
    id: 'site-1',
    tenant_id: 'tenant-1',
    domain: 'example.com',
    verified: true,
    verify_token: 'secret-ownership-token',
    gsc_connected: true,
    ga4_connected: true,
    gsc_refresh_token_enc: 'enc:secret-google-refresh',
    ga4_property_id: '123456789',
    serp_location_code: 586,
    serp_location_name: 'Pakistan',
    created_at: '2026-01-01T00:00:00Z',
  };

  it('strips the verify token and the encrypted Google refresh token', () => {
    const pub = toPublicSite(row);
    expect(pub).not.toHaveProperty('verify_token');
    expect(pub).not.toHaveProperty('gsc_refresh_token_enc');
    expect(JSON.stringify(pub)).not.toContain('secret-ownership-token');
    expect(JSON.stringify(pub)).not.toContain('enc:secret-google-refresh');
  });

  it('keeps GA4 + location fields for the frontend', () => {
    const pub = toPublicSite(row);
    expect(pub.ga4_connected).toBe(true);
    expect(pub.ga4_property_id).toBe('123456789');
    expect(pub.serp_location_code).toBe(586);
    expect(pub.serp_location_name).toBe('Pakistan');
  });

  it('defaults location to US and ga4_property_id to null when unset', () => {
    const pub = toPublicSite({ ...row, serp_location_code: null, ga4_property_id: null });
    expect(pub.serp_location_code).toBe(2840);
    expect(pub.ga4_property_id).toBeNull();
  });
});

describe('isKnownGa4Property (anti-forgery)', () => {
  const props = [
    { id: '111', displayName: 'A' },
    { id: '222', displayName: 'B' },
  ];

  it('accepts a property id from the account list', () => {
    expect(isKnownGa4Property(props, '111')).toBe(true);
    expect(isKnownGa4Property(props, '222')).toBe(true);
  });

  it('rejects forged/unknown ids (prefix games included)', () => {
    expect(isKnownGa4Property(props, '333')).toBe(false);
    expect(isKnownGa4Property(props, '11')).toBe(false);
    expect(isKnownGa4Property(props, '')).toBe(false);
    expect(isKnownGa4Property([], '111')).toBe(false);
  });
});

describe('slugify (export filenames)', () => {
  it('produces a filename-safe slug', () => {
    expect(slugify('My Great Post: 10 SEO Tips!')).toBe('my-great-post-10-seo-tips');
  });

  it('falls back to "content" for empty/blank titles', () => {
    expect(slugify('')).toBe('content');
    expect(slugify('   ')).toBe('content');
    expect(slugify('!!!')).toBe('content');
  });

  it('caps length and strips leading/trailing dashes', () => {
    const s = slugify('--' + 'a'.repeat(100) + '--');
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s).not.toMatch(/^-|-$/);
  });
});

describe('mock Google provider GA4 shape', () => {
  it('lists GA4 properties with id + displayName', async () => {
    const props = await getGoogle().listGa4Properties('anything');
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) {
      expect(typeof p.id).toBe('string');
      expect(typeof p.displayName).toBe('string');
    }
  });

  it('returns a well-formed GA4 overview', async () => {
    const o = await getGoogle().ga4Overview('anything', '123');
    expect(typeof o.sessions).toBe('number');
    expect(typeof o.users).toBe('number');
    expect(typeof o.pageviews).toBe('number');
    expect(typeof o.avgSessionDurationSec).toBe('number');
    expect(Array.isArray(o.topPages)).toBe(true);
    expect(Array.isArray(o.topReferrers)).toBe(true);
  });
});
