import { describe, it, expect } from 'vitest';
import { detectMention, geoScore } from '../src/services/geoService.js';
import { alreadyChecked } from '../src/services/geoJobs.js';
import { buildTemplateSummary, type ReportData } from '../src/services/reporter.js';
import { weekStart } from '../src/services/reportJobs.js';

describe('detectMention', () => {
  it('returns true when the brand name appears in the answer text', () => {
    expect(detectMention('I recommend Beyonix for AI development.', 'beyonix.com')).toBe(true);
  });

  it('returns true when the full domain appears in the answer text', () => {
    expect(detectMention('Visit acme.example.com for details.', 'acme.example.com')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectMention('Try BEYONIXSOLUTIONS, they are great.', 'BeyonixSolutions.com')).toBe(true);
    expect(detectMention('Beyonixsolutions is solid.', 'BEYONIXSOLUTIONS.COM')).toBe(true);
  });

  it('returns false for unrelated text', () => {
    expect(detectMention('I recommend a competitor for this task.', 'beyonixsolutions.com')).toBe(false);
  });
});

describe('geoScore', () => {
  it('computes hits/total * 100 rounded', async () => {
    const fakeQ = async () => ({ rows: [{ total: 4, hits: 1 }], rowCount: 1 });
    expect(await geoScore('t1', 's1', fakeQ)).toBe(25);
  });

  it('returns 0 when there are no checks', async () => {
    const fakeQ = async () => ({ rows: [{ total: 0, hits: 0 }], rowCount: 1 });
    expect(await geoScore('t1', 's1', fakeQ)).toBe(0);
  });
});

describe('buildTemplateSummary', () => {
  const data: ReportData = {
    auditScore: 82,
    openIssues: { error: 3, warning: 7, info: 12 },
    rankMoves: [
      { keyword: 'ai agency', from: 9, to: 6 },
      { keyword: 'build app', from: 4, to: 5 },
    ],
    newBacklinks: 5,
    lostBacklinks: 2,
    geoScore: 60,
    draftsInReview: 1,
  };

  it('contains the domain and key numbers', () => {
    const s = buildTemplateSummary(data, 'example.com');
    expect(s).toContain('example.com');
    expect(s).toContain('82');
    expect(s).toContain('3 errors');
    expect(s).toContain('5 new');
    expect(s).toContain('2 lost');
    expect(s).toContain('60%');
    expect(s).toContain('1');
  });
});

describe('weekStart', () => {
  it("returns Monday 2026-10-05 for Saturday '2026-10-10'", () => {
    expect(weekStart('2026-10-10')).toBe('2026-10-05');
  });

  it('returns the same day when given a Monday', () => {
    expect(weekStart('2026-10-12')).toBe('2026-10-12');
  });

  it("returns Monday 2026-10-05 for Sunday '2026-10-11'", () => {
    expect(weekStart('2026-10-11')).toBe('2026-10-05');
  });
});

describe('alreadyChecked', () => {
  it('returns true when a row is within the window', () => {
    const recent = new Date(Date.now() - 2 * 86_400_000);
    expect(alreadyChecked([{ checked_at: recent }], 7)).toBe(true);
  });

  it('returns false when all rows are older than the window', () => {
    const old = new Date(Date.now() - 10 * 86_400_000);
    expect(alreadyChecked([{ checked_at: old }], 7)).toBe(false);
  });

  it('returns false for an empty row set', () => {
    expect(alreadyChecked([], 7)).toBe(false);
  });

  it('accepts ISO string timestamps', () => {
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    expect(alreadyChecked([{ checked_at: recent }], 7)).toBe(true);
  });
});
