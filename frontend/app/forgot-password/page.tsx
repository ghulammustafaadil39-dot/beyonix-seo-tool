'use client';

import { useState } from 'react';
import Link from 'next/link';
import { authApi } from '@/lib/api';

/**
 * G3-M-1: password-reset request. The backend ALWAYS returns success (no
 * account enumeration), so the UI shows the same confirmation regardless
 * of whether the address is registered.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await authApi.requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      // Network/server failure only — never hint at account existence.
      setError(
        err instanceof Error
          ? err.message
          : 'Something went wrong. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bx-glow flex min-h-screen items-center justify-center bg-[#04090c] px-4">
      <div className="relative w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-300 to-teal-400 text-xl font-bold text-[#04181a] shadow-[0_0_32px_rgba(45,212,191,0.4)]">
            B
          </span>
        </div>
        <div className="bx-card">
          <p className="bx-micro mb-2 text-center">~/ auth</p>
          <h1 className="mb-6 text-center text-xl font-bold text-white">
            Reset your <span className="text-teal-300">password</span>
          </h1>
          {sent ? (
            <div className="space-y-4 text-center">
              <p role="status" className="bx-alert-ok">
                If an account exists for <span className="font-medium">{email.trim()}</span>,
                a password-reset link is on its way. Check your inbox (and spam folder) —
                the link expires in 24 hours.
              </p>
              <p className="text-sm text-white/55">
                <Link href="/login" className="bx-link">
                  ← Back to sign in
                </Link>
              </p>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              {error && (
                <p role="alert" className="bx-alert-err">
                  {error}
                </p>
              )}
              <p className="text-sm text-white/55">
                Enter the email address you signed up with and we'll send you a
                link to set a new password.
              </p>
              <div>
                <label htmlFor="reset-email" className="bx-label">Email</label>
                <input
                  id="reset-email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="bx-input"
                />
              </div>
              <button type="submit" disabled={busy} className="bx-btn-primary w-full py-2.5">
                {busy ? 'Sending…' : 'Send reset link'}
              </button>
              <p className="text-center text-sm text-white/55">
                <Link href="/login" className="bx-link">
                  ← Back to sign in
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
