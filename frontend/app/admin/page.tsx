'use client';

import { useEffect, useState } from 'react';
import { authApi } from '@/lib/api';
import { withMockFallback, notLandedYet } from '@/lib/mock';
import {
  mockTenants,
  mockFailedJobs,
  mockSpend,
  mockFlags,
  formatMoney,
  type AdminTenant,
  type FailedJob,
  type ProviderSpend,
  type FeatureFlag,
} from '@/lib/mock/admin';
import MockBanner from '@/components/MockBanner';
import UsageMeter from '@/components/UsageMeter';

/**
 * F-14 — Admin back-office: tenants, plans, usage, failed jobs, provider
 * spend, suspend/unsuspend, impersonation (audit-logged), feature flags,
 * system health, plan override, refund/credit helper.
 *
 * Fully mock-backed (bannered) until /api/v1/admin/* lands. Admin-only:
 * the page refuses to render data for non-admin roles.
 */
export default function AdminPage() {
  const [role, setRole] = useState<string | null>(null);
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [jobs, setJobs] = useState<FailedJob[]>([]);
  const [spend, setSpend] = useState<ProviderSpend[]>([]);
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [impersonateMsg, setImpersonateMsg] = useState('');
  const [refundMsg, setRefundMsg] = useState('');
  const [refundTenant, setRefundTenant] = useState('');
  const [refundAmount, setRefundAmount] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const me = await authApi.me();
        setRole(me.user.role);
        if (me.user.role === 'admin') {
          const [t, j, s, f] = await Promise.all([
            withMockFallback(() => notLandedYet<AdminTenant[]>(), mockTenants),
            withMockFallback(() => notLandedYet<FailedJob[]>(), mockFailedJobs),
            withMockFallback(() => notLandedYet<ProviderSpend[]>(), mockSpend),
            withMockFallback(() => notLandedYet<FeatureFlag[]>(), mockFlags),
          ]);
          setTenants(t.data);
          setJobs(j.data);
          setSpend(s.data);
          setFlags(f.data);
        }
      } catch {
        setRole('unknown');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const suspend = (t: AdminTenant) => {
    if (!confirm(`Suspend ${t.name}? Their account will be locked immediately.`)) return;
    setTenants((prev) =>
      prev.map((x) =>
        x.id === t.id ? { ...x, status: x.status === 'suspended' ? 'active' : 'suspended' } : x,
      ),
    );
  };

  const impersonate = (t: AdminTenant) => {
    // Real impersonation requires a server-issued, audit-logged session.
    setImpersonateMsg(
      `Impersonation of ${t.name} is pending the server endpoint — every impersonation session will be audit-logged when it lands.`,
    );
    setTimeout(() => setImpersonateMsg(''), 6000);
  };

  const issueRefund = (e: React.FormEvent) => {
    e.preventDefault();
    setRefundMsg(
      `Refund of $${refundAmount} for tenant ${refundTenant || '—'} is staged — the server refund/credit helper will execute it via Stripe when the endpoint lands.`,
    );
    setRefundTenant('');
    setRefundAmount('');
  };

  if (loading) return <p className="font-mono text-sm text-white/40">$ loading admin…</p>;
  if (role !== 'admin') {
    return (
      <div className="mx-auto max-w-xl">
        <div className="bx-alert-err">
          <p className="font-semibold">Access denied</p>
          <p className="mt-1 text-sm">This area is restricted to administrators.</p>
        </div>
      </div>
    );
  }

  const mrr = tenants.filter((t) => t.status === 'active').reduce((s, t) => s + t.mrr_cents, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <a href="/dashboard" className="text-sm text-white/40 hover:text-white/70 hover:underline">
        ← Back to dashboard
      </a>
      <div>
        <p className="bx-micro mb-1">~/ admin</p>
        <h1 className="bx-h1">Back office</h1>
      </div>
      <div><MockBanner label="admin back-office" /></div>

      {/* KPIs */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="bx-card">
          <p className="bx-micro">MRR</p>
          <p className="mt-1 font-mono text-2xl font-bold text-teal-300">{formatMoney(mrr)}</p>
        </div>
        <div className="bx-card">
          <p className="bx-micro">Tenants</p>
          <p className="mt-1 font-mono text-2xl font-bold text-white">{tenants.length}</p>
        </div>
        <div className="bx-card">
          <p className="bx-micro">Failed jobs</p>
          <p className="mt-1 font-mono text-2xl font-bold text-red-300">{jobs.length}</p>
        </div>
      </div>

      {/* Tenants */}
      <div className="bx-card">
        <p className="bx-micro mb-3">~/ tenants</p>
        <div className="bx-table-wrap">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-white/10">
                <th className="bx-th">Tenant</th>
                <th className="bx-th">Plan</th>
                <th className="bx-th">Status</th>
                <th className="bx-th">Sites</th>
                <th className="bx-th">MRR</th>
                <th className="bx-th">Actions</th>
              </tr>
            </thead>
            <tbody className="bx-tbody">
              {tenants.map((t) => (
                <tr key={t.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-white">{t.name}</p>
                    <p className="font-mono text-xs text-white/40">{t.email}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-white/70">{t.plan}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`bx-pill ${
                        t.status === 'active'
                          ? 'bx-pill-ok'
                          : t.status === 'past_due'
                            ? 'bx-pill-warn'
                            : 'bx-pill-err'
                      }`}
                    >
                      <span className="bx-dot" />
                      {t.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-white/70">{t.sites}</td>
                  <td className="px-4 py-3 font-mono text-white/70">{formatMoney(t.mrr_cents)}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1.5">
                      <button onClick={() => impersonate(t)} className="bx-btn-xs-secondary">
                        Impersonate
                      </button>
                      <button
                        onClick={() => suspend(t)}
                        className={t.status === 'suspended' ? 'bx-btn-xs-secondary' : 'bx-btn-xs-danger'}
                      >
                        {t.status === 'suspended' ? 'Unsuspend' : 'Suspend'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {impersonateMsg && <p className="bx-alert-info mt-3">{impersonateMsg}</p>}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Failed jobs */}
        <div className="bx-card">
          <p className="bx-micro mb-3">~/ jobs</p>
          <h2 className="text-base font-bold text-white">Failed jobs</h2>
          <ul className="mt-3 space-y-2">
            {jobs.map((j) => (
              <li key={j.id} className="bx-panel">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-sm text-white">
                    {j.queue} / {j.kind}
                  </p>
                  <button className="bx-btn-xs-secondary">Replay</button>
                </div>
                <p className="mt-1 font-mono text-xs text-white/40">
                  {j.tenant} · {new Date(j.failed_at).toLocaleString()}
                </p>
                <p className="mt-1 text-xs text-red-300/80">{j.error}</p>
              </li>
            ))}
            {jobs.length === 0 && <p className="text-sm text-white/40">No failed jobs.</p>}
          </ul>
        </div>

        {/* Provider spend */}
        <div className="bx-card">
          <p className="bx-micro mb-3">~/ spend</p>
          <h2 className="text-base font-bold text-white">Provider spend (this month)</h2>
          <div className="mt-3 space-y-4">
            {spend.map((s) => (
              <UsageMeter
                key={s.provider}
                label={s.provider}
                used={s.month_cents}
                limit={s.budget_cents}
              />
            ))}
          </div>
          <p className="bx-hint mt-2">
            Amounts shown in cents for precision; budgets are monthly caps.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Feature flags */}
        <div className="bx-card">
          <p className="bx-micro mb-3">~/ flags</p>
          <h2 className="text-base font-bold text-white">Feature flags</h2>
          <ul className="mt-3 space-y-2">
            {flags.map((f) => (
              <li key={f.key} className="bx-panel flex items-center justify-between gap-3">
                <div>
                  <p className="font-mono text-sm text-white">{f.key}</p>
                  <p className="text-xs text-white/50">{f.description} · rollout {f.rollout_pct}%</p>
                </div>
                <button
                  role="switch"
                  aria-checked={f.enabled}
                  aria-label={`Toggle flag ${f.key}`}
                  onClick={() =>
                    setFlags((prev) => prev.map((x) => (x.key === f.key ? { ...x, enabled: !x.enabled } : x)))
                  }
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${f.enabled ? 'bg-teal-400' : 'bg-white/15'}`}
                >
                  <span
                    className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${f.enabled ? 'left-[22px]' : 'left-0.5'}`}
                  />
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Refund helper */}
        <div className="bx-card">
          <p className="bx-micro mb-3">~/ refunds</p>
          <h2 className="text-base font-bold text-white">Refund / credit helper</h2>
          <form onSubmit={issueRefund} className="mt-3 space-y-3">
            <div>
              <label htmlFor="refund-tenant" className="bx-label">Tenant ID</label>
              <input
                id="refund-tenant"
                value={refundTenant}
                onChange={(e) => setRefundTenant(e.target.value)}
                placeholder="t1"
                className="bx-input font-mono"
              />
            </div>
            <div>
              <label htmlFor="refund-amount" className="bx-label">Amount (USD)</label>
              <input
                id="refund-amount"
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
                placeholder="29.00"
                inputMode="decimal"
                className="bx-input font-mono"
              />
            </div>
            <button type="submit" className="bx-btn-primary">
              Stage refund
            </button>
          </form>
          {refundMsg && <p className="bx-alert-info mt-3">{refundMsg}</p>}
        </div>
      </div>

      {/* Health */}
      <div className="bx-card">
        <p className="bx-micro mb-3">~/ health</p>
        <h2 className="text-base font-bold text-white">System health</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {[
            ['API', 'operational', true],
            ['Worker queues', 'operational', true],
            ['Stripe webhooks', 'operational', true],
          ].map(([name, status, ok]) => (
            <div key={name} className="bx-panel flex items-center justify-between">
              <span className="text-sm text-white/70">{name}</span>
              <span className={`bx-pill ${ok ? 'bx-pill-ok' : 'bx-pill-err'}`}>
                <span className="bx-dot" />
                {status}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
