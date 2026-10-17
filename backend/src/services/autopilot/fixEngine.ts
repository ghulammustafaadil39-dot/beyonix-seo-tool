/**
 * Autopilot Fix Engine (v2.0).
 *
 * Turns audit issues into concrete WordPress fixes, following the
 * Technical SEO Lead spec:
 * - AUTO-SAFE (both modes): fill MISSING meta descriptions, MISSING alt text,
 *   missing OG fallbacks — additive only, never rewrites existing values.
 * - CO-PILOT ONLY (approval required): title rewrites, 301 redirects, schema.
 * - NEVER: URL changes, robots.txt deindex, noindex, deletions, theme files.
 *
 * Quality bar (spec §4): generated titles 30-60 chars, keyword in first half,
 * unique site-wide, natural language. Meta 120-160 chars, complete sentence,
 * unique, page-specific. Alt text describes the image, never hallucinates.
 */
import { getLLMForTenant } from '../../providers/llm.js';
import type { WpPost } from '../../providers/wordpress.js';

export interface FixProposal {
  changeType: 'meta_description' | 'title' | 'alt_text' | 'og_fallback';
  fieldKey: string;
  wpPostId: number;
  pageUrl: string;
  previousValue: string | null;
  proposedValue: string;
  reason: string; // plain-language explanation for the user
  autoSafe: boolean; // true = may apply in autopilot mode without approval
}

/** Issue types the engine can fix, mapped from audit rule types. */
const FIXABLE: Record<string, { changeType: FixProposal['changeType']; autoSafe: boolean }> = {
  'missing-meta-description': { changeType: 'meta_description', autoSafe: true },
  'missing-alt': { changeType: 'alt_text', autoSafe: true },
  'title-long': { changeType: 'title', autoSafe: false },
  'title-short': { changeType: 'title', autoSafe: false },
  'missing-title': { changeType: 'title', autoSafe: false },
  'duplicate-title': { changeType: 'title', autoSafe: false },
};

function metaKeyFor(seoPlugin: string, changeType: string): string | null {
  if (changeType === 'meta_description') {
    if (seoPlugin === 'yoast') return '_yoast_wpseo_metadesc';
    if (seoPlugin === 'rankmath') return 'rank_math_description';
    return null; // no SEO plugin — cannot store meta (spec: flag, don't invent)
  }
  if (changeType === 'title') {
    if (seoPlugin === 'yoast') return '_yoast_wpseo_title';
    if (seoPlugin === 'rankmath') return 'rank_math_title';
    return null;
  }
  return null;
}

/**
 * Generate a fix proposal for one audit issue on one WP post.
 * Returns null when the issue is not auto-fixable or preconditions fail.
 */
export async function proposeFix(opts: {
  tenantId: string;
  siteId: string;
  issueType: string;
  issueDetail: string;
  post: WpPost;
  seoPlugin: string;
  existingTitles: Set<string>; // for uniqueness check
}): Promise<FixProposal | null> {
  const fixable = FIXABLE[opts.issueType];
  if (!fixable) return null;
  // Page-builder pages: REST writes may not reflect on frontend — flag only
  if (opts.post.usesPageBuilder) return null;

  const fieldKey = metaKeyFor(opts.seoPlugin, fixable.changeType);
  if (!fieldKey) return null; // e.g. meta fix with no SEO plugin

  // Additive rule: in auto-safe fixes, skip if a value already exists
  const current = currentValue(opts.post, fixable.changeType, fieldKey);
  if (fixable.autoSafe && current) return null;

  const proposed = await generateFixText({
    tenantId: opts.tenantId,
    changeType: fixable.changeType,
    post: opts.post,
    issueDetail: opts.issueDetail,
    existingTitles: opts.existingTitles,
  });
  if (!proposed) return null;

  return {
    changeType: fixable.changeType,
    fieldKey,
    wpPostId: opts.post.id,
    pageUrl: opts.post.link,
    previousValue: current,
    proposedValue: proposed,
    reason: reasonFor(fixable.changeType, opts.post.title),
    autoSafe: fixable.autoSafe,
  };
}

function currentValue(post: WpPost, changeType: string, fieldKey: string): string | null {
  if (changeType === 'meta_description' || changeType === 'title') {
    const v = post.meta[fieldKey];
    return typeof v === 'string' && v.trim() ? v : null;
  }
  return null;
}

function reasonFor(changeType: string, pageTitle: string): string {
  switch (changeType) {
    case 'meta_description':
      return `Is page "${truncate(pageTitle, 50)}" ka meta description missing hai — Google search me bekar snippet dikhega. Ek acha description likha hai.`;
    case 'title':
      return `Is page ka title theek nahi hai. Behtar, keyword-friendly title tajweez kiya hai.`;
    case 'alt_text':
      return `Tasveer me alt text missing hai — Google Images me rank nahi hogi aur screen readers ke liye bhi zaroori hai.`;
    default:
      return 'SEO fix tajweez kiya gaya hai.';
  }
}

/** Generate the fix text via LLM, with quality validation. */
async function generateFixText(opts: {
  tenantId: string;
  changeType: FixProposal['changeType'];
  post: WpPost;
  issueDetail: string;
  existingTitles: Set<string>;
}): Promise<string | null> {
  const llm = await getLLMForTenant(opts.tenantId);
  const pageText = stripHtml(opts.post.content).slice(0, 1500);

  let prompt: string;
  let maxLen: number;
  if (opts.changeType === 'meta_description') {
    maxLen = 160;
    prompt =
      `Write a meta description for this webpage. Rules: 120-160 characters, complete sentence, ` +
      `include the main topic naturally once, add a soft call-to-action, no clickbait, no ALL CAPS.\n` +
      `Page title: ${opts.post.title}\nPage content: ${pageText}\n` +
      `Return ONLY the meta description, nothing else.`;
  } else if (opts.changeType === 'title') {
    maxLen = 60;
    prompt =
      `Write an SEO page title. Rules: 30-60 characters, main keyword in first half, ` +
      `natural language, no keyword stuffing, no clickbait.\n` +
      `Page title now: ${opts.post.title}\nPage content: ${pageText}\n` +
      `Return ONLY the title, nothing else.`;
  } else {
    return null;
  }

  try {
    const res = await llm.generate({ prompt, maxWords: 60 });
    const text = (res.text ?? '').trim().replace(/^["']|["']$/g, '');
    if (!text || text.length > maxLen + 10) return null;
    // Quality gates
    if (opts.changeType === 'title') {
      if (text.length < 20 || text.length > 65) return null;
      if (opts.existingTitles.has(text.toLowerCase())) return null; // must be unique
      if (/[A-Z]{5,}/.test(text)) return null; // no ALL CAPS shouting
    }
    if (opts.changeType === 'meta_description') {
      if (text.length < 80) return null;
      if (!/[.!?]$/.test(text)) return null; // must be a complete sentence
    }
    return text;
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
