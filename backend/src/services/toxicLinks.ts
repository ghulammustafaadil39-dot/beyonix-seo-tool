// Heuristic toxic-link scoring (F-06).
// IMPORTANT: these are HEURISTICS, not a definitive toxicity verdict. The API
// labels every result as heuristic ("toxic_flags_heuristic"). Never present
// the score as a measured penalty risk.

export interface ToxicResult {
  /** 0..100 */
  score: number;
  flags: string[];
}

const SUSPICIOUS_TLDS = new Set([
  'xyz', 'top', 'click', 'link', 'gdn', 'loan', 'win', 'bid', 'country',
  'stream', 'download', 'review', 'trade', 'webcam', 'party', 'science',
  'cricket', 'date', 'faith', 'men', 'okinawa', 'racing', 'ren',
]);

const LINK_SCHEME_WORDS = ['seo', 'linkbuilding', 'backlink', 'backlinks', 'rankboost', 'seoservice'];
const SPAM_NICHE_WORDS = ['casino', 'porn', 'xxx', 'pills', 'pharma', 'payday', 'essay'];
const SPAMMY_ANCHOR_WORDS = ['buy', 'cheap', 'discount', 'free', 'viagra', 'cialis', 'loans', 'poker'];

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function tldOf(host: string): string {
  const parts = host.split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

/** Pure heuristic toxicity analysis of one backlink. Never throws. */
export function analyzeToxicity(
  sourceUrl: string,
  anchorText: string | null,
  targetDomain: string,
): ToxicResult {
  const flags: string[] = [];
  let score = 0;
  try {
    const host = hostOf(sourceUrl);
    if (!host) return { score: 0, flags: [] };
    const target = targetDomain.toLowerCase().replace(/^www\./, '');

    const tld = tldOf(host);
    if (SUSPICIOUS_TLDS.has(tld)) {
      flags.push('suspicious-tld');
      score += 30;
    }
    const bare = host.replace(/^www\./, '');
    if (LINK_SCHEME_WORDS.some((w) => bare.includes(w))) {
      flags.push('link-scheme-pattern');
      score += 25;
    }
    if (SPAM_NICHE_WORDS.some((w) => bare.includes(w))) {
      flags.push('spam-niche-pattern');
      score += 25;
    }
    // IP-literal hosts almost never link organically.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(bare) || bare.startsWith('[')) {
      flags.push('ip-host');
      score += 20;
    }
    const lower = sourceUrl.toLowerCase();
    if (lower.includes('replytocom') || lower.includes('/comments/') || lower.includes('?comment')) {
      flags.push('ugc-spam-pattern');
      score += 15;
    }
    const anchor = (anchorText ?? '').trim();
    if (anchor) {
      const a = anchor.toLowerCase();
      if (SPAMMY_ANCHOR_WORDS.some((w) => a.split(/\s+/).includes(w))) {
        flags.push('spammy-anchor');
        score += 15;
      }
      if (anchor.length > 60) {
        flags.push('overlong-anchor');
        score += 10;
      }
      // Exact-match commercial anchor from an unrelated domain.
      if (a === target || a.replace(/^www\./, '') === target) {
        // brand anchor — fine, no penalty
      }
    } else {
      flags.push('missing-anchor');
      score += 5;
    }
  } catch {
    return { score: 0, flags: [] };
  }
  return { score: Math.min(100, score), flags };
}

/** A link counts as toxic when the heuristic score reaches this threshold. */
export const TOXIC_THRESHOLD = 50;
