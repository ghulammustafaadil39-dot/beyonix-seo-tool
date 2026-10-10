'use client';

import { useEffect, useState } from 'react';
import { billingApi, settingsApi, PLAN_NAMES, type Subscription, type UsageInfo } from '@/lib/api';
import { useErrorReporter } from '@/components/ErrorBanner';

const PLANS = ['starter', 'growth', 'pro'] as const;

// Feature bullets mirror backend/src/plans.ts (the single source of truth).
// Prices are set in Stripe; checkout shows the final price.
const PLAN_FEATURES: Record<string, string[]> = {
  starter: [
    '1 site',
    '50 keywords tracked',
    '5,000 AI words / month',
    'Weekly rank checks',
    '20 AI visibility checks / month',
  ],
  growth: [
    '3 sites',
    '300 keywords tracked',
    '30,000 AI words / month',
    'Weekly rank checks',
    '100 AI visibility checks / month',
  ],
  pro: [
    '10 sites',
    '1,000 keywords tracked',
    '100,000 AI words / month',
    'Daily rank checks',
    '500 AI visibility checks / month',
  ],
};

// Plain-language names for usage meters (never show raw limit keys).
const LIMIT_LABELS: Record<string, { label: string; hint?: string }> = {
  sites: { label: 'Sites' },
  keywords_tracked: { label: 'Keywords tracked' },
  ai_words: {
    label: 'AI words',
    hint: 'Total words the AI writer may generate this month across content drafts, GEO checks and report summaries.',
  },
  audits_month: { label: 'Audits per month' },
  serp_checks: { label: 'Rank checks' },
  keyword_metrics: { label: 'Keyword lookups' },
  crawl_pages: { label: 'Crawled pages' },
  geo_checks: { label: 'AI visibility checks' },
};

export default function BillingPage() {
  const { report } = useErrorReporter();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'info'; text: string } | null>(null);

  useEffect(() => {
    // Stripe checkout redirects back with ?success=1 or ?canceled=1.
    const params = new URLSearchParams(window.location.search);
    if (params.get('success') === '1') {
      setNotice({ kind: 'success', text: '✓ Payment successful — your plan is now active.' });
    } else if (params.get('canceled') === '1') {
      setNotice({ kind: 'info', text: 'Checkout was canceled — no charge was made. You can retry anytime.' });
    }
    window.history.replaceState(null, '', window.location.pathname);
    (async () => {
      try {
        const [s, u] = await Promise.all([billingApi.subscription(), settingsApi.usage()]);
        setSub(s);
        setUsage(u);
      } catch (e) {
        report(e);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkout = async (planId: string) => {
    setBusyPlan(planId);
    try {
      const { url } = await billingApi.checkout(planId);
      window.location.href = url;
    } catch (e) {
      report(e);
      setBusyPlan(null);
    }
  };

  const openPortal = async () => {
    setPortalBusy(true);
    try {
      const { url } = await billingApi.portal();
      window.location.href = url;
    } catch (e) {
      report(e);
    } finally {
      setPortalBusy(false);
    }
  };

  if (loading) return <p className="font-mono text-sm text-white/40">$ loading billing…</p>;

  const currentPlan = sub?.plan_id ?? 'starter';
  const limits = usage?.limits ?? {};

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="bx-micro mb-1">~/ billing</p>
        <h1 className="bx-h1">Billing</h1>
      </div>

      {notice && (
        <div
          className={`flex items-center justify-between rounded-xl border px-4 py-3 ${
            notice.kind === 'success'
              ? 'border-teal-400/20 bg-teal-400/10'
              : 'border-white/10 bg-white/5'
          }`}
        >
          <p
            className={`text-sm font-medium ${
              notice.kind === 'success' ? 'text-teal-200' : 'text-white/70'
            }`}
          >
            {notice.text}
          </p>
          <button
            onClick={() => setNotice(null)}
            className="text-sm text-white/40 hover:text-white/70 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="bx-card">
        <p className="bx-micro mb-2">~/ current plan</p>
        <p className="mt-1 bg-gradient-to-r from-cyan-300 to-teal-400 bg-clip-text text-lg font-bold text-transparent">
          {PLAN_NAMES[currentPlan] ?? currentPlan}
        </p>
        <p className="mt-1 font-mono text-xs text-white/40">
          status: {sub?.status ?? 'no subscription yet'}
          {sub?.current_period_end &&
            ` · renews ${new Date(sub.current_period_end).toLocaleDateString()}`}
        </p>
        {sub && (
          <button
            onClick={openPortal}
            disabled={portalBusy}
            className="bx-btn-secondary mt-3"
          >
            {portalBusy ? 'Opening…' : 'Manage subscription'}
          </button>
        )}
      </div>

      <div className="bx-card">
        <p className="bx-micro mb-4">~/ usage this month</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(limits).map(([key, v]) => {
            const pct = v.limit > 0 ? Math.min(100, Math.round((v.used / v.limit) * 100)) : 0;
            const over = v.used >= v.limit;
            const meta = LIMIT_LABELS[key] ?? { label: key.replace(/_/g, ' ') };
            return (
              <div key={key}>
                <div className="flex justify-between text-xs">
                  <span className="font-medium text-white/60" title={meta.hint}>
                    {meta.label}
                    {meta.hint && <span className="text-white/30"> ⓘ</span>}
                  </span>
                  <span className={over ? 'font-mono font-semibold text-red-300' : 'font-mono text-white/40'}>
                    {v.used} / {v.limit}
                  </span>
                </div>
                <div className="bx-meter-track">
                  <div
                    className={over ? 'bx-meter-fill-over' : 'bx-meter-fill'}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
          {Object.keys(limits).length === 0 && (
            <p className="text-sm text-white/40">No usage data available.</p>
          )}
        </div>
      </div>

      <div>
        <p className="bx-micro mb-3">~/ plans</p>
        <div className="grid gap-4 md:grid-cols-3">
          {PLANS.map((plan) => (
            <div
              key={plan}
              className={`rounded-xl border p-5 ${
                currentPlan === plan
                  ? 'bx-glow border-teal-400/40 bg-[#06141d]'
                  : 'border-white/10 bg-[#06141d]'
              }`}
            >
              <div className="relative">
                <h3 className="text-base font-bold text-white">{PLAN_NAMES[plan]}</h3>
                <p className="mt-1 text-xs text-white/40">
                  {plan === 'starter' && 'For a single small business site.'}
                  {plan === 'growth' && 'For growing businesses with multiple sites.'}
                  {plan === 'pro' && 'For businesses that want daily tracking and more content.'}
                </p>
                <ul className="mt-3 space-y-1.5 font-mono text-xs text-white/60">
                  {PLAN_FEATURES[plan].map((f) => (
                    <li key={f} className="flex items-center gap-2">
                      <span className="text-teal-300">✓</span> {f}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-white/30">Price shown securely at checkout.</p>
                {currentPlan === plan ? (
                  <p className="bx-btn-primary mt-4 w-full cursor-default">
                    Current plan
                  </p>
                ) : (
                  <button
                    onClick={() => checkout(plan)}
                    disabled={busyPlan !== null}
                    className="bx-btn-primary mt-4 w-full"
                  >
                    {busyPlan === plan ? 'Redirecting…' : `Upgrade to ${PLAN_NAMES[plan]}`}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
