'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  contentApi,
  contentV2Api,
  type ContentPiece,
  type ContentProfile,
  type ContentStatus,
  type ContentVersion,
  type OptimizeResult,
  type PublishResult,
  type SeoAssets,
} from '@/lib/api';

const NEXT_STATUS: Partial<Record<string, ContentStatus>> = {
  brief: 'outline',
  outline: 'draft',
  draft: 'review',
  review: 'approved',
  changes_requested: 'draft',
  approved: 'published',
};

/**
 * F-04 — Content v2 (WIRED, Wave 2 round 2): brief→outline→draft→optimize
 * workflow, versions, duplication check, SEO assets, internal links,
 * brand-voice profile, docx export, and CMS publish. Publish is labeled
 * honestly: when the API returns mock:true (CMS_PUBLISH_ENABLED off),
 * nothing was published and the UI says so.
 */
export default function ContentV2Panel({
  contentId,
  siteId,
}: {
  contentId: string;
  siteId: string;
}) {
  const [piece, setPiece] = useState<ContentPiece | null>(null);
  const [versions, setVersions] = useState<ContentVersion[] | null>(null);
  const [brief, setBrief] = useState('');
  const [optimize, setOptimize] = useState<OptimizeResult | null>(null);
  const [dup, setDup] = useState<Array<{ source: string; similarityPct: number }> | null>(null);
  const [links, setLinks] = useState<Array<{ url: string; title: string; anchor: string; score: number }> | null>(null);
  const [assets, setAssets] = useState<SeoAssets | null>(null);
  const [profile, setProfile] = useState<ContentProfile>({
    tone: '', vocabulary: '', do_rules: '', dont_rules: '', sample: '',
  });
  const [profileSaved, setProfileSaved] = useState(false);
  const [target, setTarget] = useState<'wordpress' | 'webflow'>('wordpress');
  const [siteUrl, setSiteUrl] = useState('');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  const [collectionId, setCollectionId] = useState('');
  const [publishRes, setPublishRes] = useState<PublishResult | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [p, v, prof] = await Promise.all([
        contentApi.get(contentId),
        contentV2Api.versions(contentId),
        contentV2Api.profile(siteId),
      ]);
      setPiece(p);
      setBrief(p.brief ?? '');
      setVersions(v.data);
      if (prof.profile) {
        setProfile({
          tone: prof.profile.tone ?? '',
          vocabulary: prof.profile.vocabulary ?? '',
          do_rules: prof.profile.do_rules ?? '',
          dont_rules: prof.profile.dont_rules ?? '',
          sample: prof.profile.sample ?? '',
        });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load content v2 data.');
    }
  }, [contentId, siteId]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setErr('');
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed.');
    } finally {
      setBusy('');
    }
  };

  const publish = () =>
    act('publish', async () => {
      const res = await contentV2Api.publish(siteId, {
        pieceId: contentId,
        target,
        status: 'draft',
        ...(target === 'wordpress'
          ? { siteUrl: siteUrl || undefined, username: username || undefined, appPassword: secret || undefined }
          : { apiToken: secret || undefined, collectionId: collectionId || undefined }),
      });
      setPublishRes(res);
    });

  return (
    <div className="space-y-6">
      {err && <p className="bx-alert-err" role="alert">{err}</p>}

      {/* Workflow: brief → outline → draft → optimize */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ workflow</p>
        <h3 className="text-base font-bold text-white">
          Brief → outline → draft → optimize{' '}
          {piece && <span className="bx-pill bx-pill-info ml-2"><span className="bx-dot" />{piece.status}</span>}
        </h3>
        <label htmlFor="brief" className="bx-label mt-3">Brief</label>
        <textarea id="brief" value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} className="bx-input" placeholder="Audience, angle, must-cover points (min 10 chars)…" />
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={() => act('brief', async () => { setPiece(await contentV2Api.setBrief(contentId, brief)); })} disabled={busy === 'brief' || brief.trim().length < 10} className="bx-btn-secondary !text-xs">
            {busy === 'brief' ? 'Saving…' : 'Save brief'}
          </button>
          <button onClick={() => act('outline', async () => { setPiece(await contentV2Api.generateOutline(contentId)); await load(); })} disabled={busy === 'outline'} className="bx-btn-secondary !text-xs">
            {busy === 'outline' ? 'Generating…' : 'Generate outline from brief'}
          </button>
          {piece && NEXT_STATUS[piece.status] && piece.status !== 'approved' && (
            <button
              onClick={() => act('status', async () => { setPiece(await contentV2Api.setStatus(contentId, NEXT_STATUS[piece.status]!)); })}
              disabled={busy === 'status'}
              className="bx-btn-secondary !text-xs"
            >
              Move to {NEXT_STATUS[piece.status]}
            </button>
          )}
          <button onClick={() => act('optimize', async () => setOptimize(await contentV2Api.optimize(contentId)))} disabled={busy === 'optimize'} className="bx-btn-primary !text-xs">
            {busy === 'optimize' ? 'Scoring…' : 'Optimize (term coverage)'}
          </button>
          <button onClick={() => act('dup', async () => { const r = await contentV2Api.duplication(contentId); setDup(r.data); })} disabled={busy === 'dup'} className="bx-btn-secondary !text-xs">
            {busy === 'dup' ? 'Checking…' : 'Duplication check'}
          </button>
          <button onClick={() => act('links', async () => { const r = await contentV2Api.internalLinks(contentId); setLinks(r.data); })} disabled={busy === 'links'} className="bx-btn-secondary !text-xs">
            Internal links
          </button>
          <button onClick={() => act('assets', async () => setAssets(await contentV2Api.seoAssets(contentId)))} disabled={busy === 'assets'} className="bx-btn-secondary !text-xs">
            {busy === 'assets' ? 'Generating…' : 'SEO assets'}
          </button>
          <a href={contentApi.exportUrl(contentId, 'docx')} className="bx-btn-secondary !text-xs">Export .docx</a>
        </div>

        {optimize && (
          <div className="mt-4 bx-panel">
            <p className="text-sm text-white/80">
              Term coverage: <strong className="text-teal-300">{optimize.coveragePct}%</strong>
              {optimize.keyword ? ` for “${optimize.keyword}”` : ''} · {optimize.sourcesAnalyzed} sources analyzed
            </p>
            {optimize.missing.length > 0 && (
              <p className="mt-1 font-mono text-xs text-white/50">missing terms: {optimize.missing.slice(0, 20).join(', ')}</p>
            )}
          </div>
        )}
        {dup && (
          <div className="mt-4 bx-panel">
            <p className="text-sm font-medium text-white">Duplication check</p>
            {dup.length === 0 ? (
              <p className="mt-1 text-xs text-white/50">No near-duplicates found in your content or crawled pages.</p>
            ) : (
              dup.map((d, i) => (
                <p key={i} className="mt-1 font-mono text-xs text-amber-300">{d.similarityPct}% similar: {d.source}</p>
              ))
            )}
          </div>
        )}
        {links && (
          <div className="mt-4 bx-panel">
            <p className="text-sm font-medium text-white">Internal-link suggestions</p>
            {links.length === 0 ? (
              <p className="mt-1 text-xs text-white/50">No suggestions yet — run an audit so the page graph exists.</p>
            ) : (
              links.map((l) => (
                <p key={l.url} className="mt-1 break-all font-mono text-xs text-white/60">
                  {l.url} — anchor “{l.anchor}” (score {l.score})
                </p>
              ))
            )}
          </div>
        )}
        {assets && (
          <div className="mt-4 bx-panel space-y-1">
            <p className="text-sm font-medium text-white">SEO assets</p>
            <p className="text-xs text-white/60">Meta title: {assets.metaTitle}</p>
            <p className="text-xs text-white/60">Meta description: {assets.metaDescription}</p>
            {assets.altTexts.map((a, i) => (
              <p key={i} className="font-mono text-xs text-white/50">alt: {a}</p>
            ))}
            {assets.faqSchema && (
              <pre className="max-h-40 overflow-auto font-mono text-[11px] text-white/55">{JSON.stringify(assets.faqSchema, null, 2)}</pre>
            )}
          </div>
        )}
      </div>

      {/* Versions */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ versions</p>
        <h3 className="text-base font-bold text-white">Version history</h3>
        {versions === null ? (
          <p className="mt-3 font-mono text-sm text-white/55">$ loading versions…</p>
        ) : versions.length === 0 ? (
          <p className="mt-3 text-sm text-white/55">No versions yet — edits, brief and status changes snapshot a version first.</p>
        ) : (
          <ol className="mt-3 space-y-2">
            {versions.map((v) => (
              <li key={v.id} className="bx-panel">
                <p className="text-sm font-medium text-white">{v.title ?? '(untitled)'} — {v.status}</p>
                <p className="font-mono text-xs text-white/55">
                  {new Date(v.created_at).toLocaleString()} · by {v.changed_by ?? 'user'}
                </p>
                {v.draft_preview && <p className="mt-1 line-clamp-2 text-xs text-white/50">{v.draft_preview}…</p>}
              </li>
            ))}
          </ol>
        )}
        <p className="mt-2 font-mono text-[11px] text-white/50">
          The backend stores version snapshots but has no restore endpoint — versions are read-only here.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Brand voice */}
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ brand voice</p>
          <h3 className="text-base font-bold text-white">Brand-voice profile</h3>
          <div className="mt-3 space-y-3">
            {(['tone', 'vocabulary', 'do_rules', 'dont_rules', 'sample'] as const).map((f) => (
              <div key={f}>
                <label htmlFor={`bv-${f}`} className="bx-label">{f.replace('_', ' ')}</label>
                <textarea
                  id={`bv-${f}`}
                  value={profile[f] ?? ''}
                  onChange={(e) => setProfile({ ...profile, [f]: e.target.value })}
                  rows={f === 'sample' ? 3 : 2}
                  className="bx-input"
                />
              </div>
            ))}
          </div>
          <button
            onClick={() => act('profile', async () => {
              const res = await contentV2Api.saveProfile(siteId, {
                tone: profile.tone || undefined,
                vocabulary: profile.vocabulary || undefined,
                do_rules: profile.do_rules || undefined,
                dont_rules: profile.dont_rules || undefined,
                sample: profile.sample || undefined,
              });
              setProfile({
                tone: res.profile.tone ?? '', vocabulary: res.profile.vocabulary ?? '',
                do_rules: res.profile.do_rules ?? '', dont_rules: res.profile.dont_rules ?? '',
                sample: res.profile.sample ?? '',
              });
              setProfileSaved(true);
              setTimeout(() => setProfileSaved(false), 3000);
            })}
            disabled={busy === 'profile'}
            className="bx-btn-primary mt-3"
          >
            {busy === 'profile' ? 'Saving…' : profileSaved ? 'Saved ✓' : 'Save profile'}
          </button>
        </div>

        {/* Publish */}
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ publish</p>
          <h3 className="text-base font-bold text-white">Publish to CMS</h3>
          <p className="bx-body mt-1">
            Pushes this piece as a CMS draft. If CMS publishing is disabled on the server, the API
            returns an honest mock result and <strong className="text-white">nothing is published</strong>.
          </p>
          <div className="mt-3 space-y-3">
            <div>
              <label htmlFor="publish-target" className="bx-label">Target</label>
              <select id="publish-target" value={target} onChange={(e) => setTarget(e.target.value as 'wordpress' | 'webflow')} className="bx-input !w-auto">
                <option value="wordpress">WordPress</option>
                <option value="webflow">Webflow</option>
              </select>
            </div>
            {target === 'wordpress' ? (
              <>
                <input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} placeholder="https://yourblog.com (https required)" className="bx-input font-mono" aria-label="WordPress site URL" />
                <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="WordPress username" className="bx-input" aria-label="WordPress username" />
              </>
            ) : (
              <input value={collectionId} onChange={(e) => setCollectionId(e.target.value)} placeholder="Webflow collection ID" className="bx-input font-mono" aria-label="Webflow collection ID" />
            )}
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={target === 'wordpress' ? 'Application password (sent once, never stored)' : 'API token (sent once, never stored)'}
              className="bx-input"
              aria-label="CMS credential"
            />
          </div>
          <button onClick={publish} disabled={busy === 'publish'} className="bx-btn-primary mt-3">
            {busy === 'publish' ? 'Publishing…' : 'Publish draft'}
          </button>
          {publishRes && (
            <div className={publishRes.mock ? 'bx-alert-info mt-3' : publishRes.ok ? 'bx-alert-ok mt-3' : 'bx-alert-err mt-3'} role="status">
              {publishRes.mock && <strong>Not published (mock mode): </strong>}
              {publishRes.message}
              {publishRes.url && (
                <> — <a href={publishRes.url} target="_blank" rel="noreferrer" className="underline">view</a></>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
