'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { loadOnboarding, type OnboardingStep, type OnboardingStatus } from '@/lib/onboarding';

/**
 * F-01 — guided onboarding checklist shown on the site dashboard.
 * Progress state comes from GET /api/v1/sites/:id/onboarding; while that
 * endpoint is being built, progress is computed locally from real APIs
 * (verify/GSC flags, audits, keywords, reports) and the panel notes the
 * contract endpoint as pending.
 */
const STATUS_STYLE: Record<OnboardingStatus, string> = {
  done: 'bx-pill-ok',
  current: 'bx-pill-violet',
  todo: 'bx-pill-info',
};

const STATUS_LABEL: Record<OnboardingStatus, string> = {
  done: 'Done',
  current: 'Next',
  todo: 'To do',
};

export default function OnboardingChecklist({ siteId }: { siteId: string }) {
  const [steps, setSteps] = useState<OnboardingStep[] | null>(null);
  const [pendingBackend, setPendingBackend] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { steps, pendingBackend } = await loadOnboarding(siteId);
        setSteps(steps);
        setPendingBackend(pendingBackend);
      } catch {
        setSteps(null);
      }
    })();
  }, [siteId]);

  if (!steps || steps.every((s) => s.status === 'done')) {
    if (dismissed || !steps) return null;
    // All done — collapsible congratulations card.
    return (
      <div className="bx-card flex items-center justify-between gap-3 border-teal-400/30">
        <p className="text-sm text-white/80">
          <span className="text-teal-300">✓</span> Onboarding complete — your
          site is set up and collecting data.
        </p>
        <button
          onClick={() => setDismissed(true)}
          className="text-sm text-white/40 hover:text-white/70 hover:underline"
        >
          Dismiss
        </button>
      </div>
    );
  }

  const doneCount = steps.filter((s) => s.status === 'done').length;
  const pct = Math.round((doneCount / steps.length) * 100);

  return (
    <section className="bx-card" aria-label="Onboarding checklist">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="bx-micro mb-1">~/ getting started</p>
          <h2 className="text-base font-bold text-white">Set up your site</h2>
        </div>
        <p className="font-mono text-xs text-white/40">
          {doneCount}/{steps.length} · {pct}%
        </p>
      </div>
      <div
        className="bx-meter-track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Onboarding progress"
      >
        <div className="bx-meter-fill" style={{ width: `${pct}%` }} />
      </div>
      <ol className="mt-4 space-y-2">
        {steps.map((s) => (
          <li
            key={s.key}
            className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 transition ${
              s.status === 'current'
                ? 'border-teal-400/30 bg-teal-400/5'
                : 'border-white/5 bg-white/[0.02]'
            }`}
          >
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs font-bold ${
                  s.status === 'done'
                    ? 'border-teal-400/40 bg-teal-400/10 text-teal-300'
                    : s.status === 'current'
                      ? 'border-violet-400/40 bg-violet-400/10 text-violet-300'
                      : 'border-white/10 text-white/40'
                }`}
              >
                {s.status === 'done' ? '✓' : steps.indexOf(s) + 1}
              </span>
              <span
                className={`text-sm font-medium ${
                  s.status === 'done' ? 'text-white/50 line-through' : 'text-white/90'
                }`}
              >
                {s.label}
              </span>
            </div>
            <span className="flex shrink-0 items-center gap-2">
              <span className={`bx-pill ${STATUS_STYLE[s.status]}`}>
                <span className="bx-dot" />
                {STATUS_LABEL[s.status]}
              </span>
              {s.status !== 'done' && (
                <Link href={s.href} className="bx-link text-xs">
                  {s.status === 'current' ? 'Start →' : 'Go →'}
                </Link>
              )}
            </span>
          </li>
        ))}
      </ol>
      {pendingBackend && (
        <p className="mt-3 font-mono text-[11px] text-white/30">
          progress computed locally — server checklist endpoint pending
        </p>
      )}
    </section>
  );
}
