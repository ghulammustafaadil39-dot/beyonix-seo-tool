'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { contentApi, keywordsApi, type ContentPiece, type Keyword, type Campaign, type CampaignTopic, type QualityCheckResult } from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';

// ---- Phase 4: campaigns section ----
function CampaignsSection({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selected, setSelected] = useState<Campaign | null>(null);
  const [topics, setTopics] = useState<CampaignTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [perWeek, setPerWeek] = useState('1');
  const [mode, setMode] = useState<'autopilot' | 'approval'>('approval');
  const [creating, setCreating] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [manualTopic, setManualTopic] = useState('');
  const [manualKeyword, setManualKeyword] = useState('');
  const [actingTopic, setActingTopic] = useState<string | null>(null);

  const loadCampaigns = async () => {
    try {
      const c = await contentApi.campaigns.list(siteId);
      setCampaigns(c.data);
      if (c.data.length > 0 && !selected) setSelected(c.data[0]);
    } catch (e) {
      report(e);
    } finally {
      setLoading(false);
    }
  };

  const loadTopics = async (campaignId: string) => {
    try {
      const t = await contentApi.campaigns.topics(siteId, campaignId);
      setTopics(t.data);
    } catch (e) {
      report(e);
    }
  };

  useEffect(() => {
    loadCampaigns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId]);

  useEffect(() => {
    if (selected) loadTopics(selected.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      const c = await contentApi.campaigns.create(siteId, {
        name: name.trim(),
        blogs_per_week: Math.max(0, Math.min(7, parseInt(perWeek, 10) || 0)),
        mode,
      });
      setCampaigns((prev) => [c, ...prev]);
      setSelected(c);
      setName('');
    } catch (err) {
      report(err);
    } finally {
      setCreating(false);
    }
  };

  const suggest = async () => {
    if (!selected) return;
    setSuggesting(true);
    try {
      await contentApi.campaigns.suggest(siteId, selected.id);
      await loadTopics(selected.id);
      await loadCampaigns();
    } catch (e) {
      report(e);
    } finally {
      setSuggesting(false);
    }
  };

  const addManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !manualTopic.trim()) return;
    try {
      await contentApi.campaigns.addTopic(siteId, selected.id, {
        topic: manualTopic.trim(),
        keyword: manualKeyword.trim() || undefined,
      });
      setManualTopic('');
      setManualKeyword('');
      await loadTopics(selected.id);
    } catch (e) {
      report(e);
    }
  };

  const approveTopic = async (topicId: string) => {
    setActingTopic(topicId);
    try {
      await contentApi.campaigns.approveTopic(siteId, topicId);
      if (selected) await loadTopics(selected.id);
    } catch (e) {
      report(e);
    } finally {
      setActingTopic(null);
    }
  };

  const rejectTopic = async (topicId: string) => {
    setActingTopic(topicId);
    try {
      await contentApi.campaigns.rejectTopic(siteId, topicId);
      if (selected) await loadTopics(selected.id);
    } catch (e) {
      report(e);
    } finally {
      setActingTopic(null);
    }
  };

  const TOPIC_STATUS: Record<string, string> = {
    suggested: 'bx-pill-info',
    approved: 'bx-pill-warn',
    rejected: 'bx-pill',
    written: 'bx-pill-ok',
  };

  if (loading) return <p className="font-mono text-sm text-white/55">Loading campaigns…</p>;

  return (
    <div className="bx-card">
      <p className="bx-micro mb-1">~/ campaigns</p>
      <h3 className="mb-3 text-sm font-semibold text-white">Content campaigns</h3>
      <p className="mb-4 text-xs text-white/55">
        Set a publishing cadence — the tool proactively suggests topics every week from your
        keywords, Search Console and competitor gaps. Autopilot publishes automatically;
        Approval keeps drafts ready for you to pick.
      </p>

      <form onSubmit={create} className="mb-4 grid gap-3 sm:grid-cols-4">
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Campaign name"
          className="bx-input"
        />
        <input
          type="number"
          min={0}
          max={7}
          value={perWeek}
          onChange={(e) => setPerWeek(e.target.value)}
          placeholder="Blogs / week"
          className="bx-input"
          aria-label="Blogs per week"
        />
        <select value={mode} onChange={(e) => setMode(e.target.value as 'autopilot' | 'approval')} className="bx-input" aria-label="Campaign mode">
          <option value="approval">Approval mode</option>
          <option value="autopilot">Autopilot</option>
        </select>
        <button type="submit" disabled={creating} className="bx-btn-primary">
          {creating ? 'Creating…' : 'New campaign'}
        </button>
      </form>

      {campaigns.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {campaigns.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelected(c)}
              className={`rounded border px-3 py-1.5 text-xs font-medium transition ${
                selected?.id === c.id
                  ? 'border-teal-400/50 bg-teal-400/10 text-teal-200'
                  : 'border-white/10 bg-white/[0.03] text-white/60 hover:text-white'
              }`}
            >
              {c.name} · {c.mode} · {c.suggested_count ?? 0} suggested
            </button>
          ))}
        </div>
      )}

      {selected && (
        <div className="rounded border border-white/10 bg-white/[0.02] p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-white">
              {selected.name}
              <span className="ml-2 font-mono text-xs text-white/50">
                {selected.blogs_per_week}/week · {selected.mode}
              </span>
            </p>
            <button onClick={suggest} disabled={suggesting} className="bx-btn-xs-primary">
              {suggesting ? 'Suggesting…' : '✨ Suggest topics'}
            </button>
          </div>

          <form onSubmit={addManual} className="mb-3 grid gap-2 sm:grid-cols-3">
            <input
              type="text"
              value={manualTopic}
              onChange={(e) => setManualTopic(e.target.value)}
              placeholder="Add your own topic…"
              className="bx-input"
            />
            <input
              type="text"
              value={manualKeyword}
              onChange={(e) => setManualKeyword(e.target.value)}
              placeholder="Target keyword (optional)"
              className="bx-input"
            />
            <button type="submit" className="bx-btn-xs-secondary">Add topic</button>
          </form>

          {topics.length === 0 ? (
            <p className="py-4 text-center text-xs text-white/50">
              No topics yet — hit “Suggest topics” and the tool will propose 5 fresh ones from your keywords and Search Console.
            </p>
          ) : (
            <ul className="space-y-2">
              {topics.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-white/5 bg-white/[0.02] px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-white">{t.topic}</p>
                    <p className="font-mono text-[11px] text-white/45">
                      {t.keyword ? `kw: ${t.keyword} · ` : ''}{t.suggested_by === 'ai' ? '🤖 AI suggestion' : '👤 you'}{t.reason ? ` · ${t.reason.slice(0, 80)}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`bx-pill ${TOPIC_STATUS[t.status] ?? 'bx-pill'}`}>
                      <span className="bx-dot" />{t.status}
                    </span>
                    {t.status === 'suggested' && (
                      <>
                        <button
                          onClick={() => approveTopic(t.id)}
                          disabled={actingTopic === t.id}
                          className="rounded border border-teal-400/30 bg-teal-400/10 px-2 py-1 text-xs font-medium text-teal-200 transition hover:bg-teal-400/20"
                        >
                          Approve & write
                        </button>
                        <button
                          onClick={() => rejectTopic(t.id)}
                          disabled={actingTopic === t.id}
                          className="rounded border border-white/10 px-2 py-1 text-xs text-white/55 transition hover:text-white"
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---- Phase 4: quality score badge on drafts ----
function QualityBadge({ pieceId, hasDraft }: { pieceId: string; hasDraft: boolean }) {
  const { report } = useErrorReporter();
  const [result, setResult] = useState<QualityCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState(false);

  const check = async () => {
    setChecking(true);
    try {
      const r = await contentApi.qualityCheck(pieceId);
      setResult(r);
      setOpen(true);
    } catch (e) {
      report(e);
    } finally {
      setChecking(false);
    }
  };

  if (!hasDraft) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <button onClick={check} disabled={checking} className="bx-btn-xs-secondary" title="Run the strict quality scorer (75+ to pass)">
        {checking ? 'Checking…' : result ? `Quality: ${result.score}` : 'Quality check'}
      </button>
      {result && (
        <button
          onClick={() => setOpen(!open)}
          className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${result.passed ? 'bg-teal-400/15 text-teal-200' : 'bg-red-400/15 text-red-200'}`}
          title={result.passed ? 'Passed' : 'Below 75 — click for issues'}
        >
          {result.passed ? '✓' : '✗'}
        </button>
      )}
      {open && result && (
        <span className="absolute z-10 mt-8 w-80 rounded border border-white/10 bg-[#141821] p-3 text-left shadow-xl">
          <p className="mb-1 text-xs font-semibold text-white">Score {result.score}/100 {result.passed ? '(passed)' : '(needs rewrite)'}</p>
          {result.breakdown.map((b) => (
            <p key={b.label} className="font-mono text-[11px] text-white/60">
              {b.label}: {b.points}/{b.max} — {b.note.slice(0, 70)}
            </p>
          ))}
          {!result.humanLike && result.humanLikeIssues.length > 0 && (
            <p className="mt-1 text-[11px] text-amber-200">⚠ {result.humanLikeIssues[0].slice(0, 120)}</p>
          )}
          {result.suggestions.slice(0, 3).map((s, i) => (
            <p key={i} className="mt-1 text-[11px] text-white/55">• {s.slice(0, 120)}</p>
          ))}
        </span>
      )}
    </span>
  );
}

export default function ContentTab({ siteId }: { siteId: string }) {
  const { report } = useErrorReporter();
  const [pieces, setPieces] = useState<ContentPiece[]>([]);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [keywordId, setKeywordId] = useState('');
  const [tone, setTone] = useState('professional');
  const [creating, setCreating] = useState(false);
  const [generatingId, setGeneratingId] = useState<string | null>(null);

  const load = async () => {
    try {
      const [c, k] = await Promise.all([
        contentApi.list(siteId),
        keywordsApi.list(siteId),
      ]);
      setPieces(c.data);
      setKeywords(k.data);
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

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      const piece = await contentApi.create(siteId, {
        title: title.trim(),
        keywordId: keywordId || undefined,
        tone,
      });
      setPieces((prev) => [piece, ...prev]);
      setTitle('');
      setKeywordId('');
    } catch (err) {
      report(err);
    } finally {
      setCreating(false);
    }
  };

  const generate = async (id: string) => {
    setGeneratingId(id);
    try {
      await contentApi.generate(id);
      await load();
    } catch (e) {
      report(e);
    } finally {
      setGeneratingId(null);
    }
  };

  const approve = async (id: string) => {
    try {
      const updated = await contentApi.approve(id);
      setPieces((prev) => prev.map((p) => (p.id === id ? updated : p)));
    } catch (e) {
      report(e);
    }
  };

  const STATUS_COLOR: Record<string, string> = {
    draft: 'bx-pill-info',
    review: 'bx-pill-warn',
    approved: 'bx-pill-ok',
  };

  if (loading) return <p className="font-mono text-sm text-white/55">Loading content…</p>;

  return (
    <div className="space-y-6">
      <CampaignsSection siteId={siteId} />
      <div className="bx-card">
        <p className="bx-micro mb-1">~/ new draft</p>
        <h3 className="mb-3 text-sm font-semibold text-white">New content draft</h3>
        <form onSubmit={create} className="grid gap-3 sm:grid-cols-2">
          <input
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Article title"
            className="bx-input"
          />
          <select
            value={keywordId}
            onChange={(e) => setKeywordId(e.target.value)}
            className="bx-input"
            aria-label="Target keyword"
          >
            <option value="">No target keyword</option>
            {keywords.map((k) => (
              <option key={k.id} value={k.id}>
                {k.keyword}
              </option>
            ))}
          </select>
          <select
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            className="bx-input"
            aria-label="Content tone"
          >
            <option value="professional">Professional</option>
            <option value="friendly">Friendly</option>
            <option value="authoritative">Authoritative</option>
            <option value="casual">Casual</option>
          </select>
          <button
            type="submit"
            disabled={creating}
            className="bx-btn-primary"
          >
            {creating ? 'Creating…' : 'Create draft'}
          </button>
        </form>
      </div>

      <div className="bx-table-wrap">
        <table className="min-w-full">
          <thead className="border-b border-white/10 bg-white/[0.03]">
            <tr>
              <th className="bx-th">Title</th>
              <th className="bx-th">Status</th>
              <th className="bx-th" title="AI words used: counts against your plan's monthly AI-words limit (see Billing).">
                AI words <span className="normal-case text-white/50">ⓘ</span>
              </th>
              <th className="bx-th">Updated</th>
              <th className="bx-th">Actions</th>
            </tr>
          </thead>
          <tbody className="bx-tbody">
            {pieces.map((p) => (
              <tr key={p.id} className="transition hover:bg-white/[0.02]">
                <td className="px-4 py-3 text-sm font-medium text-white">{p.title}</td>
                <td className="px-4 py-3">
                  <span className={`bx-pill ${STATUS_COLOR[p.status]}`}>
                    <span className="bx-dot" />
                    {p.status}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-xs text-white/55">{p.ai_words_used}</td>
                <td className="px-4 py-3 font-mono text-xs text-white/55">
                  {new Date(p.updated_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-2">
                    {p.status !== 'approved' && (
                      <>
                        <button
                          onClick={() => generate(p.id)}
                          disabled={generatingId === p.id}
                          className="bx-btn-xs-primary"
                        >
                          {generatingId === p.id ? 'Generating…' : 'Generate'}
                        </button>
                        <button
                          onClick={() => approve(p.id)}
                          className="rounded border border-teal-400/30 bg-teal-400/10 px-2 py-1 text-xs font-medium text-teal-200 transition hover:bg-teal-400/20"
                        >
                          Approve
                        </button>
                        <QualityBadge pieceId={p.id} hasDraft={!!p.draft} />
                      </>
                    )}
                    <a
                      href={contentApi.exportUrl(p.id, 'html')}
                      className="bx-btn-xs-secondary"
                    >
                      Export HTML
                    </a>
                    <a
                      href={contentApi.exportUrl(p.id, 'markdown')}
                      className="bx-btn-xs-secondary"
                    >
                      Export MD
                    </a>
                    <Link
                      href={`/dashboard/sites/${siteId}/content/${p.id}`}
                      className="bx-btn-xs-secondary"
                    >
                      View / Edit
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
            {pieces.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-white/55">
                  No content yet — create your first draft above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
