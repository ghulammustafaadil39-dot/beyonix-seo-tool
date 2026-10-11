'use client';

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { ApiError, billingApi } from '@/lib/api';

interface BannerState {
  message: string;
  /** Amber billing banner with a CTA to /dashboard/billing. */
  needsBilling: boolean;
  /** No-plan (trial-expired) copy vs plan-quota copy. */
  noPlan: boolean;
}

interface ErrorCtxValue {
  report: (e: unknown) => void;
  clear: () => void;
}

const ErrorCtx = createContext<ErrorCtxValue>({ report: () => {}, clear: () => {} });

export const useErrorReporter = () => useContext(ErrorCtx);

/** Wraps a page subtree; any reported ApiError is shown as a banner.
 *  402 LIMIT_EXCEEDED shows the upgrade banner linking to /dashboard/billing.
 *  E3-MED-1: 402 SUBSCRIPTION_REQUIRED (expired trial, no subscription) shows
 *  a subscribe banner linking to /dashboard/billing instead of a dead-end.
 *  F3 (pass#6): honest copy branches — "Plan limit reached." / "Upgrade plan"
 *  only for tenants that actually have a plan and hit a quota; trial-expired
 *  (no plan) tenants see "Free trial ended." / "Choose a plan". The backend's
 *  `upgrade` flag is honored so 403 READ_ONLY_MODE also gets a subscribe path
 *  (amber banner, not a generic red one), and READ_ONLY_MODE resolves the
 *  tenant's trial state so trial-expired tenants aren't told their usage
 *  exceeded plan limits. */
export function ErrorBannerProvider({ children }: { children: ReactNode }) {
  const [err, setErr] = useState<BannerState | null>(null);

  const report = useCallback((e: unknown) => {
    if (e instanceof ApiError) {
      const isSubRequired = e.code === 'SUBSCRIPTION_REQUIRED';
      // F3-L-2: honor the backend's upgrade flag — 403 READ_ONLY_MODE is sent
      // with { upgrade: true } and must render a subscribe path, not a
      // generic red banner. Keep the code list as fallback.
      const needsBilling = e.upgrade === true || isSubRequired;

      if (isSubRequired) {
        // F3-L-1: trial-expired, never-subscribed tenant — no plan exists to
        // have hit a limit, so don't say "Plan limit reached.".
        setErr({
          message: 'Your free trial has ended. Subscribe to continue using paid features.',
          needsBilling: true,
          noPlan: true,
        });
        return;
      }

      if (e.code === 'READ_ONLY_MODE') {
        // F3-L-3: the backend READ_ONLY_MODE copy blames "plan limits", which
        // is factually wrong for trial-expired tenants (read-only was flipped
        // because the trial ended, per requireSubscription). Resolve the
        // actual reason from the tenant's subscription state; fall back to
        // the server's message (accurate for over-limit tenants) when billing
        // state can't be read.
        void billingApi
          .subscription()
          .then((sub) => {
            const trialLapsed =
              !!sub?.tenant_trial_ends_at &&
              new Date(sub.tenant_trial_ends_at).getTime() <= Date.now();
            const hasLiveSub =
              !!sub && sub.status !== 'none' && sub.status !== 'canceled';
            const trialEnded = trialLapsed && !hasLiveSub;
            setErr({
              message: trialEnded
                ? 'Your trial has ended. Subscribe to keep making changes to your workspace.'
                : e.message,
              needsBilling: needsBilling || trialEnded,
              noPlan: trialEnded,
            });
          })
          .catch(() => {
            setErr({ message: e.message, needsBilling, noPlan: false });
          });
        return;
      }

      setErr({ message: e.message, needsBilling, noPlan: false });
      return;
    }
    if (e instanceof Error) {
      setErr({ message: e.message, needsBilling: false, noPlan: false });
    } else {
      setErr({ message: 'Something went wrong.', needsBilling: false, noPlan: false });
    }
  }, []);

  const clear = useCallback(() => setErr(null), []);

  return (
    <ErrorCtx.Provider value={{ report, clear }}>
      {err && (
        <div
          role="alert"
          className={`border-b px-4 py-3 text-sm ${
            err.needsBilling
              ? 'border-amber-400/20 bg-amber-400/10 text-amber-200'
              : 'border-red-400/20 bg-red-400/10 text-red-200'
          }`}
        >
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
            <div>
              {err.needsBilling && (
                <strong className="mr-2 font-semibold">
                  {err.noPlan ? 'Free trial ended.' : 'Plan limit reached.'}
                </strong>
              )}
              <span>{err.message}</span>
              {err.needsBilling && (
                <Link
                  href="/dashboard/billing"
                  className="bx-btn-primary ml-3 !px-3 !py-1 !text-xs"
                >
                  {err.noPlan ? 'Choose a plan' : 'Upgrade plan'}
                </Link>
              )}
            </div>
            <button
              onClick={clear}
              className="shrink-0 text-xs font-medium underline opacity-70 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {children}
    </ErrorCtx.Provider>
  );
}
