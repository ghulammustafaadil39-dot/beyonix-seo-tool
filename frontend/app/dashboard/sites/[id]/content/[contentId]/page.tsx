'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { contentApi, type ContentPiece } from '@/lib/api';
import { useErrorReporter } from '@/components/ErrorBanner';

/** View & edit a single content piece. */
export default function ContentDetailPage({
  params,
}: {
  params: { id: string; contentId: string };
}) {
  const { contentId } = params;
  const { report } = useErrorReporter();
  const [piece, setPiece] = useState<ContentPiece | null>(null);
  const [title, setTitle] = useState('');
  const [outline, setOutline] = useState('');
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    try {
      const p = await contentApi.get(contentId);
      setPiece(p);
      setTitle(p.title);
      setOutline(p.outline ?? '');
      setDraft(p.draft ?? '');
    } catch (e) {
      report(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentId]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const updated = await contentApi.update(contentId, { title, outline, draft });
      setPiece(updated);
      setSaved(true);
    } catch (err) {
      report(err);
    } finally {
      setSaving(false);
    }
  };

  const generate = async () => {
    setGenerating(true);
    try {
      await contentApi.generate(contentId);
      await load();
    } catch (e) {
      report(e);
    } finally {
      setGenerating(false);
    }
  };

  const approve = async () => {
    try {
      const updated = await contentApi.approve(contentId);
      setPiece(updated);
    } catch (e) {
      report(e);
    }
  };

  if (loading) return <p className="font-mono text-sm text-white/40">$ loading…</p>;
  if (!piece) return <p className="bx-alert-err">Content not found.</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        href={`/dashboard/sites/${params.id}/content`}
        className="text-sm text-white/40 hover:text-white/70 hover:underline"
      >
        ← Back to content
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="bx-micro mb-1">~/ content editor</p>
          <h1 className="bx-h1">Edit draft</h1>
        </div>
        <div className="flex gap-2">
          <button
            onClick={generate}
            disabled={generating}
            className="bx-btn-primary"
          >
            {generating ? 'Generating…' : 'Regenerate'}
          </button>
          <button
            onClick={approve}
            className="rounded-lg border border-teal-400/30 bg-teal-400/10 px-4 py-2 text-sm font-medium text-teal-200 transition hover:bg-teal-400/20"
          >
            Approve
          </button>
        </div>
      </div>

      <form onSubmit={save} className="bx-card space-y-4">
        {saved && <p className="bx-alert-ok">Saved.</p>}
        <div>
          <label className="bx-label">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="bx-input"
          />
        </div>
        <div>
          <label className="bx-label">Outline</label>
          <textarea
            value={outline}
            onChange={(e) => setOutline(e.target.value)}
            rows={6}
            className="bx-input font-mono"
          />
        </div>
        <div>
          <label className="bx-label">Draft</label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={18}
            className="bx-input font-mono"
          />
        </div>
        <button type="submit" disabled={saving} className="bx-btn-primary">
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </div>
  );
}
