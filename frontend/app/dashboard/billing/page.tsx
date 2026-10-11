'use client';

import { useEffect, useState } from 'react';
import {
  billingApi,
  settingsApi,
  PLAN_NAMES,
  type Subscription,
  type UsageInfo,
  type Invoice,
} from '@/lib/api';
import { useErrorReporter } from '@/components/ErrorBanner';
import UsageMeter from '@/components/UsageMeter';
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

const INVOICE_PILL: Record<Invoice['status'], string> = {
  paid: 'bx-pill-ok',
  open: 'bx-pill-warn',
  failed: 'bx-pill-err',
  refunded: 'bx-pill-info',
  void: 'bx-pill-info',
};

/**
 * Cancellation (F-11 wired): the backend has no DELETE-subscription
 * endpoint — cancellation is completed in the Stripe customer portal,
 * which flips `cancel_at_period_end` via webhook. This flow keeps the
 * retention steps, then hands off to the portal honestly instead of
 * pretending a cancellation was recorded here.
 */
function CancelFlow({ onClose }: { onClose: () => void }) {
  const { report } = useErrorReporter();
  const [step, setStep] = useState<1 | 2>(1);
  const [reason, setReason] = useState('');
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);

  const goToPortal = async () => {
    setBusy(true);
    try {
      const { url } = await billingApi.portal();
      window.location.href = url;
    } catch (e) {
      report(e);
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
            {[
              'Too expensive',
              'Not using it enough',
              'Missing a feature I need',
              'Switching to another tool',
              'Technical issues',
              'Other',
            ].map((r) => (
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
            You&rsquo;ll finish the cancellation in the secure Stripe billing
            portal — your data stays exportable, and nothing is deleted
            immediately.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => setStep(1)} className="bx-btn-secondary" disabled={busy}>
              Back
            </button>
            <button
              onClick={goToPortal}
              disabled={busy}
              className="bx-btn-xs-danger !px-4 !py-2 !text-sm"
            >
              {busy ? 'Opening portal…' : 'Continue to portal to cancel'}
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
  const [billingEmail, setBillingEmail] = useState<string | null>(null);
  const [emailDraft, setEmailDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);
  const [annual, setAnnual] = useState(false);
  const [coupon, setCoupon] = useState('');
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
      if (billing === 'annual') setAnnual(true);
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
        const [s, u, inv, settings] = await Promise.all([
          billingApi.subscription(),
          settingsApi.usage(),
          billingApi.invoices(),
          settingsApi.get(),
        ]);
        setSub(s);
        setUsage(u);
        setInvoices(inv.data);
        // No dedicated billing-email field exists in the backend: receipts
        // and dunning go to the tenant notification email (settings).
        setBillingEmail(settings.notify_email);
        setEmailDraft(settings.notify_email ?? '');
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
      const { url } = await billingApi.checkout(planId, {
        interval: annual ? 'annual' : 'monthly',
        couponCode: coupon.trim() ? coupon.trim().toUpperCase() : undefined,
      });
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
      const updated = await settingsApi.update({
        notify_email: emailDraft.trim() || null,
      });
      setBillingEmail(updated.notify_email);
      setEmailSaved(true);
      setTimeout(() => setEmailSaved(false), 3000);
    } catch (e) {
      report(e);
    }
  };

  if (loading) return <p className="font-mono text-sm text-white/40">$ loading billing…</p>;

  const currentPlan = sub && sub.status !== 'none' ? (sub.plan_id as PlanId) : null;
  const limits = usage?.limits ?? {};
  const hasSubscription = Boolean(sub && sub.status !== 'none');

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
          {sub?.billing_interval && ` · ${sub.billing_interval}`}
          {sub?.current_period_end &&
            ` · ${sub.cancel_at_period_end ? 'cancels' : 'renews'} ${new Date(sub.current_period_end).toLocaleDateString()}`}
          {sub?.trial_ends_at &&
            sub.status === 'trialing' &&
            ` · trial ends ${new Date(sub.trial_ends_at).toLocaleDateString()}`}
          {sub?.coupon_code && ` · coupon ${sub.coupon_code}`}
        </p>
        {sub?.status === 'past_due' && (
          <p className="bx-alert-err mt-3" role="alert">
            Your last payment failed.
            {sub.grace_until &&
              ` Your plan stays active until ${new Date(sub.grace_until).toLocaleDateString()} — please update your payment method in the portal.`}
          </p>
        )}
        {sub?.cancel_at_period_end && (
          <p className="bx-alert-warn mt-3">
            Cancellation is scheduled — you keep full access until{' '}
            {sub.current_period_end
              ? new Date(sub.current_period_end).toLocaleDateString()
              : 'the end of this period'}
            . Resubscribe from the portal to undo it.
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={openPortal} disabled={portalBusy} className="bx-btn-secondary">
            {portalBusy ? 'Opening…' : 'Manage subscription (upgrade / downgrade)'}
          </button>
          {hasSubscription && !sub?.cancel_at_period_end && (
            <button onClick={() => setCancelOpen(true)} className="bx-btn-xs-danger !px-3 !py-2 !text-sm">
              Cancel subscription
            </button>
          )}
        </div>
        <p className="bx-hint">
          Plan changes, billing-cadence switches, and cancellation are completed in the
          secure Stripe customer portal.
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
          annual={annual}
          onToggleAnnual={setAnnual}
          showToggle
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
        {!hasSubscription && (
          <div className="mx-auto mt-4 max-w-sm">
            <label htmlFor="coupon-code" className="bx-label">
              Coupon code (optional)
            </label>
            <input
              id="coupon-code"
              value={coupon}
              onChange={(e) => setCoupon(e.target.value)}
              placeholder="e.g. LAUNCH20"
              className="bx-input font-mono uppercase"
              autoComplete="off"
            />
            <p className="bx-hint">
              Applied at checkout and validated before you pay — an invalid code
              stops checkout with an explanation, no charge is made.
            </p>
          </div>
        )}
      </div>

      {/* Invoices */}
      <div className="bx-card">
        <p className="bx-micro mb-4">~/ invoices</p>
        {invoices === null ? (
          <p className="text-sm text-white/40">Loading invoices…</p>
        ) : invoices.length > 0 ? (
          <div className="bx-table-wrap">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="bx-th">Invoice</th>
                  <th className="bx-th">Period</th>
                  <th className="bx-th">Amount</th>
                  <th className="bx-th">Status</th>
                  <th className="bx-th">Receipt</th>
                </tr>
              </thead>
              <tbody className="bx-tbody">
                {invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-4 py-3 font-mono text-xs text-white/80">
                      {inv.stripe_invoice_id ?? inv.id.slice(0, 8)}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-white/50">
                      {inv.period_start && inv.period_end
                        ? `${new Date(inv.period_start).toLocaleDateString()} → ${new Date(inv.period_end).toLocaleDateString()}`
                        : new Date(inv.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 font-mono text-white/80">
                      {formatMoney(inv.amount_due_cents, inv.currency)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`bx-pill ${INVOICE_PILL[inv.status] ?? 'bx-pill-info'}`}>
                        <span className="bx-dot" />
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {inv.hosted_invoice_url ? (
                        <a
                          href={inv.hosted_invoice_url}
                          target="_blank"
                          rel="noreferrer"
                          className="bx-link text-xs"
                        >
                          View ↗
                        </a>
                      ) : (
                        <span className="text-xs text-white/30">—</span>
                      )}
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

      {/* Billing email — backed by the tenant notification email, which is
          where receipts and dunning notices are actually sent. */}
      <div className="bx-card">
        <p className="bx-micro mb-2">~/ billing email</p>
        <p className="bx-body mb-3">
          Receipts, payment-failure alerts, and weekly reports go to your account
          notification email.
        </p>
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
