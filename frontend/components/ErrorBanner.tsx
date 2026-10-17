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
  /** L3-L-1/L3-L-2 (pass#12): headline override — "Plan limit reached."
      is wrong when the cause is a failed/incomplete payment, not quota. */
  title?: string;
  /** Which API endpoint failed — shown in small text for debugging. */
  path?: string;
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
            // K3-L-1 (pass#11): 'incomplete' means the first payment never
            // succeeded (fail-closed, G5-M#1) — not a plan limit. Point at
            // the billing page where the recovery CTA lives.
            const incomplete = sub?.status === 'incomplete';
            // L3-L-2 (pass#12): grace-consumed past_due (downgraded after
            // failed retries) is read-only because the payment failed —
            // not because a quota was hit.
            const pastDueConsumed = sub?.status === 'past_due' && !sub?.grace_until;
            setErr({
              message: incomplete
                ? 'Your payment hasn\u2019t completed yet — your account is read-only until it succeeds. Complete the payment on the billing page.'
                : trialEnded
                  ? 'Your trial has ended. Subscribe to keep making changes to your workspace.'
                  : pastDueConsumed
                    ? 'Your last payment failed and your account is read-only. Update your payment method on the billing page to restore full access.'
                    : e.message,
              needsBilling: needsBilling || trialEnded || incomplete || pastDueConsumed,
              noPlan: trialEnded,
              title: incomplete
                ? 'Payment incomplete.'
                : pastDueConsumed
                  ? 'Payment failed.'
                  : undefined,
            });
          })
          .catch(() => {
            setErr({ message: e.message, needsBilling, noPlan: false });
          });
        return;
      }

      setErr({ message: e.message, needsBilling, noPlan: false, path: e.path });
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
                  {err.title ?? (err.noPlan ? 'Free trial ended.' : 'Plan limit reached.')}
                </strong>
              )}
              <span>{err.message}</span>
              {err.path && (
                <span className="ml-2 font-mono text-xs opacity-60">({err.path})</span>
              )}
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
