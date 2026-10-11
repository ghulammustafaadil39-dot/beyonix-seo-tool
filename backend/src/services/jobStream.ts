import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';

// W-05 backend: SSE job-progress snapshots built from EXISTING job state
// (audits table rows; reports appear when their row exists). No parallel
// job store is invented. Rank-check "runs" have no job-status row: their
// progress is approximated from rank_checks rows newer than the last 24h,
// and is therefore informational only (labeled as such).

export interface AuditSnapshot { id: string; status: string; score: number | null; pagesCrawled: number; issuesCount: number; startedAt: string | null; finishedAt: string | null; progressPct: number | null }
export interface ReportSnapshot { id: string; periodStart: string; periodEnd: string; createdAt: string }
export interface RankRunSnapshot { checksLast24h: number; latestCheckedAt: string | null; informational: true }
export interface JobsSnapshot {
  audits: AuditSnapshot[]; reports: ReportSnapshot[]; rankRun: RankRunSnapshot;
  settled: boolean; // true when no audit is queued/running for this site
}

function progressFor(status: string, startedAt: string | null, finishedAt: string | null): number | null {
  if (status === 'done' || status === 'failed') return 100;
  if (status === 'running') return 50; // honest: crawler does not stream fine-grained progress
  return 0;
}

export async function collectJobsSnapshot(tenantId: string, siteId: string, q: QueryFn = defaultQuery): Promise<JobsSnapshot> {
  const audits = await q(
    `SELECT id, status, score, pages_crawled, issues_count, started_at, finished_at
     FROM audits WHERE tenant_id = $1 AND site_id = $2
     ORDER BY COALESCE(finished_at, started_at, now()) DESC LIMIT 5`,
    [tenantId, siteId],
  );
  const reports = await q(
    `SELECT id, period_start, period_end, created_at FROM reports
     WHERE tenant_id = $1 AND site_id = $2 ORDER BY created_at DESC LIMIT 3`,
    [tenantId, siteId],
  );
  const rank = await q(
    `SELECT COUNT(*)::int AS c, MAX(rc.checked_at) AS latest
     FROM rank_checks rc JOIN keywords k ON k.id = rc.keyword_id
     WHERE rc.tenant_id = $1 AND k.site_id = $2 AND rc.checked_at >= now() - interval '24 hours'`,
    [tenantId, siteId],
  );
  const list = (audits.rows as any[]).map((a) => ({
    id: a.id, status: a.status, score: a.score ?? null, pagesCrawled: a.pages_crawled ?? 0,
    issuesCount: a.issues_count ?? 0, startedAt: a.started_at, finishedAt: a.finished_at,
    progressPct: progressFor(a.status, a.started_at, a.finished_at),
  }));
  // D1-L-15: `settled` must reflect ALL audits, not just the 5 most recent —
  // a 6th-oldest queued audit would otherwise be invisible and the client
  // would close the stream while a job is still pending.
  const pending = await q(
    `SELECT 1 FROM audits WHERE tenant_id = $1 AND site_id = $2 AND status IN ('queued', 'running') LIMIT 1`,
    [tenantId, siteId],
  );
  return {
    audits: list,
    reports: (reports.rows as any[]).map((r) => ({ id: r.id, periodStart: r.period_start, periodEnd: r.period_end, createdAt: r.created_at })),
    rankRun: { checksLast24h: Number(rank.rows[0]?.c ?? 0), latestCheckedAt: rank.rows[0]?.latest ?? null, informational: true },
    settled: (pending.rowCount ?? 0) === 0,
  };
}

export function snapshotHash(s: JobsSnapshot): string {
  return JSON.stringify([s.audits.map((a) => [a.id, a.status, a.pagesCrawled, a.issuesCount]), s.reports.map((r) => r.id), s.rankRun]);
}
