'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { contentApi, keywordsApi, type ContentPiece, type Keyword } from '@/lib/api';
import { useErrorReporter } from '../ErrorBanner';

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

  if (loading) return <p className="font-mono text-sm text-white/55">$ loading content…</p>;

  return (
    <div className="space-y-6">
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
