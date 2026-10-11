'use client';

import { useEffect, useState } from 'react';
import { settingsApi, type Settings } from '@/lib/api';
import { useErrorReporter } from '@/components/ErrorBanner';
import { PageHeaderSkeleton, SkeletonLines } from '@/components/Skeleton';

export default function SettingsPage() {
  const { report } = useErrorReporter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [llmProvider, setLlmProvider] = useState('default');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s: Settings = await settingsApi.get();
        setNotifyEmail(s.notify_email ?? '');
        setTelegramChatId(s.telegram_chat_id ?? '');
        setLlmProvider(s.llm_provider ?? 'default');
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
      });
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

        <button type="submit" disabled={saving} className="bx-btn-primary">
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </form>
    </div>
  );
}
