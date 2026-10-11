'use client';

import { useEffect, useState } from 'react';
import {
  billingApi,
  settingsApi,
  PLAN_NAMES,
  type Subscription,
  type UsageInfo,
  type Invoice,
  type CancellationResult,
} from '@/lib/api';
import { useErrorReporter } from '@/components/ErrorBanner';
import { withMockFallback } from '@/lib/mock';
import {
  mockInvoices,
  mockBillingEmail,
  mockScheduleCancellation,
} from '@/lib/mock/billing';
import UsageMeter from '@/components/UsageMeter';
import MockBanner from '@/components/MockBanner';
import Modal from '@/components/Modal';
import PlanCards, { type PlanId } from '@/components/PlanCards';

// Plain-language names for usage meters (never show raw limit keys).
const LIMIT_LABELS: Record<string, { label: string; hint?: string }> = {
  sites: { label: 'Sites' },
  keywords_tracked: { label: 'Keywords tracked' },
  ai_words: {
    label: 'AI words',
    hint: 'Total words the AI writer may generate this billing period across content drafts, GEO checks and report summaries.',
  },
  audits_month: { label: 'Audits per month' },
  serp_checks: { label: 'Rank checks' },
  keyword_metrics: { label: 'Keyword lookups' },
  crawl_pages: { label: 'Crawled pages' },
  geo_checks: { label: 'AI visibility checks' },
};

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  }).format(amount / 100);
}

const CANCEL_REASONS = [
  'Too expensive',
  'Not using it enough',
  'Missing a feature I need',
  'Switching to another tool',
  'Technical issues',
  'Other',
];

function CancelFlow({ onClose }: { onClose: () => void }) {
  const { report } = useErrorReporter();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [reason, setReason] = useState('');
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(CancellationResult & { mock: boolean }) | null>(null);

  const confirm = async () => {
    setBusy(true);
    try {
      const { data, mock } = await withMockFallback(
        () => billingApi.cancelSubscription(reason === 'Other' ? other : reason),
        () => mockScheduleCancellation(reason === 'Other' ? other : reason),
      );
      setResult({ ...data, mock });
      setStep(3);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Cancel subscription" onClose={onClose}>
      {step === 1 && (
        <div>
          <p className="text-sm text-white/70">
            We&rsquo;re sorry to see you go. What&rsquo;s the main reason?
          </p>
          <div className="mt-4 space-y-2" role="radiogroup" aria-label="Cancellation reason">
            {CANCEL_REASONS.map((r) => (
              <label
                key={r}
                className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition ${
                  reason === r ? 'border-teal-400/40 bg-teal-400/10' : 'border-white/10 bg-white/5'
                }`}
              >
                <input
                  type="radio"
                  name="cancel-reason"
                  value={r}
                  checked={reason === r}
                  onChange={() => setReason(r)}
                  className="accent-teal-400"
                />
                <span className="text-white/85">{r}</span>
              </label>
            ))}
          </div>
          {reason === 'Other' && (
            <input
              value={other}
              onChange={(e) => setOther(e.target.value)}
              placeholder="Tell us briefly…"
              className="bx-input mt-3"
              aria-label="Other reason"
            />
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={onClose} className="bx-btn-secondary">
              Keep my plan
            </button>
            <button
              onClick={() => setStep(2)}
              disabled={!reason || (reason === 'Other' && !other.trim())}
              className="bx-btn-primary"
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <p className="bx-micro mb-2">~/ before you go</p>
          <div className="bx-panel space-y-2 text-sm text-white/70">
            <p>
              <strong className="text-white">Pause instead?</strong> Downgrading
              to Starter keeps your data and history for a fraction of the cost.
            </p>
            <p>
              <strong className="text-white">Need a feature?</strong> Tell us
              what&rsquo;s missing — the roadmap is driven by customer requests.
            </p>
            <p>
              <strong className="text-white">Annual billing</strong> saves two
              months vs monthly.
            </p>
          </div>
          <p className="mt-4 text-sm text-white/60">
            Cancellation takes effect at the end of your current billing period.
            Your data stays exportable, and nothing is deleted immediately.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => setStep(1)} className="bx-btn-secondary" disabled={busy}>
              Back
            </button>
            <button
              onClick={confirm}
              disabled={busy}
              className="bx-btn-xs-danger !px-4 !py-2 !text-sm"
            >
              {busy ? 'Working…' : 'Confirm cancellation'}
            </button>
          </div>
        </div>
      )}

      {step === 3 && result && (
        <div>
          {result.mock && <MockBanner label="cancellation" />}
          <div className="bx-alert-ok mt-3">
            <p className="font-medium">
              Cancellation scheduled for{' '}
              {new Date(result.cancel_at).toLocaleDateString()}.
            </p>
            <p className="mt-1 text-xs">
              You keep full access until then. Changed your mind? Just resubscribe
              from this page.
            </p>
          </div>
          <div className="mt-5 text-right">
            <button onClick={onClose} className="bx-btn-primary">
              Done
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function BillingPage() {
  const { report } = useErrorReporter();
  const [sub, setSub] = useState<Subscription | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [invoicesMock, setInvoicesMock] = useState(false);
  const [billingEmail, setBillingEmail] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [emailMock, setEmailMock] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'info'; text: string } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('success') === '1') {
      setNotice({ kind: 'success', text: 'Payment successful — your plan is now active.' });
    } else if (params.get('canceled') === '1') {
      setNotice({ kind: 'info', text: 'Checkout was canceled — no charge was made. You can retry anytime.' });
    } else {
      // Arrived from the public pricing page with a chosen plan.
      const plan = params.get('plan');
      const billing = params.get('billing') === 'annual' ? 'annual' : 'monthly';
      if (plan && ['starter', 'growth', 'pro'].includes(plan)) {
        setNotice({
          kind: 'info',
          text: `You picked the ${PLAN_NAMES[plan] ?? plan} plan (${billing} billing) — subscribe below to start your free trial.`,
        });
      }
    }
    window.history.replaceState(null, '', window.location.pathname);
    (async () => {
      try {
        const [s, u] = await Promise.all([billingApi.subscription(), settingsApi.usage()]);
        setSub(s);
        setUsage(u);
        const inv = await withMockFallback(
          () => billingApi.invoices().then((r) => r.data),
          mockInvoices,
        );
        setInvoices(inv.data);
        setInvoicesMock(inv.mock);
        const em = await withMockFallback(
          () => billingApi.billingEmail(),
          mockBillingEmail,
        );
        setBillingEmail(em.data.billing_email);
        setEmailDraft(em.data.billing_email ?? '');
        setEmailMock(em.mock);
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

  const saveBillingEmail = async () => {
    try {
      const { data, mock } = await withMockFallback(
        () => billingApi.updateBillingEmail(emailDraft.trim() || null),
        async () => ({ billing_email: emailDraft.trim() || null }),
      );
      setBillingEmail(data.billing_email);
      setEmailMock(mock);
      setEmailSaved(true);
      setTimeout(() => setEmailSaved(false), 3000);
    } catch (e) {
      report(e);
    }
  };

  if (loading) return <p className="font-mono text-sm text-white/40">$ loading billing…</p>;

  const currentPlan = (sub?.plan_id ?? null) as PlanId | null;
  const limits = usage?.limits ?? {};
  const hasSubscription = Boolean(sub);

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

      {/* Current plan */}
      <div className="bx-card">
        <p className="bx-micro mb-2">~/ current plan</p>
        <p className="mt-1 bg-gradient-to-r from-cyan-300 to-teal-400 bg-clip-text text-lg font-bold text-transparent">
          {currentPlan ? (PLAN_NAMES[currentPlan] ?? currentPlan) : 'No subscription yet'}
        </p>
        <p className="mt-1 font-mono text-xs text-white/40">
          status: {sub?.status ?? '—'}
          {sub?.current_period_end &&
            ` · renews ${new Date(sub.current_period_end).toLocaleDateString()}`}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={openPortal} disabled={portalBusy} className="bx-btn-secondary">
            {portalBusy ? 'Opening…' : 'Manage subscription (upgrade / downgrade)'}
          </button>
          {hasSubscription && (
            <button onClick={() => setCancelOpen(true)} className="bx-btn-xs-danger !px-3 !py-2 !text-sm">
              Cancel subscription
            </button>
          )}
        </div>
        <p className="bx-hint">
          Plan changes and billing-cadence switches are handled in the secure Stripe customer portal.
        </p>
      </div>

      {/* Usage with 80/100% states */}
      <div className="bx-card">
        <p className="bx-micro mb-4">~/ usage this billing period</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {Object.entries(limits).map(([key, v]) => {
            const meta = LIMIT_LABELS[key] ?? { label: key.replace(/_/g, ' ') };
            return (
              <UsageMeter key={key} label={meta.label} hint={meta.hint} used={v.used} limit={v.limit} />
            );
          })}
          {Object.keys(limits).length === 0 && (
            <p className="text-sm text-white/40">No usage data available.</p>
          )}
        </div>
      </div>

      {/* Plans */}
      <div>
        <p className="bx-micro mb-3">~/ plans</p>
        <PlanCards
          currentPlan={currentPlan}
          annual={false}
          onToggleAnnual={() => {}}
          showToggle={false}
          action={(plan, isCurrent) =>
            isCurrent ? (
              <p className="bx-btn-primary w-full cursor-default">Current plan</p>
            ) : !hasSubscription ? (
              <button
                onClick={() => checkout(plan)}
                disabled={busyPlan !== null}
                className="bx-btn-primary w-full"
              >
                {busyPlan === plan ? 'Redirecting…' : `Subscribe to ${PLAN_NAMES[plan]}`}
              </button>
            ) : (
              <button onClick={openPortal} disabled={portalBusy} className="bx-btn-secondary w-full">
                {portalBusy ? 'Opening…' : `Switch to ${PLAN_NAMES[plan]} via portal`}
              </button>
            )
          }
        />
        <p className="mt-3 text-center text-xs text-white/40">
          Have a coupon code? Enter it on the Stripe checkout page — it&rsquo;s
          applied before you pay.
        </p>
      </div>

      {/* Invoices */}
      <div className="bx-card">
        <p className="bx-micro mb-4">~/ invoices</p>
        {invoicesMock && <div className="mb-3"><MockBanner label="invoices" /></div>}
        {invoices && invoices.length > 0 ? (
          <div className="bx-table-wrap">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="bx-th">Invoice</th>
                  <th className="bx-th">Period</th>
                  <th className="bx-th">Amount</th>
                  <th className="bx-th">Status</th>
                </tr>
              </thead>
              <tbody className="bx-tbody">
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-4 py-3 font-mono text-white/80">{inv.number}</td>
                    <td className="px-4 py-3 font-mono text-xs text-white/50">
                      {new Date(inv.period_start).toLocaleDateString()} →{' '}
                      {new Date(inv.period_end).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 font-mono text-white/80">
                      {formatMoney(inv.amount, inv.currency)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`bx-pill ${
                          inv.status === 'paid' ? 'bx-pill-ok' : inv.status === 'open' ? 'bx-pill-warn' : 'bx-pill-info'
                        }`}
                      >
                        <span className="bx-dot" />
                        {inv.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-white/40">No invoices yet.</p>
        )}
      </div>

      {/* Billing email */}
      <div className="bx-card">
        <p className="bx-micro mb-2">~/ billing email</p>
        <p className="bx-body mb-3">
          Receipts and payment alerts go here (defaults to your account email).
        </p>
        {emailMock && <div className="mb-3"><MockBanner label="billing email" /></div>}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[240px] flex-1">
            <label htmlFor="billing-email" className="bx-label">
              Billing email
            </label>
            <input
              id="billing-email"
              type="email"
              value={emailDraft}
              onChange={(e) => setEmailDraft(e.target.value)}
              placeholder="billing@company.com"
              className="bx-input"
            />
          </div>
          <button
            onClick={saveBillingEmail}
            disabled={emailDraft === (billingEmail ?? '')}
            className="bx-btn-primary"
          >
            {emailSaved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </div>

      {cancelOpen && <CancelFlow onClose={() => setCancelOpen(false)} />}
    </div>
  );
}
