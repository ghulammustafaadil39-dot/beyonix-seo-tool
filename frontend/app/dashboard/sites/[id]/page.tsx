'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { sitesApi, auditsApi, ga4Api, type Site, type SiteOverview, type Ga4Property, type Ga4Overview } from '@/lib/api';
import { useErrorReporter } from '@/components/ErrorBanner';
import TabNav from '@/components/TabNav';
import StatCard from '@/components/StatCard';
import ScoreGauge from '@/components/ScoreGauge';

// MUST match the backend allowlist in routes/sites.ts (SERP_LOCATIONS).
// Rank data (DataForSEO) is only as good as this setting: pick the country
// where your customers are, or rankings won't match what you see on Google.
const SERP_LOCATIONS = [
  { code: 2840, name: 'United States' },
  { code: 2826, name: 'United Kingdom' },
  { code: 124, name: 'Canada' },
  { code: 36, name: 'Australia' },
  { code: 276, name: 'Germany' },
  { code: 250, name: 'France' },
  { code: 724, name: 'Spain' },
  { code: 528, name: 'Netherlands' },
  { code: 784, name: 'United Arab Emirates' },
  { code: 682, name: 'Saudi Arabia' },
  { code: 356, name: 'India' },
  { code: 586, name: 'Pakistan' },
  { code: 702, name: 'Singapore' },
];

function LocationPicker({ site, onSaved }: { site: Site; onSaved: (s: Site) => void }) {
  const { report } = useErrorReporter();
  const [code, setCode] = useState(site.serp_location_code ?? 2840);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const s = await sitesApi.updateLocation(site.id, code);
      onSaved(s);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      report(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bx-card flex flex-wrap items-center gap-3">
      <div className="flex-1">
        <p className="text-sm font-semibold text-white">Rank tracking location</p>
        <p className="text-xs text-white/40">
          Google results differ by country — choose where your customers are so ranks match what they see.
        </p>
      </div>
      <select
        value={code}
        onChange={(e) => setCode(Number(e.target.value))}
        className="bx-input !w-auto"
      >
        {SERP_LOCATIONS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.name}
          </option>
        ))}
      </select>
      <button
        onClick={save}
        disabled={saving || code === site.serp_location_code}
        className="bx-btn-primary"
      >
        {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
      </button>
    </div>
  );
}

/**
 * Google Analytics 4 card: connect Google, pick a property, see last-28-day
 * traffic (sessions, top pages, top referrers).
 */
function Ga4Card({ site, onSaved }: { site: Site; onSaved: (s: Site) => void }) {
  const { report } = useErrorReporter();
  const [properties, setProperties] = useState<Ga4Property[] | null>(null);
  const [selected, setSelected] = useState('');
  const [overview, setOverview] = useState<Ga4Overview | null>(null);
  const [busy, setBusy] = useState(false);

  const loadOverview = async () => {
    try {
      setOverview(await ga4Api.overview(site.id));
    } catch (e) {
      report(e);
    }
  };

  useEffect(() => {
    if (site.ga4_connected) loadOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site.id, site.ga4_connected]);

  const startOAuth = async () => {
    setBusy(true);
    try {
      const { url } = await ga4Api.authUrl(site.id);
      window.location.href = url;
    } catch (e) {
      report(e);
      setBusy(false);
    }
  };

  const loadProperties = async () => {
    setBusy(true);
    try {
      const res = await ga4Api.properties(site.id);
      setProperties(res.data);
      if (res.data.length > 0) setSelected(res.data[0].id);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await ga4Api.connect(site.id, selected);
      const fresh = await sitesApi.get(site.id);
      onSaved(fresh);
      setProperties(null);
      await loadOverview();
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await ga4Api.disconnect(site.id);
      const fresh = await sitesApi.get(site.id);
      onSaved(fresh);
      setOverview(null);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bx-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="bx-micro mb-1">~/ analytics</p>
          <p className="text-sm font-semibold text-white">Google Analytics traffic</p>
          <p className="font-mono text-xs text-white/40">
            {site.ga4_connected
              ? `connected — last 28 days${site.ga4_property_id ? ` · property ${site.ga4_property_id}` : ''}`
              : 'see real visitor traffic, top pages and top referrers'}
          </p>
        </div>
        {!site.ga4_connected ? (
          <button
            onClick={startOAuth}
            disabled={busy}
            className="bx-btn-primary"
          >
            {busy ? 'Connecting…' : 'Connect Google Analytics'}
          </button>
        ) : (
          <button
            onClick={disconnect}
            disabled={busy}
            className="bx-btn-secondary !px-3 !py-1.5 !text-xs"
          >
            Disconnect
          </button>
        )}
      </div>

      {!site.ga4_connected && (
        <div className="mt-3">
          {properties === null ? (
            <p className="text-xs text-white/40">
              After connecting,{' '}
              <button onClick={loadProperties} disabled={busy} className="bx-link">
                load your Analytics properties
              </button>{' '}
              to pick one.
            </p>
          ) : properties.length === 0 ? (
            <p className="bx-alert-warn">
              No Analytics properties found in this Google account. Create one at analytics.google.com, then reload.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="bx-input !w-auto"
              >
                {properties.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.displayName} ({pr.id})
                  </option>
                ))}
              </select>
              <button
                onClick={connect}
                disabled={busy || !selected}
                className="bx-btn-primary"
              >
                {busy ? 'Connecting…' : 'Connect property'}
              </button>
            </div>
          )}
        </div>
      )}

      {site.ga4_connected && overview && (
        <div className="mt-4">
          <div className="grid gap-3 sm:grid-cols-4">
            {[
              ['Sessions', overview.sessions.toLocaleString()],
              ['Visitors', overview.users.toLocaleString()],
              ['Pageviews', overview.pageviews.toLocaleString()],
              ['Avg. session', `${Math.floor(overview.avgSessionDurationSec / 60)}m ${overview.avgSessionDurationSec % 60}s`],
            ].map(([label, value]) => (
              <div key={label} className="bx-panel">
                <p className="bx-micro">{label}</p>
                <p className="mt-1 font-mono text-lg font-bold text-white">{value}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="bx-micro mb-2">~/ top pages</p>
              <ul className="space-y-1 text-sm">
                {overview.topPages.slice(0, 5).map((pg, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="truncate text-white/60">{pg.name}</span>
                    <span className="font-mono font-medium text-white">{pg.sessions.toLocaleString()}</span>
                  </li>
                ))}
                {overview.topPages.length === 0 && <li className="text-xs text-white/40">No page data yet.</li>}
              </ul>
            </div>
            <div>
              <p className="bx-micro mb-2">~/ top referrers</p>
              <ul className="space-y-1 text-sm">
                {overview.topReferrers.slice(0, 5).map((rf, i) => (
                  <li key={i} className="flex justify-between gap-2">
                    <span className="truncate text-white/60">{rf.name}</span>
                    <span className="font-mono font-medium text-white">{rf.sessions.toLocaleString()}</span>
                  </li>
                ))}
                {overview.topReferrers.length === 0 && <li className="text-xs text-white/40">No referrer data yet.</li>}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


function SitePageInner({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const searchParams = useSearchParams();
  const [site, setSite] = useState<Site | null>(null);
  const [overview, setOverview] = useState<SiteOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [auditRunning, setAuditRunning] = useState(false);
  const [gscJustConnected, setGscJustConnected] = useState(false);
  const [ga4JustConnected, setGa4JustConnected] = useState(false);

  const loadOverview = async () => {
    const o = await sitesApi.overview(siteId);
    setOverview(o);
    return o;
  };

  const pollUntilDone = async () => {
    setAuditRunning(true);
    try {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const audits = await auditsApi.list(siteId);
        const active = (audits.data ?? []).some((a) => a.status === 'queued' || a.status === 'running');
        if (!active) break;
      }
      await loadOverview();
    } catch (e) {
      report(e);
    } finally {
      setAuditRunning(false);
    }
  };

  useEffect(() => {
    if (searchParams.get('gsc') === '1') {
      setGscJustConnected(true);
      window.history.replaceState(null, '', `/dashboard/sites/${siteId}`);
    }
    if (searchParams.get('ga4') === '1') {
      setGa4JustConnected(true);
      // Clean the param so a refresh doesn't re-show the banner.
      window.history.replaceState(null, '', `/dashboard/sites/${siteId}`);
    }
    (async () => {
      try {
        const [s, o] = await Promise.all([sitesApi.get(siteId), sitesApi.overview(siteId)]);
        setSite(s);
        setOverview(o);
        // If an audit is already queued/running when we land, reflect it.
        const audits = await auditsApi.list(siteId);
        const active = (audits.data ?? []).some((a) => a.status === 'queued' || a.status === 'running');
        if (active) pollUntilDone();
      } catch (e) {
        report(e);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  const runAudit = async () => {
    if (auditRunning) return;
    try {
      await auditsApi.start(siteId);
      pollUntilDone();
    } catch (e) {
      report(e);
    }
  };

  if (loading) return <p className="font-mono text-sm text-white/40">$ loading site…</p>;
  if (!site) return <p className="bx-alert-err">Site not found.</p>;

  const o = (overview ?? {}) as Record<string, unknown>;
  const score = typeof o.score === 'number' ? o.score : null;
  const num = (v: unknown) => (typeof v === 'number' ? v : '—');
  const issuesPreview = Array.isArray(o.latest_issues) ? o.latest_issues : [];
  const latest = (o.latest as Record<string, unknown> | undefined) ?? {};
  const lastAudit = latest.last_audit as { finished_at?: string } | undefined;

  return (
    <div className="space-y-6">
      {gscJustConnected && (
        <div className="bx-alert-ok flex items-center justify-between">
          <p className="font-medium">
            ✓ Google Search Console connected — keyword data will appear shortly.
          </p>
          <button
            onClick={() => setGscJustConnected(false)}
            className="text-sm text-teal-300 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {ga4JustConnected && (
        <div className="bx-alert-ok flex items-center justify-between">
          <p className="font-medium">
            ✓ Google account connected — now pick your Analytics property below.
          </p>
          <button
            onClick={() => setGa4JustConnected(false)}
            className="text-sm text-teal-300 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xl font-bold tracking-tight text-white">{site.domain}</h1>
          <div className="mt-2 flex gap-2">
            <span className={`bx-pill ${site.verified ? 'bx-pill-ok' : 'bx-pill-warn'}`}>
              <span className="bx-dot" />
              {site.verified ? 'Verified' : 'Not verified'}
            </span>
            <span className={`bx-pill ${site.gsc_connected ? 'bx-pill-ok' : 'bx-pill-info'}`}>
              <span className="bx-dot" />
              {site.gsc_connected ? 'Google Search Console connected' : 'Search Console not connected'}
            </span>
          </div>
        </div>
        <button
          onClick={runAudit}
          disabled={auditRunning}
          className="bx-btn-primary"
        >
          {auditRunning ? 'Audit running…' : 'Run audit'}
        </button>
      </div>

      {auditRunning && (
        <p className="bx-alert-info">
          $ audit in progress — this page will refresh automatically when it finishes.
        </p>
      )}

      <TabNav siteId={siteId} />

      <LocationPicker site={site} onSaved={setSite} />

      <Ga4Card site={site} onSaved={setSite} />

      <div className="bx-card bx-glow">
        <div className="relative">
          <p className="bx-micro mb-3">~/ site health</p>
          <ScoreGauge score={score} label="Site health score" />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Keywords tracked" value={num(o.keywords_tracked)} />
        <StatCard label="Backlinks" value={num(o.backlinks_count ?? o.backlinks)} />
        <StatCard label="Content pieces" value={num(o.content_count ?? o.content_pieces)} />
        <StatCard label="GEO score" value={score === null ? '—' : (o.geo_score as number) ?? '—'} />
      </div>

      {issuesPreview.length > 0 && (
        <div className="bx-card">
          <div className="mb-3 flex items-center justify-between">
            <p className="bx-micro">~/ latest issues</p>
            <Link
              href={`/dashboard/sites/${siteId}/audit`}
              className="bx-link text-xs"
            >
              View all in Audit →
            </Link>
          </div>
          <ul className="space-y-2">
            {issuesPreview.slice(0, 5).map((i: unknown) => {
              const issue = i as { id: string; type: string; severity: string; url: string };
              return (
                <li key={issue.id} className="flex items-center gap-3 text-sm">
                  <span
                    className={`bx-pill ${
                      issue.severity === 'error'
                        ? 'bx-pill-err'
                        : issue.severity === 'warning'
                          ? 'bx-pill-warn'
                          : 'bx-pill-info'
                    }`}
                  >
                    <span className="bx-dot" />
                    {issue.severity}
                  </span>
                  <span className="font-medium text-white/90">{issue.type}</span>
                  <span className="truncate font-mono text-xs text-white/40">{issue.url}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {lastAudit?.finished_at && (
        <p className="font-mono text-xs text-white/30">
          last audit: {new Date(lastAudit.finished_at).toLocaleString()}
        </p>
      )}
    </div>
  );
}

export default function SitePage({ params }: { params: { id: string } }) {
  return (
    <Suspense fallback={<p className="font-mono text-sm text-white/40">$ loading site…</p>}>
      <SitePageInner siteId={params.id} />
    </Suspense>
  );
}
