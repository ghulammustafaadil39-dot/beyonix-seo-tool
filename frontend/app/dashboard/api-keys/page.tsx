'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiKeysApi, ApiError, type ApiKeyRecord } from '@/lib/api';
import { useErrorReporter } from '@/components/ErrorBanner';
import Modal from '@/components/Modal';

/**
 * Fallback scope catalog (mirrors backend API_SCOPES minus 'admin').
 * The live catalog is fetched from GET /api/v1/apikeys/scopes; the
 * 'admin' scope is NEVER offered — the backend rejects it with
 * 400 SCOPE_NOT_ALLOWED because an admin-scoped key could mint more keys.
 */
const FALLBACK_SCOPES = [
  'sites:read',
  'sites:write',
  'audits:read',
  'audits:write',
  'keywords:read',
  'keywords:write',
  'ranks:read',
  'content:read',
  'content:write',
  'geo:read',
  'backlinks:read',
  'reports:read',
  'reports:write',
  'billing:read',
  'webhooks:read',
  'webhooks:write',
];

/**
 * F-13 — Public API key management (WIRED, Wave 2): real CRUD against
 * /api/v1/apikeys. The raw key is shown exactly once at creation; only
 * its prefix is visible afterwards. Revocation is a soft-revoke on the
 * server (the key stops working immediately).
 */
export default function ApiKeysPage() {
  const { report } = useErrorReporter();
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null);
  const [scopeCatalog, setScopeCatalog] = useState<string[]>(FALLBACK_SCOPES);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['sites:read']);
  const [busy, setBusy] = useState(false);
  const [createErr, setCreateErr] = useState('');
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiKeysApi.list();
    setKeys(res.data);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await load();
        const cat = await apiKeysApi.scopes().catch(() => null);
        if (cat && cat.scopes.length > 0) {
          // Never offer 'admin' even though the catalog lists it.
          setScopeCatalog(cat.scopes.filter((s) => s !== 'admin'));
        }
      } catch (e) {
        // A session created via an API key gets 403 HUMAN_SESSION_REQUIRED
        // here; browser sessions should never see it, but handle it
        // honestly instead of a generic failure.
        if (e instanceof ApiError && e.code === 'HUMAN_SESSION_REQUIRED') {
          setKeys([]);
          report(
            new Error('API keys can only be managed from a signed-in user session, not with an API key.'),
          );
        } else {
          report(e);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleScope = (s: string) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const create = async () => {
    if (!name.trim() || scopes.length === 0) return;
    setBusy(true);
    setCreateErr('');
    try {
      const created = await apiKeysApi.create({ name: name.trim(), scopes });
      setNewSecret(created.key);
      setCreateOpen(false);
      setName('');
      setScopes(['sites:read']);
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SCOPE_NOT_ALLOWED') {
        setCreateErr("The 'admin' scope can't be granted to an API key — pick resource scopes instead.");
      } else if (e instanceof ApiError && e.code === 'HUMAN_SESSION_REQUIRED') {
        setCreateErr('API keys can only be created from a signed-in user session.');
      } else if (e instanceof ApiError) {
        setCreateErr(e.message);
      } else {
        report(e);
      }
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (k: ApiKeyRecord) => {
    if (!confirm(`Revoke "${k.name}"? Integrations using it will stop working immediately.`)) return;
    try {
      await apiKeysApi.revoke(k.id);
      await load();
    } catch (e) {
      report(e);
    }
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
        {keys === null ? (
          <p className="font-mono text-sm text-white/55">$ loading keys…</p>
        ) : keys.length === 0 ? (
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
                  <p className="flex items-center gap-2 text-sm font-semibold text-white">
                    {k.name}
                    {k.revoked_at && (
                      <span className="bx-pill bx-pill-err">
                        <span className="bx-dot" />
                        revoked
                      </span>
                    )}
                  </p>
                  <p className="font-mono text-xs text-white/55">
                    {k.key_prefix}… · {k.scopes.join(', ')}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-white/50">
                    created {new Date(k.created_at).toLocaleDateString()} ·
                    last used {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : 'never'} ·
                    limit {k.rate_limit_per_min}/min
                  </p>
                </div>
                {!k.revoked_at && (
                  <button onClick={() => revoke(k)} className="bx-btn-xs-danger">
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bx-card">
        <p className="bx-micro mb-2">~/ rate limits</p>
        <p className="text-sm text-white/70">
          Each key has its own per-minute rate limit (shown on the key). Exceeding
          it returns <code className="font-mono text-xs">429</code> — back off and
          retry. Full endpoint reference:{' '}
          <a href="/docs/api" className="bx-link">API docs</a> ·{' '}
          <a href="/api/v1/openapi.json" className="bx-link">OpenAPI spec</a>.
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
              {scopeCatalog.map((s) => (
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
            <p className="bx-hint">
              A <span className="font-mono">:write</span> scope also covers the matching{' '}
              <span className="font-mono">:read</span>. The <span className="font-mono">admin</span>{' '}
              scope is never available to API keys.
            </p>
          </div>
          {createErr && <p className="bx-alert-err mt-4" role="alert">{createErr}</p>}
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
