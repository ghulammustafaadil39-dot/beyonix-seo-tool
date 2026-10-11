// W-05: polling fallback adapters for useJobStream.
// Each fabricates the JobProgress shape from existing real endpoints —
// used when the SSE stream errors (or the endpoint isn't merged yet).
// No mock data: every adapter reads live API state.
import { auditsApi, reportsApi } from './api';
import { normalizeJobProgress, type JobProgress } from './useJobStream';

/** Latest audit's live state as a JobProgress (or null = nothing to watch). */
export async function auditPoll(siteId: string): Promise<JobProgress | null> {
  try {
    const res = await auditsApi.list(siteId);
    const audits = res.data ?? [];
    const active = audits.find((a) => a.status === 'queued' || a.status === 'running');
    const latest = active ?? audits[0];
    if (!latest) return null;
    return normalizeJobProgress({
      jobId: latest.id,
      type: 'audit',
      status: latest.status,
      step:
        latest.status === 'queued' || latest.status === 'running'
          ? `Crawling${latest.pages_crawled ? ` — ${latest.pages_crawled} pages so far` : ''}`
          : latest.status === 'done'
            ? `Finished — score ${latest.score ?? '—'}, ${latest.issues_count} issues`
            : latest.error || 'Audit failed',
      progress: latest.status === 'done' ? 100 : latest.status === 'queued' ? 0 : null,
    });
  } catch {
    return null; // transient — keep polling
  }
}

/**
 * Watch for a NEW report appearing after `baselineCount` was taken.
 * Terminal (done) the moment a fresh report lands.
 */
export function reportPoll(siteId: string, baselineCount: number) {
  return async (): Promise<JobProgress | null> => {
    try {
      const res = await reportsApi.list(siteId);
      const n = (res.data ?? []).length;
      if (n > baselineCount) {
        return normalizeJobProgress({
          type: 'report',
          status: 'done',
          progress: 100,
          step: 'Report ready',
        });
      }
      return normalizeJobProgress({ type: 'report', status: 'running', step: 'Building report…' });
    } catch {
      return null;
    }
  };
}
