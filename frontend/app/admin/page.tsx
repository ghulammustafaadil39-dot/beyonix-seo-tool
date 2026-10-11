'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  adminApi,
  ApiError,
  PLAN_NAMES,
  type AdminAuditEntry,
  type AdminFailedJob,
  type AdminSpendTotal,
  type AdminTenant,
  type AdminTenantDetail,
  type FeatureFlag,
} from '@/lib/api';
import Modal from '@/components/Modal';

function formatMoney(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

type Gate = 'loading' | 'ready' | 'notfound' | 'error';

type ActionState =
  | { kind: 'suspend'; tenant: AdminTenant }
  | { kind: 'plan'; tenant: AdminTenant }
  | { kind: 'credit'; tenant: AdminTenant }
  | { kind: 'impersonate'; tenant: AdminTenant }
  | null;

function tenantStatus(t: AdminTenant): { label: string; pill: string } {
  if (t.suspended_at) return { label: 'suspended', pill: 'bx-pill-err' };
  if (t.sub_status === 'past_due') return { label: 'past_due', pill: 'bx-pill-warn' };
  if (t.sub_status) return { label: t.sub_status, pill: 'bx-pill-ok' };
  return { label: 'no subscription', pill: 'bx-pill-info' };
}

/**
 * F-14 — Admin back-office (WIRED, Wave 2): tenants, suspend/unsuspend,
 * plan override, credits, impersonation (audit-logged), failed jobs
 * (DLQ), provider spend, feature flags, admin audit log.
 *
 * Access model: the API returns 404 (not 403) for non-platform-admins so
 * the back-office is not discoverable — this page renders a plain
 * not-found state in that case. There is no client-side role flag to
 * trust: /api/v1/auth/me does not expose one.
 */
export default function AdminPage() {
  const [gate, setGate] = useState<Gate>('loading');
  const [gateError, setGateError] = useState('');
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [tenantTotal, setTenantTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [jobs, setJobs] = useState<AdminFailedJob[]>([]);
  const [spendTotals, setSpendTotals] = useState<AdminSpendTotal[]>([]);
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [audit, setAudit] = useState<AdminAuditEntry[]>([]);
  const [detail, setDetail] = useState<AdminTenantDetail | null>(null);
  const [action, setAction] = useState<ActionState>(null);
  const [reason, setReason] = useState('');
  const [planId, setPlanId] = useState('growth');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');

  const note = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(''), 4000);
  };

  const loadAll = useCallback(async (q = '') => {
    const t = await adminApi.tenants(1, 50, q);
    setTenants(t.data);
    setTenantTotal(t.total);
    const [j, s, f, a] = await Promise.allSettled([
      adminApi.failedJobs(1, 20),
      adminApi.spend(1, 20),
      adminApi.featureFlags(),
      adminApi.auditLog(1, 20),
    ]);
    if (j.status === 'fulfilled') setJobs(j.value.data);
    if (s.status === 'fulfilled') setSpendTotals(s.value.totals);
    if (f.status === 'fulfilled') setFlags(f.value.data);
    if (a.status === 'fulfilled') setAudit(a.value.data);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await loadAll();
        setGate('ready');
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          // Deliberately indistinguishable from a missing page.
          setGate('notfound');
        } else {
          setGateError(e instanceof Error ? e.message : 'Failed to load admin data.');
          setGate('error');
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openAction = (a: ActionState) => {
    setAction(a);
    setReason('');
    setAmount('');
    if (a?.kind === 'plan') setPlanId(a.tenant.plan_id === 'pro' ? 'starter' : 'pro');
  };

  const runAction = async () => {
    if (!action) return;
    setBusy(true);
    try {
      if (action.kind === 'suspend') {
        await adminApi.suspend(action.tenant.id, reason.trim());
        note(`${action.tenant.name} suspended.`);
      } else if (action.kind === 'plan') {
        await adminApi.planOverride(action.tenant.id, planId, reason.trim());
        note(`${action.tenant.name} moved to ${PLAN_NAMES[planId] ?? planId}.`);
      } else if (action.kind === 'credit') {
        const cents = Math.round(Number(amount) * 100);
        await adminApi.credit(action.tenant.id, cents, reason.trim());
        note(`Credit of ${formatMoney(cents)} recorded for ${action.tenant.name}.`);
      } else if (action.kind === 'impersonate') {
        const res = await adminApi.impersonate(action.tenant.id);
        // Switch this browser to the short-lived impersonation session
        // (5 minutes, audit-logged server-side). The admin must sign in
        // again afterwards — their own session is replaced, not stacked.
        document.cookie = `bseo_token=${encodeURIComponent(res.token)}; path=/; max-age=${res.expiresInSec}; SameSite=Lax`;
        window.location.href = '/dashboard';
        return;
      }
      setAction(null);
      await loadAll(search);
    } catch (e) {
      note(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  };

  const unsuspend = async (t: AdminTenant) => {
    try {
      await adminApi.unsuspend(t.id);
      note(`${t.name} unsuspended.`);
      await loadAll(search);
    } catch (e) {
      note(e instanceof Error ? e.message : 'Unsuspend failed.');
    }
  };

  const showDetail = async (t: AdminTenant) => {
    try {
      setDetail(await adminApi.tenant(t.id));
    } catch (e) {
      note(e instanceof Error ? e.message : 'Could not load tenant detail.');
    }
  };

  const toggleFlag = async (f: FeatureFlag) => {
    try {
      const saved = await adminApi.setFlag(f.key, !f.enabled);
      setFlags((prev) => prev.map((x) => (x.key === f.key ? saved : x)));
    } catch (e) {
      note(e instanceof Error ? e.message : 'Flag update failed.');
    }
  };

  const jobAction = async (job: AdminFailedJob, kind: 'replay' | 'discard') => {
    try {
      if (kind === 'replay') await adminApi.replayJob(job.id);
      else await adminApi.discardJob(job.id);
      note(`Job ${kind === 'replay' ? 'replayed' : 'discarded'}.`);
      const j = await adminApi.failedJobs(1, 20);
      setJobs(j.data);
    } catch (e) {
      note(e instanceof Error ? e.message : 'Job action failed.');
    }
  };

  if (gate === 'loading') {
    return <p className="px-4 py-8 font-mono text-sm text-white/55">$ loading…</p>;
  }
  if (gate === 'notfound') {
    // Same surface as any missing page — the back-office must not be
    // discoverable by non-admins (backend contract: 404, not 403).
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <p className="font-mono text-6xl font-bold text-white/15">404</p>
        <h1 className="bx-h1 mt-4">Page not found</h1>
        <p className="mt-2 text-sm text-white/50">
          The page you are looking for does not exist or has moved.
        </p>
        <a href="/dashboard" className="bx-link mt-6 inline-block text-sm">
          ← Back to dashboard
        </a>
      </div>
    );
  }
  if (gate === 'error') {
    return (
      <div className="mx-auto max-w-xl px-4 py-8">
        <div className="bx-alert-err">
          <p className="font-semibold">Could not load the back office</p>
          <p className="mt-1 text-sm">{gateError}</p>
        </div>
      </div>
    );
  }

  const suspendedCount = tenants.filter((t) => t.suspended_at).length;
  const pendingJobs = jobs.filter((j) => j.status === 'pending').length;
  const totalSpend = spendTotals.reduce((s, x) => s + x.cost_cents, 0);
  const actionValid =
    action?.kind === 'impersonate'
      ? true
      : action?.kind === 'credit'
        ? reason.trim().length >= 3 && Number(amount) > 0
        : reason.trim().length >= 3;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <a href="/dashboard" className="text-sm text-white/55 hover:text-white/70 hover:underline">
        ← Back to dashboard
      </a>
      <div>
        <p className="bx-micro mb-1">~/ admin</p>
        <h1 className="bx-h1">Back office</h1>
      </div>
      {flash && <p className="bx-alert-info" role="status">{flash}</p>}

      {/* KPIs — computed from real admin endpoints only. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="bx-card">
          <p className="bx-micro">Tenants</p>
          <p className="mt-1 font-mono text-2xl font-bold text-white">{tenantTotal}</p>
          <p className="font-mono text-[11px] text-white/55">{suspendedCount} suspended (this page)</p>
        </div>
        <div className="bx-card">
          <p className="bx-micro">Failed jobs pending</p>
          <p className="mt-1 font-mono text-2xl font-bold text-red-300">{pendingJobs}</p>
        </div>
        <div className="bx-card">
          <p className="bx-micro">Provider spend (all tenants)</p>
          <p className="mt-1 font-mono text-2xl font-bold text-teal-300">{formatMoney(totalSpend)}</p>
        </div>
      </div>

      {/* Tenants */}
      <div className="bx-card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="bx-micro">~/ tenants</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              loadAll(search).catch(() => {});
            }}
            className="flex gap-2"
          >
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or tenant ID"
              className="bx-input !w-56 !py-1.5 font-mono !text-xs"
              aria-label="Search tenants"
            />
            <button type="submit" className="bx-btn-xs-secondary !px-3 !py-1.5">
              Search
            </button>
          </form>
        </div>
        {tenants.length === 0 ? (
          <p className="text-sm text-white/55">No tenants match.</p>
        ) : (
          <div className="bx-table-wrap">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="bx-th">Tenant</th>
                  <th className="bx-th">Plan</th>
                  <th className="bx-th">Status</th>
                  <th className="bx-th">Users</th>
                  <th className="bx-th">Sites</th>
                  <th className="bx-th">Actions</th>
                </tr>
              </thead>
              <tbody className="bx-tbody">
                {tenants.map((t) => {
                  const st = tenantStatus(t);
                  return (
                    <tr key={t.id}>
                      <td className="px-4 py-3">
                        <button onClick={() => showDetail(t)} className="text-left">
                          <span className="font-medium text-white hover:underline">{t.name}</span>
                        </button>
                        <p className="font-mono text-[11px] text-white/50">
                          {t.id.slice(0, 8)}… · since {new Date(t.created_at).toLocaleDateString()}
                          {t.read_only ? ' · read-only' : ''}
                        </p>
                      </td>
                      <td className="px-4 py-3 font-mono text-white/70">
                        {PLAN_NAMES[t.plan_id] ?? t.plan_id}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`bx-pill ${st.pill}`}>
                          <span className="bx-dot" />
                          {st.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-white/70">{t.users}</td>
                      <td className="px-4 py-3 font-mono text-white/70">{t.sites}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            onClick={() => openAction({ kind: 'impersonate', tenant: t })}
                            className="bx-btn-xs-secondary"
                          >
                            Impersonate
                          </button>
                          <button
                            onClick={() => openAction({ kind: 'plan', tenant: t })}
                            className="bx-btn-xs-secondary"
                          >
                            Plan
                          </button>
                          <button
                            onClick={() => openAction({ kind: 'credit', tenant: t })}
                            className="bx-btn-xs-secondary"
                          >
                            Credit
                          </button>
                          {t.suspended_at ? (
                            <button onClick={() => unsuspend(t)} className="bx-btn-xs-secondary">
                              Unsuspend
                            </button>
                          ) : (
                            <button
                              onClick={() => openAction({ kind: 'suspend', tenant: t })}
                              className="bx-btn-xs-danger"
                            >
                              Suspend
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Failed jobs */}
        <div className="bx-card">
          <p className="bx-micro mb-3">~/ jobs</p>
          <h2 className="text-base font-bold text-white">Failed jobs (dead-letter)</h2>
          <ul className="mt-3 space-y-2">
            {jobs.map((j) => (
              <li key={j.id} className="bx-panel">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-sm text-white">
                    {j.queue} / {j.job_name}
                    <span className={`bx-pill ml-2 ${j.status === 'pending' ? 'bx-pill-err' : 'bx-pill-info'}`}>
                      <span className="bx-dot" />
                      {j.status}
                    </span>
                  </p>
                  {j.status === 'pending' && (
                    <span className="flex gap-1.5">
                      <button onClick={() => jobAction(j, 'replay')} className="bx-btn-xs-secondary">
                        Replay
                      </button>
                      <button onClick={() => jobAction(j, 'discard')} className="bx-btn-xs-danger">
                        Discard
                      </button>
                    </span>
                  )}
                </div>
                <p className="mt-1 font-mono text-xs text-white/55">
                  {j.tenant_name ?? j.tenant_id ?? '—'} · attempts {j.attempts} ·{' '}
                  {new Date(j.failed_at).toLocaleString()}
                </p>
                {j.error && <p className="mt-1 text-xs text-red-300/80">{j.error}</p>}
              </li>
            ))}
            {jobs.length === 0 && <p className="text-sm text-white/55">No failed jobs.</p>}
          </ul>
        </div>

        {/* Provider spend */}
        <div className="bx-card">
          <p className="bx-micro mb-3">~/ spend</p>
          <h2 className="text-base font-bold text-white">Provider spend (all tenants)</h2>
          {spendTotals.length === 0 ? (
            <p className="mt-3 text-sm text-white/55">No provider spend recorded yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {spendTotals.map((s) => (
                <li key={s.provider} className="bx-panel flex items-center justify-between">
                  <span className="text-sm text-white/80">{s.provider}</span>
                  <span className="font-mono text-sm text-teal-300">
                    {formatMoney(s.cost_cents)}
                    <span className="ml-2 text-[11px] text-white/55">{s.units} units</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="bx-hint mt-2">
            Recorded provider costs; per-tenant detail is in the tenant view.
          </p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Feature flags */}
        <div className="bx-card">
          <p className="bx-micro mb-3">~/ flags</p>
          <h2 className="text-base font-bold text-white">Feature flags</h2>
          {flags.length === 0 ? (
            <p className="mt-3 text-sm text-white/55">No feature flags defined.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {flags.map((f) => (
                <li key={f.key} className="bx-panel flex items-center justify-between gap-3">
                  <div>
                    <p className="font-mono text-sm text-white">{f.key}</p>
                    <p className="text-xs text-white/50">
                      {f.description ?? ''} · updated {new Date(f.updated_at).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={f.enabled}
                    aria-label={`Toggle flag ${f.key}`}
                    onClick={() => toggleFlag(f)}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${f.enabled ? 'bg-teal-400' : 'bg-white/15'}`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${f.enabled ? 'left-[22px]' : 'left-0.5'}`}
                    />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Admin audit log */}
        <div className="bx-card">
          <p className="bx-micro mb-3">~/ audit log</p>
          <h2 className="text-base font-bold text-white">Admin actions</h2>
          {audit.length === 0 ? (
            <p className="mt-3 text-sm text-white/55">No admin actions recorded.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {audit.map((a) => (
                <li key={a.id} className="bx-panel">
                  <p className="text-sm text-white/85">
                    <span className="font-mono">{a.action}</span>
                  </p>
                  <p className="font-mono text-[11px] text-white/55">
                    {a.actor_email ?? '—'}
                    {a.target_tenant_id ? ` → ${a.target_tenant_id.slice(0, 8)}…` : ''} ·{' '}
                    {new Date(a.created_at).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Tenant detail */}
      {detail && (
        <Modal title={`Tenant — ${detail.name}`} onClose={() => setDetail(null)}>
          <div className="space-y-3 text-sm">
            <p className="font-mono text-xs text-white/50">
              plan {detail.plan_id} · status {detail.suspended_at ? 'suspended' : (detail.sub_status ?? 'none')}
              {detail.current_period_end &&
                ` · period ends ${new Date(detail.current_period_end).toLocaleDateString()}`}
              {detail.billing_interval && ` · ${detail.billing_interval}`}
              {detail.coupon_code && ` · coupon ${detail.coupon_code}`}
            </p>
            <p className="font-mono text-xs text-white/50">
              credits balance recorded: {formatMoney(detail.credits_cents)}
            </p>
            <div>
              <p className="bx-label">Users</p>
              <ul className="space-y-1">
                {detail.users.map((u) => (
                  <li key={u.id} className="font-mono text-xs text-white/70">
                    {u.email} · {u.role}
                  </li>
                ))}
              </ul>
            </div>
            {detail.spend.length > 0 && (
              <div>
                <p className="bx-label">Provider spend</p>
                <ul className="space-y-1">
                  {detail.spend.map((s) => (
                    <li key={s.provider} className="font-mono text-xs text-white/70">
                      {s.provider}: {formatMoney(s.cost_cents)} ({s.units} units)
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Action modal (suspend / plan / credit / impersonate) */}
      {action && (
        <Modal
          title={
            action.kind === 'suspend'
              ? `Suspend ${action.tenant.name}`
              : action.kind === 'plan'
                ? `Change plan — ${action.tenant.name}`
                : action.kind === 'credit'
                  ? `Issue credit — ${action.tenant.name}`
                  : `Impersonate ${action.tenant.name}`
          }
          onClose={() => setAction(null)}
        >
          {action.kind === 'impersonate' ? (
            <div>
              <p className="text-sm text-white/70">
                You will be signed in as this tenant&rsquo;s owner for{' '}
                <strong className="text-white">5 minutes</strong>. The session is
                audit-logged. Your admin session is replaced — you will need to
                sign in again afterwards. Suspended tenants cannot be impersonated.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {action.kind === 'plan' && (
                <div>
                  <label htmlFor="override-plan" className="bx-label">New plan</label>
                  <select
                    id="override-plan"
                    value={planId}
                    onChange={(e) => setPlanId(e.target.value)}
                    className="bx-input"
                  >
                    {Object.keys(PLAN_NAMES).map((p) => (
                      <option key={p} value={p}>{PLAN_NAMES[p]}</option>
                    ))}
                  </select>
                  <p className="bx-hint">
                    Manual override changes our plan record only — Stripe is not
                    touched, and the next Stripe event re-syncs from Stripe.
                  </p>
                </div>
              )}
              {action.kind === 'credit' && (
                <div>
                  <label htmlFor="credit-amount" className="bx-label">Amount (USD)</label>
                  <input
                    id="credit-amount"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="29.00"
                    inputMode="decimal"
                    className="bx-input font-mono"
                  />
                </div>
              )}
              <div>
                <label htmlFor="action-reason" className="bx-label">Reason (required, audit-logged)</label>
                <input
                  id="action-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is this being done?"
                  className="bx-input"
                />
              </div>
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => setAction(null)} className="bx-btn-secondary" disabled={busy}>
              Cancel
            </button>
            <button
              onClick={runAction}
              disabled={busy || !actionValid}
              className={action.kind === 'suspend' ? 'bx-btn-xs-danger !px-4 !py-2 !text-sm' : 'bx-btn-primary'}
            >
              {busy
                ? 'Working…'
                : action.kind === 'suspend'
                  ? 'Suspend tenant'
                  : action.kind === 'plan'
                    ? 'Apply plan override'
                    : action.kind === 'credit'
                      ? 'Record credit'
                      : 'Start impersonation'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
