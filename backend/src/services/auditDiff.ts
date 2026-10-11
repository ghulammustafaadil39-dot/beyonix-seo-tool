// Audit v2 helpers (F-02 / C-04): impact scoring + inter-crawl diffing.
// Pure — no DB, no network.

export type IssueSeverity = 'info' | 'warning' | 'error';

const SEVERITY_WEIGHTS: Record<IssueSeverity, number> = { error: 10, warning: 4, info: 1 };

/**
 * Impact score 1..100: severity weight amplified by page importance.
 * Page importance = 1 + log10(1 + inbound internal links); the homepage
 * gets an extra 1.5x (it shapes the whole site's first impression).
 */
export function impactScore(
  severity: IssueSeverity,
  inlinks: number,
  isHomepage: boolean,
): number {
  const weight = SEVERITY_WEIGHTS[severity] ?? 1;
  const importance = 1 + Math.log10(1 + Math.max(0, inlinks));
  const homeBoost = isHomepage ? 1.5 : 1;
  return Math.min(100, Math.max(1, Math.round(weight * importance * homeBoost * 2)));
}

export interface IssueKey {
  type: string;
  url: string;
}

export interface IssueDiff {
  /** issues in curr but not prev */
  newIssues: IssueKey[];
  /** issues in prev but not curr */
  resolved: IssueKey[];
  /** per-type {new, resolved} counts */
  byType: Record<string, { new: number; resolved: number }>;
}

/** Diff two audits' issue sets (keyed by type+url). Never throws. */
export function diffIssues(prev: IssueKey[], curr: IssueKey[]): IssueDiff {
  const key = (i: IssueKey): string => `${i.type}||${i.url}`;
  const prevSet = new Set(prev.map(key));
  const currSet = new Set(curr.map(key));
  const newIssues = curr.filter((i) => !prevSet.has(key(i)));
  const resolved = prev.filter((i) => !currSet.has(key(i)));
  const byType: Record<string, { new: number; resolved: number }> = {};
  for (const i of newIssues) {
    byType[i.type] ??= { new: 0, resolved: 0 };
    byType[i.type].new += 1;
  }
  for (const i of resolved) {
    byType[i.type] ??= { new: 0, resolved: 0 };
    byType[i.type].resolved += 1;
  }
  return { newIssues, resolved, byType };
}
