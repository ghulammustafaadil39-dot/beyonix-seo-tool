// W-05: SSE job-progress stream with graceful polling fallback.
//
// REAL backend contract (merged; backend/src/routes/jobEvents.ts +
// backend/src/services/jobStream.ts — authoritative):
//   GET /api/v1/sites/:id/jobs/stream   (SSE, text/event-stream, cookie session)
//   `event: snapshot` → {
//       audits: [{ id, status, score, pagesCrawled, issuesCount,
//                   startedAt, finishedAt, progressPct }],
//       reports: [{ id, periodStart, periodEnd, createdAt }],
//       rankRun: { checksLast24h, latestCheckedAt, informational: true },
//       settled: boolean }
//     progressPct: 100 when done/failed, 50 when running, 0 otherwise
//       (honest — the crawler does not stream fine-grained progress).
//     ≤5 audits (newest first), ≤3 reports; rank window = last 24h.
//     rankRun is INFORMATIONAL ONLY (no rank job-status row exists): it never
//     drives terminal state or the progress bar.
//   `event: done` → { settled, at } — the stream CLOSES right after, INCLUDING
//     immediately when nothing is running (instant completion — the consumer
//     must treat the first done as "nothing to watch", not as a failure).
//   `event: error` → { message } — generic wire message, safe to display.
//   `: heartbeat <ISO>` comment frames — EventSource ignores them; no code.
//   Default poll 2s, hard cap 120s server-side.
//
// WIRE → JobProgress MAPPING (normalizeJobProgress):
//   snapshot, watchKind 'audit' (default — one stream per site, audit section
//   is the only one with real progress states):
//     active audit (first audits[] entry with status queued/running)
//       → { jobId, jobType 'audit', status, progress: progressPct,
//           step: running  → `Crawling — <n> pages so far`
//                 queued   → `Queued — waiting to start`
//                 done     → `Finished — score <s>, <n> issues`
//                 failed   → `Audit failed` (terminal),
//           message: `<n> rank checks in the last 24h (informational)`
//                    when rankRun.checksLast24h > 0 }
//     settled && audits[0] exists → terminal view of the latest audit
//       (progress 100, terminal true — drives instant completion on connect)
//     settled && no audits && reports[0] exists → terminal report view
//       { jobType 'report', status 'done', progress 100, step 'Report ready' }
//     settled && nothing at all → terminal idle
//       { jobType 'audit', status 'done', progress 100,
//         step 'No jobs running', terminal true }
//     !settled && no active audit (transient) → non-terminal indeterminate
//       { jobType 'audit', status 'running', progress null, step 'Working…' }
//   snapshot, watchKind 'report' (report-generation watcher; the audits
//   section is deliberately IGNORED — a report watch must never complete
//   just because audits settled):
//     reports.length > reportBaseline → terminal
//       { jobType 'report', status 'done', progress 100,
//         step 'Report ready', jobId: newest report id }
//     else → non-terminal
//       { jobType 'report', status 'running', progress null,
//         step 'Building report…' }
//   done { settled, at } (eventName 'done'):
//     watchKind 'audit'  → terminal { status 'done', progress 100 }
//     watchKind 'report' → NOT terminal via SSE (the backend cannot observe
//                          report completion); the hook falls back to polling.
//   error { message } (eventName 'error' ONLY — a bare { message } payload on
//   any other event keeps its legacy free-text meaning):
//     → terminal { status 'failed', error: message }
//
// LEGACY FALLBACK (kept — lib/jobPoll.ts fabricates this shape, and unknown
// future payloads still parse): per-job fields jobId|id, type|kind,
// status|state, progress|percent|pct (0–1 fractions scaled), step|label|stage,
// message, error. Terminal statuses: done/completed/succeeded/failed/error/
// cancelled. This path is now secondary; the real shapes above win on match.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { jobsApi } from './api';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface JobProgress {
  jobId?: string;
  jobType?: string;
  status: JobStatus;
  /** 0–100 or null when the job reports no percentage (indeterminate). */
  progress: number | null;
  /** Human step label, e.g. "Crawling — 41 pages so far". */
  step: string | null;
  message: string | null;
  error: string | null;
  terminal: boolean;
}

export type StreamMode = 'idle' | 'sse' | 'polling';

/** Which job the consumer is watching on the shared per-site stream. */
export type JobWatchKind = 'audit' | 'report';

export interface NormalizeOptions {
  watchKind?: JobWatchKind;
  /** For watchKind 'report': report count known when generation started. */
  reportBaseline?: number;
  /** SSE event name the payload arrived on ('snapshot' | 'done' | 'error' | …). */
  eventName?: string;
}

const TERMINAL = new Set(['done', 'completed', 'succeeded', 'failed', 'error', 'cancelled']);
const CANONICAL: Record<string, JobStatus> = {
  queued: 'queued',
  running: 'running',
  in_progress: 'running',
  done: 'done',
  completed: 'done',
  succeeded: 'done',
  failed: 'failed',
  error: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

interface AuditWire {
  id?: unknown;
  status?: unknown;
  score?: unknown;
  pagesCrawled?: unknown;
  issuesCount?: unknown;
  progressPct?: unknown;
}

function canonicalStatus(raw: unknown): JobStatus {
  const s = str(raw)?.toLowerCase() ?? null;
  return (s && CANONICAL[s]) || 'unknown';
}

/** Backend progressPct (100 done/failed, 50 running, 0 else), null-tolerant. */
function auditProgressPct(a: AuditWire): number {
  const p = a.progressPct;
  if (typeof p === 'number' && Number.isFinite(p)) return Math.max(0, Math.min(100, p));
  const s = str(a.status)?.toLowerCase();
  if (s === 'done' || s === 'failed') return 100;
  if (s === 'running') return 50;
  return 0;
}

function auditStep(a: AuditWire): string | null {
  const s = str(a.status)?.toLowerCase();
  const pages = typeof a.pagesCrawled === 'number' ? a.pagesCrawled : 0;
  const issues = typeof a.issuesCount === 'number' ? a.issuesCount : 0;
  const score = typeof a.score === 'number' ? String(a.score) : '—';
  switch (s) {
    case 'running':
      return `Crawling${pages ? ` — ${pages} pages so far` : ''}`;
    case 'queued':
      return 'Queued — waiting to start';
    case 'done':
      return `Finished — score ${score}, ${issues} issues`;
    case 'failed':
      return 'Audit failed';
    default:
      return null;
  }
}

/** Real `event: snapshot` → aggregate JobProgress (see mapping above). */
function snapshotToProgress(
  r: Record<string, unknown>,
  opts: NormalizeOptions,
): JobProgress | null {
  const audits = (r.audits as AuditWire[]).filter(isRecord);
  const reports = (Array.isArray(r.reports) ? r.reports : []).filter(isRecord);
  const settled = r.settled === true;
  const watchKind = opts.watchKind ?? 'audit';

  if (watchKind === 'report') {
    const baseline = opts.reportBaseline ?? 0;
    const newest = reports[0];
    if (reports.length > baseline) {
      return {
        jobId: str(newest?.id) ?? undefined,
        jobType: 'report',
        status: 'done',
        progress: 100,
        step: 'Report ready',
        message: null,
        error: null,
        terminal: true,
      };
    }
    return {
      jobId: undefined,
      jobType: 'report',
      status: 'running',
      progress: null,
      step: 'Building report…',
      message: null,
      error: null,
      terminal: false,
    };
  }

  // watchKind 'audit'
  const active = audits.find((a) => {
    const s = str(a.status)?.toLowerCase();
    return s === 'queued' || s === 'running';
  });
  const rankRun = isRecord(r.rankRun) ? r.rankRun : null;
  const checks = typeof rankRun?.checksLast24h === 'number' ? rankRun.checksLast24h : 0;
  const rankLine = checks > 0 ? `${checks} rank checks in the last 24h (informational)` : null;

  if (active) {
    const status = canonicalStatus(active.status);
    return {
      jobId: str(active.id) ?? undefined,
      jobType: 'audit',
      status,
      progress: auditProgressPct(active),
      step: auditStep(active),
      message: rankLine,
      error: null,
      terminal: status === 'failed' || status === 'cancelled',
    };
  }
  if (settled && audits[0]) {
    const latest = audits[0];
    const status = canonicalStatus(latest.status);
    return {
      jobId: str(latest.id) ?? undefined,
      jobType: 'audit',
      status,
      progress: auditProgressPct(latest),
      step: auditStep(latest),
      message: rankLine,
      error: status === 'failed' ? 'Audit failed' : null,
      terminal: true,
    };
  }
  if (settled && reports[0]) {
    return {
      jobId: str(reports[0].id) ?? undefined,
      jobType: 'report',
      status: 'done',
      progress: 100,
      step: 'Report ready',
      message: rankLine,
      error: null,
      terminal: true,
    };
  }
  if (settled) {
    return {
      jobId: undefined,
      jobType: 'audit',
      status: 'done',
      progress: 100,
      step: 'No jobs running',
      message: rankLine,
      error: null,
      terminal: true,
    };
  }
  // !settled but no active audit — transient; stay non-terminal.
  return {
    jobId: undefined,
    jobType: 'audit',
    status: 'running',
    progress: null,
    step: 'Working…',
    message: rankLine,
    error: null,
    terminal: false,
  };
}

/**
 * Normalize one SSE payload into a JobProgress. Real backend shapes
 * (snapshot / done / error) are matched first; the legacy per-job field
 * set is kept as fallback for the polling adapters (lib/jobPoll.ts).
 * Exported for tests and the polling adapters.
 */
export function normalizeJobProgress(input: unknown, opts: NormalizeOptions = {}): JobProgress | null {
  if (!isRecord(input)) return null;
  const r = input;

  // Real shape 1: `event: snapshot` data.
  if (Array.isArray(r.audits) && typeof r.settled === 'boolean') {
    return snapshotToProgress(r, opts);
  }

  // Real shape 2: `event: done` data { settled, at } — terminal, including
  // the instant-completion case (stream closes with nothing ever running).
  if (opts.eventName === 'done' && typeof r.settled === 'boolean' && typeof r.at === 'string') {
    if ((opts.watchKind ?? 'audit') === 'report') {
      // SSE cannot observe report completion — the hook degrades to polling.
      return null;
    }
    return {
      jobId: undefined,
      jobType: 'audit',
      status: 'done',
      progress: 100,
      step: r.settled ? 'All jobs settled' : 'Stream ended',
      message: null,
      error: null,
      terminal: true,
    };
  }

  // Real shape 3: `event: error` data { message } — generic, terminal.
  // Only on the 'error' event name: a bare { message } on any other event
  // keeps its legacy free-text meaning (see fallback below).
  if (opts.eventName === 'error') {
    const message = str(r.message) ?? 'Job stream error';
    return {
      jobId: str(r.jobId ?? r.id) ?? undefined,
      jobType: undefined,
      status: 'failed',
      progress: null,
      step: null,
      message: null,
      error: message,
      terminal: true,
    };
  }

  // Legacy fallback: per-job assumed shape (lib/jobPoll.ts fabricates this).
  const jobId = str(r.jobId ?? r.id);
  const jobType = str(r.type ?? r.kind);
  const rawStatus = str(r.status ?? r.state)?.toLowerCase() ?? null;
  const status = (rawStatus && CANONICAL[rawStatus]) || 'unknown';
  const terminal =
    (rawStatus !== null && TERMINAL.has(rawStatus)) || status === 'done' || status === 'failed' || status === 'cancelled';

  let progress: number | null = null;
  const rawPct = r.progress ?? r.percent ?? r.pct;
  if (typeof rawPct === 'number' && Number.isFinite(rawPct)) {
    // Accept both 0–1 fractions and 0–100 percentages.
    progress = rawPct <= 1 && rawPct > 0 ? rawPct * 100 : rawPct;
    progress = Math.max(0, Math.min(100, progress));
  }
  const step = str(r.step ?? r.label ?? r.stage);
  const message = str(r.message);
  const error = str(r.error);

  return {
    jobId: jobId ?? undefined,
    jobType: jobType ?? undefined,
    status,
    progress,
    step,
    message,
    error,
    terminal,
  };
}

interface UseJobStreamOptions {
  siteId: string;
  /** When false the stream/poller are torn down. */
  enabled: boolean;
  /**
   * Fallback poller returning the latest known progress (or null when there
   * is nothing to report). Used when SSE errors and in no-EventSource envs —
   * and for report watchers when the per-site stream settles (SSE cannot
   * observe report completion).
   */
  poll: () => Promise<JobProgress | null>;
  pollIntervalMs?: number;
  onTerminal?: (final: JobProgress) => void;
  /**
   * Which job the consumer watches. 'audit' (default): audits section drives
   * the view and the stream's terminal `done` completes the watch.
   * 'report': report count vs reportBaseline drives the view; a stream-level
   * `done` does NOT complete the watch — the hook falls back to polling.
   */
  watchKind?: JobWatchKind;
  /** For watchKind 'report': report count known when generation started. */
  reportBaseline?: number;
}

/**
 * Subscribe to job progress for a site. Prefers SSE; falls back to polling
 * on transport error or when the endpoint isn't merged yet (404 → the
 * EventSource simply errors and we poll).
 */
export function useJobStream({
  siteId,
  enabled,
  poll,
  pollIntervalMs = 5000,
  onTerminal,
  watchKind = 'audit',
  reportBaseline = 0,
}: UseJobStreamOptions) {
  const [event, setEvent] = useState<JobProgress | null>(null);
  const [mode, setMode] = useState<StreamMode>('idle');
  const [streamFailed, setStreamFailed] = useState(false);
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;
  const pollRef = useRef(poll);
  pollRef.current = poll;
  const watchKindRef = useRef(watchKind);
  watchKindRef.current = watchKind;
  const baselineRef = useRef(reportBaseline);
  baselineRef.current = reportBaseline;

  const applyTerminal = useCallback((final: JobProgress) => {
    setEvent(final);
    onTerminalRef.current?.(final);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setMode('idle');
      setEvent(null);
      setStreamFailed(false);
      return;
    }

    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const normOpts = (): NormalizeOptions => ({
      watchKind: watchKindRef.current,
      reportBaseline: baselineRef.current,
    });

    const handlePayload = (data: unknown, eventName?: string) => {
      if (stopped) return;
      const p = normalizeJobProgress(data, { ...normOpts(), eventName });
      if (!p) return;
      if (p.terminal) applyTerminal(p);
      else setEvent(p);
    };

    const startPolling = async () => {
      if (stopped || streamFailed) return;
      setStreamFailed(true);
      setMode('polling');
      const run = async () => {
        if (stopped) return;
        try {
          const p = await pollRef.current();
          if (stopped) return;
          if (!p) return;
          if (p.terminal) {
            applyTerminal(p);
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = null;
          } else {
            setEvent(p);
          }
        } catch {
          // Poll errors are transient — keep polling until disabled.
        }
      };
      await run();
      if (!stopped) pollTimer = setInterval(run, pollIntervalMs);
    };

    /** Stream-level `done`: terminal for audit watchers; report watchers
     * degrade to polling (SSE cannot observe report completion). */
    const handleStreamDone = () => {
      if (watchKindRef.current === 'report') {
        es?.close();
        es = null;
        void startPolling();
        return;
      }
      applyTerminal({
        status: 'done',
        progress: 100,
        step: null,
        message: null,
        error: null,
        terminal: true,
      });
    };

    if (typeof EventSource === 'undefined') {
      void startPolling();
    } else {
      setMode('sse');
      try {
        es = new EventSource(jobsApi.streamUrl(siteId), { withCredentials: true });
      } catch {
        void startPolling();
      }
      if (es) {
        const onMsg = (e: MessageEvent) => {
          try {
            handlePayload(JSON.parse(e.data), (e as MessageEvent).type || undefined);
          } catch {
            // Non-JSON frame (e.g. ": ping") — ignore.
          }
        };
        // 'snapshot' is the real per-site event; the rest are legacy
        // fallbacks for unknown producer shapes.
        for (const name of ['progress', 'job', 'update', 'snapshot', 'message']) {
          es.addEventListener(name, onMsg as EventListener);
        }
        for (const name of ['done', 'complete', 'completed']) {
          es.addEventListener(name, (e: Event) => {
            const data = (e as MessageEvent).data;
            if (typeof data === 'string') {
              try {
                const p = normalizeJobProgress(JSON.parse(data), {
                  ...normOpts(),
                  eventName: 'done',
                });
                if (p) {
                  if (p.terminal) applyTerminal(p);
                  else setEvent(p);
                  return;
                }
              } catch {
                // fall through to default terminal
              }
            }
            handleStreamDone();
          });
        }
        es.addEventListener('error', (e: Event) => {
          const data = (e as MessageEvent).data;
          if (typeof data === 'string') {
            // Real wire `event: error` — generic message, terminal.
            let p: JobProgress | null = null;
            try {
              p = normalizeJobProgress(JSON.parse(data), { ...normOpts(), eventName: 'error' });
            } catch {
              // fall through to default terminal
            }
            applyTerminal(
              p ?? {
                status: 'failed',
                progress: null,
                step: null,
                message: null,
                error: 'Job stream error',
                terminal: true,
              },
            );
          } else {
            // Transport error (404 endpoint-not-merged, network drop, …) —
            // poll instead.
            es?.close();
            es = null;
            void startPolling();
          }
        });
      }
    }

    return () => {
      stopped = true;
      es?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, siteId, pollIntervalMs]);

  const reset = useCallback(() => {
    setEvent(null);
    setMode('idle');
    setStreamFailed(false);
  }, []);

  return { event, mode, streamFailed, reset };
}
