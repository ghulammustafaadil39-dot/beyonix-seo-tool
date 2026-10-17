'use client';

import { useEffect, useState } from 'react';
import { autopilotApi, type WpStatus, type AutopilotProposal, type SiteChange } from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';

export default function AutopilotTab({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const [status, setStatus] = useState<WpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [proposals, setProposals] = useState<AutopilotProposal[]>([]);
  const [history, setHistory] = useState<SiteChange[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<string | null>(null);
  // connect form
  const [siteUrl, setSiteUrl] = useState('');
  const [username, setUsername] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [connecting, setConnecting] = useState(false);

  const load = async () => {
    try {
      const s = await autopilotApi.status(siteId);
      setStatus(s);
      if (s.connected) {
        const [p, h] = await Promise.all([
          autopilotApi.proposals(siteId),
          autopilotApi.history(siteId),
        ]);
        setProposals(p.data);
        setHistory(h.data);
      }
    } catch (e) {
      report(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setConnecting(true);
    try {
      await autopilotApi.connect(siteId, { siteUrl, username, appPassword });
      setSiteUrl('');
      setUsername('');
      setAppPassword('');
      await load();
    } catch (err) {
      report(err);
    } finally {
      setConnecting(false);
    }
  };

  const setMode = async (mode: 'copilot' | 'autopilot') => {
    try {
      await autopilotApi.settings(siteId, { mode });
      await load();
    } catch (err) {
      report(err);
    }
  };

  const scan = async () => {
    setScanning(true);
    setScanResult(null);
    try {
      const r = await autopilotApi.scan(siteId);
      setScanResult(
        `${r.scanned} pages checked, ${r.proposals} fixes proposed` +
          (r.autoApplied > 0 ? `, ${r.autoApplied} auto-applied` : ''),
      );
      await load();
    } catch (err) {
      report(err);
    } finally {
      setScanning(false);
    }
  };

  const decide = async (proposalId: string, approve: boolean) => {
    try {
      if (approve) await autopilotApi.approve(siteId, proposalId);
      else await autopilotApi.reject(siteId, proposalId);
      await load();
    } catch (err) {
      report(err);
    }
  };

  const revert = async (changeId: string) => {
    if (!confirm('Is change ko wapas karein? (Undo)')) return;
    try {
      await autopilotApi.revert(siteId, changeId);
      await load();
    } catch (err) {
      report(err);
    }
  };

  if (loading) return <div className="bx-panel">Loading…</div>;

  if (!status?.connected) {
    return (
      <div className="bx-panel max-w-xl">
        <h2 className="mb-2 text-lg font-semibold text-white">Connect WordPress</h2>
        <p className="mb-4 text-sm text-white/60">
          Apni WordPress site connect karein taake Autopilot SEO fixes khud laga sake.
          WordPress Admin → Users → Profile me jaake ek <b>Application Password</b> banayein
          (koi plugin install nahi karna).
        </p>
        <form onSubmit={connect} className="space-y-3">
          <input
            className="bx-input w-full"
            placeholder="Site URL (https://example.com)"
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            required
          />
          <input
            className="bx-input w-full"
            placeholder="WordPress username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
          <input
            className="bx-input w-full"
            type="password"
            placeholder="Application password"
            value={appPassword}
            onChange={(e) => setAppPassword(e.target.value)}
            required
          />
          <button type="submit" className="bx-btn-primary" disabled={connecting}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Mode switch */}
      <div className="bx-panel">
        <h2 className="mb-2 text-lg font-semibold text-white">Autopilot Mode</h2>
        <div className="flex gap-3">
          <button
            onClick={() => setMode('copilot')}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${
              status.mode === 'copilot' ? 'bx-btn-primary' : 'bx-btn-secondary'
            }`}
          >
            Co-pilot — pehle mujh se poocho
          </button>
          <button
            onClick={() => setMode('autopilot')}
            className={`rounded-lg px-4 py-2 text-sm font-medium ${
              status.mode === 'autopilot' ? 'bx-btn-primary' : 'bx-btn-secondary'
            }`}
          >
            Autopilot — sab khud karo
          </button>
        </div>
        <p className="mt-2 text-xs text-white/50">
          Connected: {status.site_url} · SEO plugin: {status.seo_plugin ?? 'none'}
        </p>
        <button onClick={scan} className="bx-btn-primary mt-4" disabled={scanning}>
          {scanning ? 'Scanning…' : 'Scan & Fix Now'}
        </button>
        {scanResult && <p className="mt-2 text-sm text-teal-200">{scanResult}</p>}
      </div>

      {/* Pending approvals */}
      {status.mode === 'copilot' && (
        <div className="bx-panel">
          <h2 className="mb-3 text-lg font-semibold text-white">
            Pending Approvals ({proposals.length})
          </h2>
          {proposals.length === 0 && (
            <p className="text-sm text-white/50">Koi pending fix nahi. Scan chalake dekhein.</p>
          )}
          {proposals.map((p) => (
            <div key={p.id} className="mb-3 rounded-lg border border-white/10 p-3">
              <p className="text-sm text-white/80">{p.reason}</p>
              <p className="mt-1 text-xs text-white/50">
                {p.page_url} · {p.change_type}
              </p>
              <div className="mt-2 rounded bg-white/5 p-2 text-xs">
                <span className="text-white/40">New: </span>
                <span className="text-teal-200">{p.proposed_value}</span>
              </div>
              <div className="mt-2 flex gap-2">
                <button onClick={() => decide(p.id, true)} className="bx-btn-primary text-xs">
                  Approve & Fix
                </button>
                <button onClick={() => decide(p.id, false)} className="bx-btn-secondary text-xs">
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Change history */}
      <div className="bx-panel">
        <h2 className="mb-3 text-lg font-semibold text-white">Change History</h2>
        {history.length === 0 && (
          <p className="text-sm text-white/50">Abhi tak koi change nahi hua.</p>
        )}
        {history.map((c) => (
          <div
            key={c.id}
            className="mb-2 flex items-center justify-between rounded-lg border border-white/10 p-3"
          >
            <div>
              <p className="text-sm text-white/80">
                {c.change_type} · {c.page_url}
              </p>
              <p className="text-xs text-white/40">
                {c.mode} · {c.status}
                {c.applied_at ? ` · ${new Date(c.applied_at).toLocaleString()}` : ''}
              </p>
            </div>
            {c.status === 'applied' && (
              <button onClick={() => revert(c.id)} className="bx-btn-secondary text-xs">
                Undo
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
