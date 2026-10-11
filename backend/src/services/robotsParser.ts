// Proper robots.txt parser (C-04, RFC 9309-style).
// - Groups: consecutive `user-agent` lines share the rules that follow them.
//   A `user-agent` line appearing AFTER rules starts a NEW group.
// - A group matches a crawler when one of its agents is '*' or is a
//   case-insensitive PREFIX of the crawler's user-agent string.
// - Rules: longest match wins; on equal length, allow beats disallow.
// - crawl-delay honored per group (seconds; fractional values allowed).
// Pure — no network — fully unit-testable.

export interface RobotsGroup {
  /** lowercase agent patterns, e.g. ['*'] or ['googlebot'] */
  userAgents: string[];
  allows: string[];
  disallows: string[];
  /** seconds, null when not specified */
  crawlDelay: number | null;
}

function stripComments(line: string): string {
  // A '#' starts a comment unless inside a quoted value (robots values are
  // never quoted, so a plain split is correct).
  return line.split('#')[0].trim();
}

/** Parse a robots.txt body into groups. Never throws. */
export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let currentAgents: string[] = [];
  let current: RobotsGroup | null = null;

  const startNewGroup = (): RobotsGroup => {
    const g: RobotsGroup = { userAgents: [], allows: [], disallows: [], crawlDelay: null };
    groups.push(g);
    return g;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComments(raw);
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      const agent = value.toLowerCase();
      if (!agent) continue;
      if (current && currentAgents.length > 0 && (current.allows.length > 0 || current.disallows.length > 0 || current.crawlDelay !== null)) {
        // Rules already attached to the pending group: this UA starts a new group.
        current = startNewGroup();
        currentAgents = [];
      }
      if (!current) {
        current = startNewGroup();
        currentAgents = [];
      }
      current.userAgents.push(agent);
      currentAgents = current.userAgents;
      continue;
    }
    if (!current) continue; // rules before any user-agent line are ignored (RFC 9309)

    if (field === 'disallow') {
      if (value) current.disallows.push(value);
      // empty disallow = allow all; recorded as nothing
    } else if (field === 'allow') {
      if (value) current.allows.push(value);
    } else if (field === 'crawl-delay') {
      const n = parseFloat(value);
      if (Number.isFinite(n) && n >= 0 && current.crawlDelay === null) {
        current.crawlDelay = n;
      }
    }
    // sitemap: lines are handled by the sitemap service, not here.
  }
  return groups;
}

/** Groups that apply to the given crawler user-agent (specific beats '*'). */
export function matchingGroups(groups: RobotsGroup[], userAgent: string): RobotsGroup[] {
  const ua = userAgent.toLowerCase();
  const specific = groups.filter((g) => g.userAgents.some((a) => a !== '*' && ua.startsWith(a)));
  if (specific.length > 0) return specific;
  return groups.filter((g) => g.userAgents.includes('*'));
}

function ruleMatchesPath(rule: string, path: string): boolean {
  // Simple prefix match on path+query (RFC 9309 octets, no decoding games).
  return path.startsWith(rule);
}

/**
 * Longest-match-wins access decision. Returns true when crawling is allowed.
 * No matching group => allowed (RFC 9309 default).
 */
export function isAllowedUrl(groups: RobotsGroup[], userAgent: string, url: string): boolean {
  const matched = matchingGroups(groups, userAgent);
  if (matched.length === 0) return true;
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return false;
  }
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const g of matched) {
    for (const a of g.allows) if (ruleMatchesPath(a, path)) bestAllow = Math.max(bestAllow, a.length);
    for (const d of g.disallows) if (ruleMatchesPath(d, path)) bestDisallow = Math.max(bestDisallow, d.length);
  }
  if (bestAllow === -1 && bestDisallow === -1) return true;
  return bestAllow >= bestDisallow;
}

/** Crawl-delay in seconds for the crawler (max across matching groups, else null). */
export function crawlDelayFor(groups: RobotsGroup[], userAgent: string): number | null {
  const matched = matchingGroups(groups, userAgent);
  const delays = matched.map((g) => g.crawlDelay).filter((d): d is number => d !== null);
  if (delays.length === 0) return null;
  return Math.max(...delays);
}

/** Extract sitemap: URLs from a robots.txt body (used by the sitemap service). */
export function sitemapUrlsFromRobots(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComments(raw);
    const m = line.match(/^sitemap\s*:\s*(\S+)$/i);
    if (m) out.push(m[1]);
  }
  return out;
}
