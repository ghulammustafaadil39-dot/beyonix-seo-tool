// Backend-B Wave 2 unit tests — F-03/F-04/F-05/F-06/F-08 pure services.
// No network, no DB, no Redis.
import { describe, it, expect } from 'vitest';
import { analyzeToxicity, TOXIC_THRESHOLD } from '../src/services/toxicLinks.js';
import { signShareToken, verifyShareToken, hashShareToken } from '../src/services/shareTokens.js';
import { topTerms, termCoverage, pageTextForTerms } from '../src/services/nlpTerms.js';
import { isQuestionKeyword } from '../src/services/keywordText.js';

describe('toxicLinks (heuristics — labeled as such)', () => {
  it('flags suspicious TLD + link-scheme patterns', () => {
    const r = analyzeToxicity('https://cheap-seo-links.xyz/post', 'buy cheap viagra', 'example.com');
    expect(r.flags).toContain('suspicious-tld');
    expect(r.flags).toContain('link-scheme-pattern');
    expect(r.score).toBeGreaterThanOrEqual(TOXIC_THRESHOLD);
  });
  it('scores a normal editorial link low', () => {
    const r = analyzeToxicity('https://techcrunch.com/2026/01/story', 'Beyonix Solutions', 'beyonixsolutions.com');
    expect(r.score).toBeLessThan(TOXIC_THRESHOLD);
    expect(r.flags).not.toContain('suspicious-tld');
  });
  it('flags spam-niche domains and comment spam patterns', () => {
    const r = analyzeToxicity('https://best-casino-bonus.example/blog?replytocom=5', null, 'example.com');
    expect(r.flags).toContain('spam-niche-pattern');
    expect(r.flags).toContain('ugc-spam-pattern');
  });
});

describe('shareTokens', () => {
  const secret = 'test-secret-32-chars-minimum-000000';
  const payload = {
    resourceType: 'audit',
    resourceId: '11111111-1111-1111-1111-111111111111',
    tenantId: '22222222-2222-2222-2222-222222222222',
    expiresAt: Date.now() + 3600_000,
    issuedAt: Date.now(),
  };
  it('signs and verifies a token', () => {
    const token = signShareToken(secret, payload);
    const back = verifyShareToken(secret, token, 'audit');
    expect(back).not.toBeNull();
    expect(back!.resourceId).toBe(payload.resourceId);
  });
  it('rejects tampered tokens', () => {
    const token = signShareToken(secret, payload);
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect(verifyShareToken(secret, tampered)).toBeNull();
  });
  it('rejects expired tokens and wrong resource type', () => {
    const expired = signShareToken(secret, { ...payload, expiresAt: Date.now() - 1000 });
    expect(verifyShareToken(secret, expired)).toBeNull();
    const token = signShareToken(secret, payload);
    expect(verifyShareToken(secret, token, 'report')).toBeNull();
  });
  it('hashes tokens deterministically for revocation lookup', () => {
    const token = signShareToken(secret, payload);
    expect(hashShareToken(token)).toBe(hashShareToken(token));
    expect(hashShareToken(token)).toHaveLength(64);
  });
});

describe('nlpTerms', () => {
  const pages = [
    'seo audit checks title tags meta descriptions and heading structure for rankings',
    'a technical seo audit reviews meta descriptions crawl budget and site speed',
    'run an seo audit to find broken links duplicate titles and thin content',
  ];
  it('extracts characteristic terms by document frequency', () => {
    const terms = topTerms(pages, 10, 2);
    const names = terms.map((t) => t.term);
    expect(names).toContain('audit');
    expect(names).toContain('descriptions');
    expect(terms[0].df).toBeGreaterThanOrEqual(2);
  });
  it('scores term coverage of a draft', () => {
    const terms = topTerms(pages, 10, 2);
    const full = termCoverage(pages.join(' '), terms);
    expect(full.coveragePct).toBe(100);
    const thin = termCoverage('hello world', terms);
    expect(thin.coveragePct).toBeLessThan(50);
    expect(thin.missing.length).toBeGreaterThan(0);
  });
  it('strips markup for term analysis', () => {
    const text = pageTextForTerms('<html><head><script>var x=1;</script></head><body><h1>SEO Audit</h1></body></html>');
    expect(text).toContain('SEO Audit');
    expect(text).not.toContain('var x');
  });
});

describe('keywordText', () => {
  it('detects question keywords', () => {
    expect(isQuestionKeyword('how to do a seo audit')).toBe(true);
    expect(isQuestionKeyword('what is canonical tag')).toBe(true);
    expect(isQuestionKeyword('best seo tools')).toBe(false);
    expect(isQuestionKeyword('why is my site slow')).toBe(true);
  });
});
