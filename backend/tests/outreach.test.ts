// Phase 2 rebuild — outreach service unit tests (pure functions, no DB).
import { describe, it, expect } from 'vitest';
import {
  scoreProspect,
  personalizePitch,
  checkPitchGates,
  MAX_FIRST_TOUCH_PER_DAY,
} from '../src/services/outreach.js';

describe('scoreProspect', () => {
  it('rejects own domain with score 0', () => {
    const r = scoreProspect('https://acme.com/blog', 'resource_page', 'acme.com');
    expect(r.score).toBe(0);
    expect(r.reasons).toContain('own domain');
  });
  it('rejects invalid URLs with score 0', () => {
    const r = scoreProspect('not-a-url', 'guest_post', 'acme.com');
    expect(r.score).toBe(0);
  });
  it('penalizes spammy TLDs below the 50 threshold', () => {
    const r = scoreProspect('https://free-backlinks.xyz/list', 'resource_page', 'acme.com');
    expect(r.score).toBeLessThan(50);
  });
  it('scores legitimate resource pages >= 50', () => {
    const r = scoreProspect('https://example.org/plumbing-resources', 'resource_page', 'acme.com');
    expect(r.score).toBeGreaterThanOrEqual(50);
  });
  it('gives reclaim the highest type bonus', () => {
    const reclaim = scoreProspect('https://example.org/old-post', 'reclaim', 'acme.com');
    const guest = scoreProspect('https://example.org/old-post', 'guest_post', 'acme.com');
    expect(reclaim.score).toBeGreaterThan(guest.score);
  });
});

describe('personalizePitch + checkPitchGates', () => {
  const prospect = {
    prospect_domain: 'example.org',
    prospect_url: 'https://example.org/plumbing-resources',
    prospect_type: 'resource_page' as const,
    reason: 'Found via "plumbing resources"',
  };
  const site = { domain: 'acme.com', businessName: 'Acme Plumbing' };

  it('produces >= 3 prospect-specific fields', () => {
    const draft = personalizePitch(prospect, site);
    expect(Object.keys(draft.personalizationFields).length).toBeGreaterThanOrEqual(3);
  });
  it('passes the hard gates for a normal prospect', () => {
    const draft = personalizePitch(prospect, site);
    const gates = checkPitchGates(draft);
    expect(gates.ok).toBe(true);
    expect(gates.failures).toHaveLength(0);
    expect(gates.uniqueRatio).toBeGreaterThanOrEqual(0.4);
  });
  it('fails the gate when fields are stripped', () => {
    const draft = personalizePitch(prospect, site);
    draft.personalizationFields = { only: 'one' };
    const gates = checkPitchGates(draft);
    expect(gates.ok).toBe(false);
    expect(gates.failures.some((f) => f.includes('prospect-specific fields'))).toBe(true);
  });
  it('mentions the prospect domain and site domain in the body', () => {
    const draft = personalizePitch(prospect, site);
    expect(draft.body).toContain('example.org');
    expect(draft.body).toContain('acme.com');
  });
  it('varies the angle by prospect type', () => {
    const guest = personalizePitch({ ...prospect, prospect_type: 'guest_post' }, site);
    const resource = personalizePitch({ ...prospect, prospect_type: 'resource_page' }, site);
    expect(guest.body).not.toBe(resource.body);
    expect(guest.body.toLowerCase()).toContain('guest');
  });
});

describe('daily cap constant', () => {
  it('is 25 per the Link Building spec', () => {
    expect(MAX_FIRST_TOUCH_PER_DAY).toBe(25);
  });
});
