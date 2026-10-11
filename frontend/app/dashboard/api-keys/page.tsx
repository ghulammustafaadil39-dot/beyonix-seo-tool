'use client';

import { useEffect, useState } from 'react';
import { withMockFallback, notLandedYet } from '@/lib/mock';
import {
  mockApiKeys,
  mockCreateKey,
  API_SCOPES,
  type ApiKey,
} from '@/lib/mock/apikeys';
import { useErrorReporter } from '@/components/ErrorBanner';
import MockBanner from '@/components/MockBanner';
import Modal from '@/components/Modal';

/**
 * F-13 — Public API key management: create keys with scopes, see usage,
 * revoke keys. Fully mock-backed (bannered) until the endpoints land.
 * The new secret is shown exactly once.
 */
export default function ApiKeysPage() {
  const { report } = useErrorReporter();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['sites:read']);
  const [busy, setBusy] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await withMockFallback(
          () => notLandedYet<ApiKey[]>(),
          mockApiKeys,
        );
        setKeys(data);
      } catch (e) {
        report(e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleScope = (s: string) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const create = async () => {
    if (!name.trim() || scopes.length === 0) return;
    setBusy(true);
    try {
      const { data } = await withMockFallback(
        () => notLandedYet<ApiKey & { secret: string }>(),
        () => mockCreateKey(name.trim(), scopes),
      );
      setKeys((prev) => [data, ...prev]);
      setNewSecret((data as ApiKey & { secret: string }).secret);
      setCreateOpen(false);
      setName('');
      setScopes(['sites:read']);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  };

  const revoke = (id: string) => {
    if (!confirm('Revoke this API key? Integrations using it will stop working.')) return;
    setKeys((prev) => prev.filter((k) => k.id !== id));
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="bx-micro mb-1">~/ api</p>
          <h1 className="bx-h1">API keys</h1>
        </div>
        <button onClick={() => setCreateOpen(true)} className="bx-btn-primary">
          Create key
        </button>
      </div>
      <div><MockBanner label="API key management" /></div>

      {newSecret && (
        <div className="bx-alert-warn" role="alert">
          <p className="font-semibold">Your new API key — copy it now, it won&rsquo;t be shown again.</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="bx-input font-mono !text-xs">{newSecret}</code>
            <button
              onClick={() => navigator.clipboard.writeText(newSecret).catch(() => {})}
              className="bx-btn-xs-secondary"
            >
              Copy
            </button>
            <button onClick={() => setNewSecret(null)} className="text-xs text-white/50 hover:underline">
              I&rsquo;ve saved it
            </button>
          </div>
        </div>
      )}

      <div className="bx-card">
        <p className="bx-micro mb-3">~/ keys</p>
        {keys.length === 0 ? (
          <div className="bx-empty">
            <p className="text-sm font-medium text-white">No API keys yet</p>
            <p className="mt-1 text-sm text-white/50">
              Create a key to pull your SEO data into Looker Studio, Sheets, or Zapier.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {keys.map((k) => (
              <div key={k.id} className="bx-panel flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-white">{k.name}</p>
                  <p className="font-mono text-xs text-white/40">
                    {k.prefix} · {k.scopes.join(', ')}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-white/30">
                    created {new Date(k.created_at).toLocaleDateString()} ·
                    last used {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'} ·
                    {k.requests_30d.toLocaleString()} requests / 30d
                  </p>
                </div>
                <button onClick={() => revoke(k.id)} className="bx-btn-xs-danger">
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bx-card">
        <p className="bx-micro mb-2">~/ rate limits</p>
        <p className="text-sm text-white/70">
          API keys are rate-limited per tenant (see{' '}
          <a href="/docs/api" className="bx-link">API docs</a>). Exceeding the
          limit returns <code className="font-mono text-xs">429</code> with a{' '}
          <code className="font-mono text-xs">Retry-After</code> header.
        </p>
      </div>

      {createOpen && (
        <Modal title="Create API key" onClose={() => setCreateOpen(false)}>
          <div>
            <label htmlFor="key-name" className="bx-label">Key name</label>
            <input
              id="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Looker Studio connector"
              className="bx-input"
            />
          </div>
          <div className="mt-4">
            <p className="bx-label">Scopes</p>
            <div className="flex flex-wrap gap-1.5">
              {API_SCOPES.map((s) => (
                <button
                  key={s}
                  onClick={() => toggleScope(s)}
                  aria-pressed={scopes.includes(s)}
                  className={`rounded-full border px-2.5 py-1 font-mono text-xs transition ${
                    scopes.includes(s)
                      ? 'border-teal-400/40 bg-teal-400/10 text-teal-300'
                      : 'border-white/10 bg-white/5 text-white/50'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => setCreateOpen(false)} className="bx-btn-secondary">
              Cancel
            </button>
            <button
              onClick={create}
              disabled={busy || !name.trim() || scopes.length === 0}
              className="bx-btn-primary"
            >
              {busy ? 'Creating…' : 'Create key'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
