'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authApi } from '@/lib/api';

export default function SignupPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await authApi.signup({ name, email, password });
      // Preserve a plan choice from the public pricing page (?plan=&billing=).
      const params = new URLSearchParams(window.location.search);
      const plan = params.get('plan');
      const billing = params.get('billing') === 'annual' ? 'annual' : 'monthly';
      const dest =
        plan && ['starter', 'growth', 'pro'].includes(plan)
          ? `/dashboard/billing?plan=${plan}&billing=${billing}`
          : '/dashboard';
      router.push(dest);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signup failed');
    } finally {
      setLoading(false);
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
            Create your <span className="text-teal-300">Beyonix SEO</span> account
          </h1>
          <form onSubmit={submit} className="space-y-4">
            {error && (
              <p role="alert" className="bx-alert-err">
                {error}
              </p>
            )}
            <div>
              <label className="bx-label">Name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="bx-input"
              />
            </div>
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
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bx-input"
              />
              <p className="bx-hint">At least 8 characters.</p>
            </div>
            <button type="submit" disabled={loading} className="bx-btn-primary w-full py-2.5">
              {loading ? 'Creating account…' : 'Sign up'}
            </button>
            <p className="text-center text-sm text-white/55">
              Have an account?{' '}
              <Link href="/login" className="bx-link">
                Log in
              </Link>
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
