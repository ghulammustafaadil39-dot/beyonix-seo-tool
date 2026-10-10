import { describe, it, expect } from 'vitest';
import { renderPrompt } from '../src/services/prompt.js';
import { estimateWords, buildGeoHtml } from '../src/services/contentEngine.js';
import { canAffordAiWords } from '../src/routes/content.js';
import { parseSuggestions } from '../src/routes/onpage.js';

describe('renderPrompt (real prompt templates)', () => {
  it('interpolates content-outline vars', async () => {
    const out = await renderPrompt('content-outline', {
      keyword: 'plumber marketing',
      title: 'How plumbers get more jobs',
      tone: 'friendly professional',
      siteDomain: 'example.com',
    });
    expect(out).toContain('plumber marketing');
    expect(out).toContain('How plumbers get more jobs');
    expect(out).toContain('friendly professional');
    expect(out).toContain('example.com');
    expect(out).not.toContain('{{keyword}}');
    expect(out).not.toContain('{{siteDomain}}');
  });

  it('interpolates content-draft vars', async () => {
    const out = await renderPrompt('content-draft', {
      keyword: 'plumber marketing',
      title: 'How plumbers get more jobs',
      outline: '## Intro\nOne line.',
      tone: 'plain',
      targetWords: 1500,
    });
    expect(out).toContain('plumber marketing');
    expect(out).toContain('## Intro');
    expect(out).toContain('1500');
    expect(out).not.toContain('{{outline}}');
  });

  it('interpolates onpage-suggest vars', async () => {
    const out = await renderPrompt('onpage-suggest', {
      url: 'https://example.com/pricing',
      title: 'Pricing',
      metaDescription: 'Our prices',
      h1: 'Pricing plans',
      textExcerpt: 'Some page text',
      issues: 'missing alt',
    });
    expect(out).toContain('https://example.com/pricing');
    expect(out).toContain('missing alt');
    expect(out).not.toContain('{{url}}');
  });
});

describe('estimateWords', () => {
  it('counts whitespace-separated words', () => {
    expect(estimateWords('hello world foo')).toBe(3);
  });
  it('handles extra whitespace and newlines', () => {
    expect(estimateWords('  hello\n\nworld\tfoo  ')).toBe(3);
  });
  it('returns 0 for empty/blank text', () => {
    expect(estimateWords('')).toBe(0);
    expect(estimateWords('   ')).toBe(0);
  });
});

describe('buildGeoHtml', () => {
  const md = [
    '## What is local SEO?',
    '',
    'Local SEO helps small businesses appear in nearby searches.',
    '',
    '- Claim your profile',
    '- Get reviews',
    '',
    '### Why it matters',
    '',
    'Customers search with **local intent** every day.',
    '',
    '## FAQ',
    '',
    '**What is local SEO?** It is the practice of optimizing for nearby searches.',
    'It covers profiles, reviews, and citations.',
    '',
    '2. How long does it take? Usually three to six months.',
  ].join('\n');

  it('converts ## headings to <h2>', () => {
    const html = buildGeoHtml(md, 'Local SEO Guide');
    expect(html).toContain('<h2>What is local SEO?</h2>');
    expect(html).toContain('<h3>Why it matters</h3>');
  });

  it('converts dash lists to <li>', () => {
    const html = buildGeoHtml(md, 'Local SEO Guide');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>Claim your profile</li>');
    expect(html).toContain('<li>Get reviews</li>');
  });

  it('converts **bold** and paragraphs', () => {
    const html = buildGeoHtml(md, 'Local SEO Guide');
    expect(html).toContain('<strong>local intent</strong>');
    expect(html).toContain('<p>Local SEO helps small businesses appear in nearby searches.</p>');
  });

  it('appends FAQPage JSON-LD for the FAQ section', () => {
    const html = buildGeoHtml(md, 'Local SEO Guide');
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('FAQPage');
    expect(html).toContain('What is local SEO?');
    expect(html).toContain('How long does it take?');
  });

  it('omits FAQ script when no FAQ section exists', () => {
    const html = buildGeoHtml('## Hello\n\nJust text.', 'T');
    expect(html).not.toContain('FAQPage');
  });

  it('wraps in a full HTML doc with <title>', () => {
    const html = buildGeoHtml('## Hello', 'My Title & Stuff');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>My Title &amp; Stuff</title>');
    expect(html).toContain('</html>');
  });
});

describe('canAffordAiWords', () => {
  it('returns true when estimate fits within the limit', () => {
    expect(canAffordAiWords(100, 5000, 1500)).toBe(true);
  });
  it('returns true at the exact boundary', () => {
    expect(canAffordAiWords(3500, 5000, 1500)).toBe(true);
  });
  it('returns false when estimate exceeds the limit', () => {
    expect(canAffordAiWords(4000, 5000, 1500)).toBe(false);
  });
  it('returns false when already at the limit', () => {
    expect(canAffordAiWords(5000, 5000, 800)).toBe(false);
  });
});

describe('parseSuggestions', () => {
  it('parses valid JSON', () => {
    expect(parseSuggestions('{"title":"abc","a":1}')).toEqual({ title: 'abc', a: 1 });
  });
  it('falls back to {raw} on invalid JSON', () => {
    expect(parseSuggestions('not json at all')).toEqual({ raw: 'not json at all' });
  });
  it('falls back to {raw} on empty string', () => {
    expect(parseSuggestions('')).toEqual({ raw: '' });
  });
});
