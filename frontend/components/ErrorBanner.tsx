'use client';

import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { ApiError } from '@/lib/api';

interface BannerState {
  message: string;
  upgrade: boolean;
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
 *  a subscribe banner linking to /dashboard/billing instead of a dead-end. */
export function ErrorBannerProvider({ children }: { children: ReactNode }) {
  const [err, setErr] = useState<BannerState | null>(null);

  const report = useCallback((e: unknown) => {
    if (e instanceof ApiError) {
      const needsBilling = e.code === 'SUBSCRIPTION_REQUIRED';
      setErr({
        message: needsBilling
          ? 'Your free trial has ended. Subscribe to continue using paid features.'
          : e.message,
        upgrade: e.code === 'LIMIT_EXCEEDED' || needsBilling,
      });
    } else if (e instanceof Error) {
      setErr({ message: e.message, upgrade: false });
    } else {
      setErr({ message: 'Something went wrong.', upgrade: false });
    }
  }, []);

  const clear = useCallback(() => setErr(null), []);

  return (
    <ErrorCtx.Provider value={{ report, clear }}>
      {err && (
        <div
          role="alert"
          className={`border-b px-4 py-3 text-sm ${
            err.upgrade
              ? 'border-amber-400/20 bg-amber-400/10 text-amber-200'
              : 'border-red-400/20 bg-red-400/10 text-red-200'
          }`}
        >
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4">
            <div>
              {err.upgrade && (
                <strong className="mr-2 font-semibold">Plan limit reached.</strong>
              )}
              <span>{err.message}</span>
              {err.upgrade && (
                <Link
                  href="/dashboard/billing"
                  className="bx-btn-primary ml-3 !px-3 !py-1 !text-xs"
                >
                  Upgrade plan
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
