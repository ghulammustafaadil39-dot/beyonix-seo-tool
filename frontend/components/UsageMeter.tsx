'use client';

/**
 * Usage meter with three states: normal (<80%), warning (80–99%),
 * exhausted (>=100%). Never shows raw backend limit keys.
 */
export default function UsageMeter({
  label,
  hint,
  used,
  limit,
}: {
  label: string;
  hint?: string;
  used: number;
  limit: number;
}) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const state = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : 'ok';
  return (
    <div>
      <div className="flex justify-between gap-2 text-xs">
        <span className="font-medium text-white/60" title={hint}>
          {label}
          {hint && <span className="text-white/50"> ⓘ</span>}
        </span>
        <span
          className={`font-mono ${
            state === 'over'
              ? 'font-semibold text-red-300'
              : state === 'warn'
                ? 'font-semibold text-amber-300'
                : 'text-white/55'
          }`}
        >
          {used} / {limit}
        </span>
      </div>
      <div
        className="bx-meter-track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} usage`}
      >
        <div
          className={
            state === 'over' ? 'bx-meter-fill-over' : state === 'warn' ? 'bx-meter-fill-warn' : 'bx-meter-fill'
          }
          style={{ width: `${pct}%` }}
        />
      </div>
      {state === 'over' && (
        <p className="mt-1 text-xs text-red-300">
          Limit reached — this feature is paused until next month or an upgrade.
        </p>
      )}
      {state === 'warn' && (
        <p className="mt-1 text-xs text-amber-300">
          Over 80% used — consider upgrading before it runs out.
        </p>
      )}
    </div>
  );
}
