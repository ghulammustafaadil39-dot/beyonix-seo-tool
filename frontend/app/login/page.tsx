'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { authApi } from '@/lib/api';

function LoginForm() {
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
      await authApi.login({ email, password });
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
          <p className="bx-micro mb-2 text-center">~/ auth</p>
          <h1 className="mb-6 text-center text-xl font-bold text-white">
            Log in to <span className="text-teal-300">Beyonix SEO</span>
          </h1>
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
