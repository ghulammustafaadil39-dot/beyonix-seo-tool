'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, authApi } from '@/lib/api';

/**
 * G3-M-1: password-reset confirmation. The token arrives as ?token=… from
 * the email link; it is read once into state (never logged or stored) and
 * exchanged for the new password. All sessions are revoked server-side.
 * K3-L-2 (pass#11): the token is scrubbed from the URL immediately after
 * reading (router.replace), like the invite-token and TOTP-challenge
 * flows — it must not linger in history/address bar.
 */
function ResetForm() {
  const params = useSearchParams();
  const router = useRouter();
  const [token, setToken] = useState('');
  useEffect(() => {
    setToken(params.get('token') ?? '');
    router.replace('/reset-password');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (password !== confirm) {
        throw new Error('The passwords don’t match — please retype them.');
      }
      if (password.length < 12) {
        throw new Error('Password must be at least 12 characters.');
      }
      await authApi.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_TOKEN') {
        setError(
          'This reset link is invalid or has expired. Request a new one from the sign-in page.',
        );
      } else {
        setError(err instanceof Error ? err.message : 'Password reset failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <div className="space-y-4 text-center">
        <p role="alert" className="bx-alert-err">
          This reset link is missing its token. Please use the full link from
          your email, or request a new one.
        </p>
        <p className="text-sm text-white/55">
          <Link href="/forgot-password" className="bx-link">
            Request a new reset link
          </Link>
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="space-y-4 text-center">
        <p role="status" className="bx-alert-ok">
          Your password has been set. You've been signed out everywhere for
          safety — sign in with your new password.
        </p>
        <Link href="/login" className="bx-btn-primary block w-full py-2.5">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <p role="alert" className="bx-alert-err">
          {error}
        </p>
      )}
      <div>
        <label htmlFor="new-password" className="bx-label">New password</label>
        <input
          id="new-password"
          type="password"
          required
          autoComplete="new-password"
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="bx-input"
        />
        <p className="bx-hint">At least 12 characters.</p>
      </div>
      <div>
        <label htmlFor="confirm-password" className="bx-label">Confirm new password</label>
        <input
          id="confirm-password"
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="bx-input"
        />
      </div>
      <button type="submit" disabled={busy} className="bx-btn-primary w-full py-2.5">
        {busy ? 'Setting…' : 'Set new password'}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
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
            Choose a <span className="text-teal-300">new password</span>
          </h1>
          <Suspense>
            <ResetForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
