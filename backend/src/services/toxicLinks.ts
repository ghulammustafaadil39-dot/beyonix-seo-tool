import type { QueryFn } from '../db.js';
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

/**
 * Re-scores every active backlink of a site with the heuristic and stores
 * toxic_flags / toxic_score / referring_domain. Run after CSV upload and
 * after provider refresh. Pure CPU — no provider cost, no metering.
 */
export async function rescoreToxicLinks(
  tenantId: string,
  siteId: string,
  siteDomain: string,
  q: QueryFn,
): Promise<{ rescored: number; toxic: number }> {
  const r = await q(
    `SELECT id, source_url, anchor_text FROM backlinks WHERE tenant_id = $1 AND site_id = $2 AND status = 'active'`,
    [tenantId, siteId],
  );
  let toxic = 0;
  for (const row of r.rows) {
    const res = analyzeToxicity(row.source_url, row.anchor_text, siteDomain);
    let domain: string | null = null;
    try {
      domain = new URL(row.source_url).hostname.toLowerCase();
    } catch {
      domain = null;
    }
    await q(
      // tenant_id in the WHERE is defence-in-depth: the ids come from the
      // tenant-scoped SELECT above, but the UPDATE stays safe if that ever
      // changes (contract: no SQL on tenant tables without tenant_id).
      `UPDATE backlinks SET toxic_flags = $2::text[], toxic_score = $3, referring_domain = $4
       WHERE id = $1 AND tenant_id = $5`,
      [row.id, res.flags, res.score, domain, tenantId],
    );
    if (res.score >= TOXIC_THRESHOLD) toxic++;
  }
  return { rescored: r.rows.length, toxic };
}
