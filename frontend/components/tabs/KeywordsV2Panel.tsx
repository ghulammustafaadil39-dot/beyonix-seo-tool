'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  keywordsApi,
  keywordsV2Api,
  type CannibalizationHit,
  type Keyword,
  type KeywordCluster,
  type KeywordGapResult,
  type KeywordList,
} from '@/lib/api';

/**
 * F-03 — Keyword v2 (WIRED, Wave 2 round 2): clusters, cannibalization,
 * keyword gap, CSV import/export, and lists/tags CRUD against the real
 * Backend-B endpoints.
 */
export default function KeywordsV2Panel({ siteId }: { siteId: string }) {
  const [clusters, setClusters] = useState<KeywordCluster[] | null>(null);
  const [cannib, setCannib] = useState<CannibalizationHit[] | null>(null);
  const [lists, setLists] = useState<KeywordList[]>([]);
  const [allKeywords, setAllKeywords] = useState<Keyword[]>([]);
  const [gapDomain, setGapDomain] = useState('');
  const [gap, setGap] = useState<KeywordGapResult | null>(null);
  const [gapBusy, setGapBusy] = useState(false);
  const [bulk, setBulk] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [listName, setListName] = useState('');
  const [listTags, setListTags] = useState('');
  const [members, setMembers] = useState<Record<string, Keyword[]>>({});
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [c, cb, l, k] = await Promise.all([
        keywordsV2Api.clusters(siteId),
        keywordsV2Api.cannibalization(siteId),
        keywordsV2Api.lists(siteId),
        keywordsApi.list(siteId),
      ]);
      setClusters(c.data);
      setCannib(cb.data);
      setLists(l.data);
      setAllKeywords(k.data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load keyword v2 data.');
    }
  }, [siteId]);

  useEffect(() => {
    load();
  }, [load]);

  const runGap = async () => {
    const competitor = gapDomain.trim();
    if (!competitor) return;
    setGapBusy(true);
    setErr('');
    try {
      setGap(await keywordsV2Api.gap(siteId, competitor));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Keyword gap failed.');
    } finally {
      setGapBusy(false);
    }
  };

  const doImport = async () => {
    if (!bulk.trim()) return;
    setImportBusy(true);
    setErr('');
    try {
      const res = await keywordsV2Api.importCsv(siteId, bulk);
      setImportMsg(`Imported ${res.imported} keyword(s), skipped ${res.skipped}.`);
      setBulk('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Import failed.');
    } finally {
      setImportBusy(false);
    }
  };

  const createList = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!listName.trim()) return;
    try {
      const tags = listTags.split(',').map((t) => t.trim()).filter(Boolean);
      const res = await keywordsV2Api.createList(siteId, listName.trim(), tags);
      setLists((prev) => [res.list, ...prev.filter((l) => l.id !== res.list.id)]);
      setListName('');
      setListTags('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not create list.');
    }
  };

  const deleteList = async (id: string) => {
    try {
      await keywordsV2Api.deleteList(id);
      setLists((prev) => prev.filter((l) => l.id !== id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not delete list.');
    }
  };

  const retag = async (list: KeywordList) => {
    const raw = window.prompt(`Tags for "${list.name}" (comma-separated)`, list.tags.join(', '));
    if (raw === null) return;
    try {
      const tags = raw.split(',').map((t) => t.trim()).filter(Boolean);
      const res = await keywordsV2Api.updateList(list.id, { tags });
      setLists((prev) => prev.map((l) => (l.id === list.id ? { ...res.list, members: l.members } : l)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update tags.');
    }
  };

  const toggleMembers = async (list: KeywordList) => {
    if (members[list.id]) {
      setMembers((prev) => {
        const next = { ...prev };
        delete next[list.id];
        return next;
      });
      return;
    }
    try {
      const res = await keywordsV2Api.listMembers(list.id);
      setMembers((prev) => ({ ...prev, [list.id]: res.data }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load list members.');
    }
  };

  const addAllToList = async (list: KeywordList) => {
    if (allKeywords.length === 0) return;
    try {
      const res = await keywordsV2Api.addMembers(list.id, allKeywords.map((k) => k.id));
      setImportMsg(`Added ${res.added} keyword(s) to "${list.name}".`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not add members.');
    }
  };

  return (
    <div className="space-y-6">
      {err && <p className="bx-alert-err" role="alert">{err}</p>}
      {importMsg && <p className="bx-alert-ok">{importMsg}</p>}

      {/* Clusters */}
      <div className="bx-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="bx-micro mb-1">~/ clusters</p>
            <h3 className="text-base font-bold text-white">Keyword clusters by topic</h3>
          </div>
          <a href={keywordsV2Api.exportUrl(siteId)} className="bx-btn-secondary !text-xs">Export CSV</a>
        </div>
        {clusters === null ? (
          <p className="mt-4 font-mono text-sm text-white/55">Loading clusters…</p>
        ) : clusters.length === 0 ? (
          <p className="mt-4 text-sm text-white/55">No keywords yet — research or import some first.</p>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {clusters.map((c) => (
              <div key={c.group_key} className="bx-panel">
                <p className="text-sm font-semibold text-white">{c.group_key}</p>
                <p className="mt-1 font-mono text-xs text-white/55">
                  {c.keywords.length} keywords · {c.total_volume.toLocaleString()} vol/mo
                  {c.avg_difficulty != null ? ` · avg difficulty ${c.avg_difficulty}` : ''}
                </p>
                <p className="mt-1 font-mono text-xs text-white/55">
                  {Object.entries(c.intents).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                </p>
                <ul className="mt-2 max-h-32 space-y-1 overflow-auto">
                  {c.keywords.map((k) => (
                    <li key={k} className="font-mono text-xs text-white/60">· {k}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Cannibalization */}
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ cannibalization</p>
          <h3 className="text-base font-bold text-white">Cannibalization watch</h3>
          <div className="mt-3 space-y-3">
            {cannib === null ? (
              <p className="font-mono text-sm text-white/55">Loading…</p>
            ) : cannib.length === 0 ? (
              <p className="text-sm text-white/55">No cannibalization detected.</p>
            ) : (
              cannib.map((c, i) => (
                <div key={i} className="bx-panel">
                  <p className="font-mono text-sm font-semibold text-amber-300">{c.keyword}</p>
                  <ul className="mt-1 space-y-0.5">
                    {c.urls.map((u) => (
                      <li key={u} className="break-all font-mono text-xs text-white/50">{u}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs leading-relaxed text-white/60">{c.detail}</p>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Keyword gap */}
        <div className="bx-card">
          <p className="bx-micro mb-1">~/ keyword gap</p>
          <h3 className="text-base font-bold text-white">Gap vs a competitor</h3>
          <p className="bx-body mt-1">Keywords a competitor ranks for that you don&rsquo;t track.</p>
          <div className="mt-3 flex gap-2">
            <input
              value={gapDomain}
              onChange={(e) => setGapDomain(e.target.value)}
              placeholder="competitor.com"
              className="bx-input font-mono"
              aria-label="Competitor domain for keyword gap"
            />
            <button onClick={runGap} disabled={gapBusy || !gapDomain.trim()} className="bx-btn-primary shrink-0">
              {gapBusy ? 'Checking…' : 'Run gap'}
            </button>
          </div>
          {gap && (
            <div className="mt-3 space-y-2">
              {gap.dataSource === 'mock' && (
                <p className="bx-alert-info">
                  Competitor keyword data is from the mock provider (no DataForSEO key configured) —
                  treat positions as illustrative, fetched {new Date(gap.fetchedAt).toLocaleDateString()}.
                </p>
              )}
              {gap.gaps.length === 0 && <p className="text-sm text-white/55">No gap keywords found.</p>}
              {gap.gaps.map((g) => (
                <div key={g.keyword} className="bx-panel">
                  <p className="font-mono text-sm font-medium text-white">{g.keyword}</p>
                  <p className="break-all font-mono text-xs text-white/55">
                    competitor #{g.competitor_position} · {g.volume != null ? `${g.volume.toLocaleString()} vol/mo` : 'volume n/a'}
                    {g.difficulty != null ? ` · difficulty ${g.difficulty}` : ''} · {g.competitor_url}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Lists / tags CRUD */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ lists &amp; tags</p>
        <h3 className="text-base font-bold text-white">Keyword lists</h3>
        <form onSubmit={createList} className="mt-3 flex flex-wrap gap-2">
          <input value={listName} onChange={(e) => setListName(e.target.value)} placeholder="List name" className="bx-input !w-auto flex-1" aria-label="New list name" />
          <input value={listTags} onChange={(e) => setListTags(e.target.value)} placeholder="tags, comma, separated" className="bx-input !w-auto flex-1 font-mono" aria-label="New list tags" />
          <button type="submit" className="bx-btn-primary shrink-0">Create list</button>
        </form>
        <ul className="mt-4 space-y-2">
          {lists.map((l) => (
            <li key={l.id} className="bx-panel">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-white">{l.name}</p>
                  <p className="font-mono text-xs text-white/55">
                    {l.members ?? 0} members{l.tags.length ? ` · ${l.tags.map((t) => `#${t}`).join(' ')}` : ''}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => toggleMembers(l)} className="bx-btn-xs-secondary">{members[l.id] ? 'Hide' : 'Members'}</button>
                  <button onClick={() => addAllToList(l)} className="bx-btn-xs-secondary">Add all keywords</button>
                  <button onClick={() => retag(l)} className="bx-btn-xs-secondary">Edit tags</button>
                  <button onClick={() => deleteList(l.id)} className="text-xs text-red-300/80 hover:text-red-300 hover:underline">Delete</button>
                </div>
              </div>
              {members[l.id] && (
                <ul className="mt-2 space-y-1">
                  {members[l.id].map((k) => (
                    <li key={k.id} className="flex items-center justify-between font-mono text-xs text-white/60">
                      <span>· {k.keyword}</span>
                      <button
                        onClick={async () => {
                          await keywordsV2Api.removeMember(l.id, k.id);
                          setMembers((prev) => ({ ...prev, [l.id]: prev[l.id].filter((m) => m.id !== k.id) }));
                        }}
                        className="text-red-300/70 hover:underline"
                      >
                        remove
                      </button>
                    </li>
                  ))}
                  {members[l.id].length === 0 && <li className="font-mono text-xs text-white/55">No members yet.</li>}
                </ul>
              )}
            </li>
          ))}
          {lists.length === 0 && <li className="text-sm text-white/55">No lists yet.</li>}
        </ul>
      </div>

      {/* CSV import */}
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ bulk import</p>
        <h3 className="text-base font-bold text-white">Import keywords (CSV / text)</h3>
        <p className="bx-body mt-1">Paste keywords — one per line or comma-separated. The server enriches them with volume/difficulty.</p>
        <label htmlFor="bulk-keywords" className="bx-label mt-3">Keywords</label>
        <textarea
          id="bulk-keywords"
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
          rows={5}
          placeholder={'invoicing software\nbest crm for freelancers, seo reporting tool'}
          className="bx-input font-mono"
        />
        <div className="mt-3 flex justify-end">
          <button onClick={doImport} disabled={importBusy || !bulk.trim()} className="bx-btn-primary">
            {importBusy ? 'Importing…' : 'Import keywords'}
          </button>
        </div>
      </div>
    </div>
  );
}
