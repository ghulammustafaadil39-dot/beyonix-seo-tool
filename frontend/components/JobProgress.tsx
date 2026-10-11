// W-05: job-progress UI driven by useJobStream.
// Determinate bar when the job reports a percentage; indeterminate
// terminal-brand shimmer otherwise. Honest about the transport:
// shows "live" vs "refreshing" so a polling fallback never pretends SSE.
'use client';

import type { JobProgress, StreamMode } from '@/lib/useJobStream';

export default function JobProgress({
  event,
  mode,
  compact = false,
}: {
  event: JobProgress;
  mode: StreamMode;
  compact?: boolean;
}) {
  const terminalColor =
    event.status === 'failed'
      ? 'bg-red-400'
      : event.status === 'cancelled'
        ? 'bg-white/30'
        : 'bg-gradient-to-r from-cyan-300 to-teal-400';

  const statusLabel = (() => {
    switch (event.status) {
      case 'queued':
        return 'Queued';
      case 'running':
        return 'Running';
      case 'done':
        return 'Done';
      case 'failed':
        return 'Failed';
      case 'cancelled':
        return 'Cancelled';
      default:
        return 'Working';
    }
  })();

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Job ${statusLabel.toLowerCase()}${event.step ? `: ${event.step}` : ''}`}
      className={compact ? 'space-y-1.5' : 'bx-panel space-y-2'}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-xs text-white/60">
          {event.jobType ? <span className="text-teal-300">$ {event.jobType}</span> : '$ job'}{' '}
          · <span className={event.terminal ? 'text-white' : 'text-teal-300'}>{statusLabel}</span>
        </p>
        <div className="flex items-center gap-2">
          {event.progress !== null && (
            <span className="font-mono text-xs text-white/60" aria-hidden="true">
              {Math.round(event.progress)}%
            </span>
          )}
          <span
            className={`bx-pill ${mode === 'sse' ? 'bx-pill-ok' : mode === 'polling' ? 'bx-pill-warn' : 'bx-pill-info'}`}
            title={
              mode === 'sse'
                ? 'Live progress stream'
                : mode === 'polling'
                  ? 'Live stream unavailable — refreshing on a timer'
                  : 'Waiting for job status'
            }
          >
            <span className="bx-dot" />
            {mode === 'sse' ? 'live' : mode === 'polling' ? 'refreshing' : 'pending'}
          </span>
        </div>
      </div>

      {event.progress !== null ? (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(event.progress)}
          aria-label={event.step ?? 'Job progress'}
          className="bx-meter-track"
        >
          <div
            className={`h-full rounded-full transition-all duration-500 ${terminalColor}`}
            style={{ width: `${Math.round(event.progress)}%` }}
          />
        </div>
      ) : (
        <div className="bx-meter-track" aria-hidden="true">
          <div className="bx-shimmer h-full w-1/3 rounded-full bg-teal-400/60" />
        </div>
      )}

      {(event.step || event.message || event.error) && (
        <p className={`text-xs ${event.error ? 'text-red-300' : 'text-white/50'}`}>
          {event.error ?? event.step ?? event.message}
        </p>
      )}
    </div>
  );
}
