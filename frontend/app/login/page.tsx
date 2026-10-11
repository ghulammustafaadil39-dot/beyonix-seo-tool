'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, authApi } from '@/lib/api';

function LoginForm({ onTotp }: { onTotp: (token: string) => void }) {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await authApi.login({ email, password });
      if ('totpRequired' in res && res.totpRequired) {
        // Password was correct but 2FA is enabled: hand the short-lived
        // challenge token to the TOTP step (kept in state, never in the URL).
        onTotp(res.totpToken);
        return;
      }
      // Only allow relative redirect targets (prevents open-redirect attacks).
      const next = params.get('next');
      router.push(next && /^\/[^/]/.test(next) ? next : '/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {error && (
        <p role="alert" className="bx-alert-err">
          {error}
        </p>
      )}
      <div>
        <label className="bx-label">Email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="bx-input"
        />
      </div>
      <div>
        <label className="bx-label">Password</label>
        <input
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="bx-input"
        />
      </div>
      <button type="submit" disabled={loading} className="bx-btn-primary w-full py-2.5">
        {loading ? 'Logging in…' : 'Log in'}
      </button>
      <p className="text-center text-sm text-white/40">
        No account?{' '}
        <Link href="/signup" className="bx-link">
          Sign up
        </Link>
      </p>
    </form>
  );
}

function TotpForm({ challengeToken, onBack }: { challengeToken: string; onBack: () => void }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Backup-code mode: the backend accepts backup codes (4–32 chars) as an
  // alternative to the 6-digit TOTP. Without this toggle, users who lost
  // their authenticator would have no recovery path in the UI.
  const [useBackup, setUseBackup] = useState(false);
  const submitting = useRef(false);

  const verify = useCallback(
    async (value: string) => {
      if (submitting.current || !value) return;
      submitting.current = true;
      setLoading(true);
      setError('');
      try {
        await authApi.verifyTotp({ totpToken: challengeToken, code: value });
        router.push('/dashboard');
      } catch (err) {
        submitting.current = false;
        setLoading(false);
        if (err instanceof ApiError) {
          if (err.code === 'INVALID_CODE') {
            setError(
              useBackup
                ? "That backup code didn't match. Check it carefully and try again."
                : "That code didn't match. Check your authenticator app and try again.",
            );
          } else if (err.code === 'INVALID_TOKEN') {
            setError('This 2FA challenge has expired. Please sign in again.');
          } else {
            setError(err.message);
          }
        } else {
          setError(err instanceof Error ? err.message : 'Verification failed');
        }
        setCode('');
      }
    },
    [challengeToken, router, useBackup],
  );

  // Auto-submit as soon as a full 6-digit code is present (typed or pasted).
  // In backup-code mode there is no auto-submit (codes are 4–32 chars).
  const handleChange = (raw: string) => {
    if (useBackup) {
      setCode(raw.slice(0, 32));
      return;
    }
    const digits = raw.replace(/\D/g, '').slice(0, 6);
    setCode(digits);
    if (digits.length === 6) void verify(digits);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (useBackup) return; // default paste behavior is fine for backup codes
    const digits = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (digits.length === 6) {
      e.preventDefault();
      setCode(digits);
      void verify(digits);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void verify(useBackup ? code.trim() : code);
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="text-center">
        <h2 className="text-lg font-bold text-white">Two-factor authentication</h2>
        <p className="mt-1 text-sm text-white/50">
          {useBackup
            ? 'Enter one of your backup codes. Each code works once.'
            : 'Enter the 6-digit code from your authenticator app. It changes every 30 seconds.'}
        </p>
      </div>
      {error && (
        <p role="alert" className="bx-alert-err">
          {error}
        </p>
      )}
      <div>
        <label className="bx-label" htmlFor="totp-code">
          Authentication code
        </label>
        <input
          id="totp-code"
          inputMode={useBackup ? 'text' : 'numeric'}
          autoComplete={useBackup ? 'off' : 'one-time-code'}
          autoFocus
          required
          minLength={useBackup ? 4 : 6}
          maxLength={useBackup ? 32 : 6}
          pattern={useBackup ? undefined : '[0-9]{6}'}
          value={code}
          onChange={(e) => handleChange(e.target.value)}
          onPaste={handlePaste}
          placeholder={useBackup ? 'backup code' : '000000'}
          disabled={loading}
          className="bx-input text-center text-2xl tracking-[0.5em] tabular-nums"
        />
      </div>
      <button
        type="submit"
        disabled={loading || (useBackup ? code.trim().length < 4 : code.length < 6)}
        className="bx-btn-primary w-full py-2.5"
      >
        {loading ? 'Verifying…' : 'Verify'}
      </button>
      <p className="flex items-center justify-center gap-4 text-center text-sm text-white/40">
        <button
          type="button"
          onClick={() => {
            setUseBackup((v) => !v);
            setCode('');
            setError('');
          }}
          className="bx-link"
        >
          {useBackup ? 'Use authenticator app instead' : 'Use a backup code instead'}
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={onBack} className="bx-link">
          ← Back to sign in
        </button>
      </p>
    </form>
  );
}

/**
 * Security: the OAuth callback lands at /login?totp=1&token=<challenge>.
 * The challenge token is read ONCE on mount into component state and then
 * immediately stripped from the URL (router.replace), so it never lingers
 * in the address bar, browser history, or shared links. It lives only in
 * memory for the lifetime of this page.
 */
function LoginFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const wantsTotp = params.get('totp') === '1';
  const [totpToken, setTotpToken] = useState<string | null>(null);
  const [urlScrubbed, setUrlScrubbed] = useState(false);

  useEffect(() => {
    const token = params.get('token');
    if (params.get('totp') === '1' && token) {
      setTotpToken(token);
      router.replace('/login?totp=1');
    }
    setUrlScrubbed(true);
    // Runs once on mount: the URL is the only source we ever read the token from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const backToLogin = useCallback(() => {
    setTotpToken(null);
    router.replace('/login');
  }, [router]);

  // The TOTP step shows either when the OAuth callback put ?totp=1 in the
  // URL, or when a password login just returned a challenge token.
  const showTotp = wantsTotp || totpToken !== null;

  return (
    <>
      <p className="bx-micro mb-2 text-center">~/ auth</p>
      <h1 className="mb-6 text-center text-xl font-bold text-white">
        {showTotp ? (
          <>Verify your <span className="text-teal-300">sign-in</span></>
        ) : (
          <>Log in to <span className="text-teal-300">Beyonix SEO</span></>
        )}
      </h1>
      {showTotp ? (
        urlScrubbed ? (
          totpToken ? (
            <TotpForm challengeToken={totpToken} onBack={backToLogin} />
          ) : (
            <div className="space-y-4 text-center">
              <p role="alert" className="bx-alert-err">
                This 2FA link is invalid or has expired. Please sign in again.
              </p>
              <button onClick={backToLogin} className="bx-btn-primary w-full py-2.5">
                Back to sign in
              </button>
            </div>
          )
        ) : null
      ) : (
        <LoginForm onTotp={setTotpToken} />
      )}
    </>
  );
}

export default function LoginPage() {
  return (
    <div className="bx-glow flex min-h-screen items-center justify-center bg-[#04090c] px-4">
      <div className="relative w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-300 to-teal-400 text-xl font-bold text-[#04181a] shadow-[0_0_32px_rgba(45,212,191,0.4)]">
            B
          </span>
        </div>
        <div className="bx-card">
          <Suspense>
            <LoginFlow />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
