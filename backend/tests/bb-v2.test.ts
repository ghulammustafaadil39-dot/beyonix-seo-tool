// Backend-B Wave 2 unit tests — F-03/F-04/F-05/F-06/F-08 pure services.
// No network, no DB, no Redis.
import { describe, it, expect } from 'vitest';
import { analyzeToxicity, TOXIC_THRESHOLD } from '../src/services/toxicLinks.js';
import { createShareToken, verifyShareTokenFormat, hashShareToken, deriveShareTokenKey } from '../src/services/shareTokens.js';
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
  it('creates short signed tokens that verify', () => {
    const { token, tokenHash } = createShareToken(secret);
    expect(token.length).toBeLessThan(100); // fits Fastify's default maxParamLength
    expect(token.startsWith('bseo1.')).toBe(true);
    const id = verifyShareTokenFormat(secret, token);
    expect(id).not.toBeNull();
    expect(hashShareToken(token)).toBe(tokenHash);
    expect(tokenHash).toHaveLength(64);
  });
  it('rejects tampered tokens and wrong secrets', () => {
    const { token } = createShareToken(secret);
    const tampered = token.slice(0, -2) + 'AA';
    expect(verifyShareTokenFormat(secret, tampered)).toBeNull();
    expect(verifyShareTokenFormat('wrong-secret-0000000000000000000000', token)).toBeNull();
    expect(verifyShareTokenFormat(secret, 'bseo1.not-a-token')).toBeNull();
    expect(verifyShareTokenFormat(secret, '')).toBeNull();
  });
  it('produces unique tokens', () => {
    const a = createShareToken(secret);
    const b = createShareToken(secret);
    expect(a.token).not.toBe(b.token);
  });
  it('domain-separated key: tokens do NOT verify under the raw JWT secret', () => {
    // Call sites pass deriveShareTokenKey(jwtSecret), never the raw secret.
    const key = deriveShareTokenKey(secret);
    const { token } = createShareToken(key);
    expect(verifyShareTokenFormat(key, token)).not.toBeNull();
    expect(verifyShareTokenFormat(secret, token)).toBeNull();
    expect(verifyShareTokenFormat(deriveShareTokenKey('other-secret-0000000000000000000'), token)).toBeNull();
    // Legacy tokens minted with the raw secret are invalidated by the fix.
    const legacy = createShareToken(secret);
    expect(verifyShareTokenFormat(key, legacy.token)).toBeNull();
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
