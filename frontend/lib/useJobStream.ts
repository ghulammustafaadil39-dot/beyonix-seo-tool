// W-05: SSE job-progress stream with graceful polling fallback.
//
// Backend contract (W-05, SSE endpoints built in parallel — exact payload
// lands with the backend branch; this hook normalizes defensively):
//   GET /api/v1/sites/:id/jobs/stream   (SSE, text/event-stream)
//   event types honored: 'progress' | 'job' | 'update' | 'snapshot' | 'message'
//   data: JSON with any of:
//     jobId | id        string  job identity
//     type | kind       string  e.g. 'audit' | 'report' | 'crawl' | 'content'
//     status | state    string  'queued'|'running'|'done'|'completed'|
//                                   'succeeded'|'failed'|'error'|'cancelled'
//     progress | percent|pct  number  0–100 (0–1 accepted and scaled)
//     step | label | stage    string  human step label
//     message          string  free text
//     error            string  terminal failure reason
//   terminal event names also honored: 'done' | 'complete' | 'completed'
//   ('error' event name is EventSource's transport error, not a job state).
//
// If the stream 404s (endpoint not merged yet) or the transport errors, the
// hook falls back to polling via the caller-supplied `poll` adapter — which
// is also how it works in environments without EventSource.
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
  /** Human step label, e.g. "Crawling page 41 of 120". */
  step: string | null;
  message: string | null;
  error: string | null;
  terminal: boolean;
}

export type StreamMode = 'idle' | 'sse' | 'polling';

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

/**
 * Normalize one SSE payload into a JobProgress. Exported for tests and for
 * the polling adapters (which fabricate the same shape).
 */
export function normalizeJobProgress(input: unknown): JobProgress | null {
  if (!input || typeof input !== 'object') return null;
  const r = input as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
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
   * is nothing to report). Used when SSE errors and in no-EventSource envs.
   */
  poll: () => Promise<JobProgress | null>;
  pollIntervalMs?: number;
  onTerminal?: (final: JobProgress) => void;
}

/**
 * Subscribe to job progress for a site. Prefers SSE; falls back to polling
 * on transport error or when the endpoint isn't merged yet (404 → the
 * EventSource simply errors and we poll).
 */
export function useJobStream({ siteId, enabled, poll, pollIntervalMs = 5000, onTerminal }: UseJobStreamOptions) {
  const [event, setEvent] = useState<JobProgress | null>(null);
  const [mode, setMode] = useState<StreamMode>('idle');
  const [streamFailed, setStreamFailed] = useState(false);
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;
  const pollRef = useRef(poll);
  pollRef.current = poll;

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

    const handlePayload = (data: unknown) => {
      if (stopped) return;
      const p = normalizeJobProgress(data);
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
            handlePayload(JSON.parse(e.data));
          } catch {
            // Non-JSON frame (e.g. ": ping") — ignore.
          }
        };
        es.onmessage = onMsg;
        for (const name of ['progress', 'job', 'update', 'snapshot', 'message']) {
          es.addEventListener(name, onMsg as EventListener);
        }
        for (const name of ['done', 'complete', 'completed']) {
          es.addEventListener(name, (e: Event) => {
            try {
              const p = normalizeJobProgress(JSON.parse((e as MessageEvent).data ?? '{}'));
              applyTerminal(p ?? { status: 'done', progress: 100, step: null, message: null, error: null, terminal: true });
            } catch {
              applyTerminal({ status: 'done', progress: 100, step: null, message: null, error: null, terminal: true });
            }
          });
        }
        es.onerror = () => {
          // 404 (endpoint not merged yet), network drop, etc. — poll instead.
          es?.close();
          es = null;
          void startPolling();
        };
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
