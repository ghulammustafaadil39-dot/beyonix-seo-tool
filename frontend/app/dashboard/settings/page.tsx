'use client';

import { useEffect, useState } from 'react';
import { settingsApi, type Settings } from '@/lib/api';
import { useErrorReporter } from '@/components/ErrorBanner';
import { PageHeaderSkeleton, SkeletonLines } from '@/components/Skeleton';
import SecuritySection from '@/components/SecuritySection';

export default function SettingsPage() {
  const { report } = useErrorReporter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [llmProvider, setLlmProvider] = useState('default');
  // D3-L-3: BYOK key. Never pre-filled from the server (the API only
  // reports llm_key_set); a typed value is sent on save, an empty string
  // clears the saved key (backend A1-L6 affordance).
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmKeySet, setLlmKeySet] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s: Settings = await settingsApi.get();
        setNotifyEmail(s.notify_email ?? '');
        setTelegramChatId(s.telegram_chat_id ?? '');
        setLlmProvider(s.llm_provider ?? 'default');
        setLlmKeySet(s.llm_key_set);
      } catch (e) {
        report(e);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      const email = notifyEmail.trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('That notification email doesn’t look valid — please check it and try again.');
      }
      await settingsApi.update({
        notify_email: email || undefined,
        telegram_chat_id: telegramChatId.trim() || undefined,
        llm_provider: llmProvider,
        // Only send the key when the user typed one — otherwise the field
        // is absent and the saved key is untouched.
        ...(llmApiKey ? { llm_api_key: llmApiKey } : {}),
      });
      setSaved(true);
    } catch (err) {
      report(err);
    } finally {
      setSaving(false);
    }
  };

  // D3-L-3: explicit "remove my saved key" affordance (empty string =
  // clear, per the backend A1-L6 contract).
  const clearLlmKey = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const s = await settingsApi.update({ llm_api_key: '' });
      setLlmApiKey('');
      setLlmKeySet(s.llm_key_set);
      setSaved(true);
    } catch (err) {
      report(err);
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <PageHeaderSkeleton />
        <div className="bx-card">
          <SkeletonLines rows={4} />
        </div>
      </div>
    );

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <p className="bx-micro mb-1">~/ config</p>
        <h1 className="bx-h1">Settings</h1>
      </div>

      <form onSubmit={save} className="bx-card space-y-5">
        {saved && <p className="bx-alert-ok">Settings saved.</p>}

        <div>
          <label htmlFor="notify-email" className="bx-label">Notification email</label>
          <input
            id="notify-email"
            type="email"
            value={notifyEmail}
            onChange={(e) => setNotifyEmail(e.target.value)}
            placeholder="you@business.com"
            className="bx-input"
          />
          <p className="bx-hint">Weekly reports and alerts are sent here.</p>
        </div>

        <div>
          <label htmlFor="telegram-chat-id" className="bx-label">Telegram chat ID</label>
          <input
            id="telegram-chat-id"
            type="text"
            value={telegramChatId}
            onChange={(e) => setTelegramChatId(e.target.value)}
            placeholder="e.g. 123456789"
            className="bx-input font-mono"
          />
          <p className="bx-hint">
            Optional — get notifications via Telegram instead of email. To find your
            chat ID, message <span className="font-mono text-teal-300">@userinfobot</span> on Telegram and copy the ID it replies with.
          </p>
        </div>

        <div>
          <label htmlFor="ai-provider" className="bx-label">AI provider</label>
          <select
            id="ai-provider"
            value={llmProvider}
            onChange={(e) => setLlmProvider(e.target.value)}
            className="bx-input"
          >
            <option value="default">Recommended (automatic)</option>
            <option value="gemini">Gemini</option>
            <option value="openai">OpenAI</option>
          </select>
          <p className="bx-hint">Which AI engine generates content and on-page suggestions.</p>
        </div>

        <div>
          <label htmlFor="llm-api-key" className="bx-label">Your AI API key (BYOK)</label>
          <input
            id="llm-api-key"
            type="password"
            autoComplete="off"
            value={llmApiKey}
            onChange={(e) => setLlmApiKey(e.target.value)}
            placeholder={llmKeySet ? 'A key is saved — type a new one to replace it' : 'Paste your Gemini or OpenAI API key'}
            className="bx-input font-mono"
          />
          <p className="bx-hint">
            Optional — use your own key for the AI engine selected above. Keys are encrypted server-side and never shown again.
            {llmKeySet && (
              <>
                {' '}A key is currently saved.{' '}
                <button type="button" onClick={clearLlmKey} disabled={saving} className="bx-link text-sm">
                  Remove it
                </button>
              </>
            )}
          </p>
        </div>

        <button type="submit" disabled={saving} className="bx-btn-primary">
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </form>

      {/* G3-M-1: account-security self-service — 2FA enrollment + password change. */}
      <SecuritySection />
    </div>
  );
}
