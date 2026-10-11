'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { teamApi, authApi, ApiError } from '@/lib/api';

/**
 * F-09 — Invitation accept landing (the link emailed by
 * POST /api/v1/account/invitations points here). The visitor must be
 * signed in with the invited email address. Accepting MOVES the account
 * into the inviting workspace; the backend refuses (409
 * INVITE_WOULD_ORPHAN_DATA / INVITE_WOULD_ORPHAN_TENANT) when the move
 * would strand data or a workspace — surfaced verbatim below.
 *
 * B3-L1: the accept endpoint now issues the fresh session directly as an
 * httpOnly cookie (F-09 fix, backend commit 345b563 — setAuthCookie +
 * setCsrfCookie, forwarded to the browser by the same-origin proxy), so
 * the browser session is already switched to the new workspace when the
 * accept call resolves. We verify with /auth/me and navigate straight to
 * /dashboard; the manual sign-in prompt only appears as a fallback if the
 * session cookie did not actually switch (e.g. blocked third-party/
 * partitioned cookie edge cases).
 */
export default function AcceptInvitePage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<'ready' | 'busy' | 'done' | 'error'>('ready');
  const [sessionState, setSessionState] = useState<'checking' | 'fallback'>('checking');
  const [role, setRole] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    // The token arrives in the URL, is immediately scrubbed from it, and
    // is kept in sessionStorage so the flow survives the login redirect
    // (an unauthenticated accept attempt bounces to /login and back).
    const fromUrl = new URLSearchParams(window.location.search).get('token');
    const t = fromUrl ?? window.sessionStorage.getItem('bseo_invite_token');
    if (fromUrl) {
      window.sessionStorage.setItem('bseo_invite_token', fromUrl);
      window.history.replaceState(null, '', window.location.pathname);
    }
    setToken(t);
    if (!t) {
      setState('error');
      setError('This invitation link is incomplete — ask the sender for a new invitation.');
    }
  }, []);

  const accept = async () => {
    if (!token) return;
    setState('busy');
    try {
      const res = await teamApi.acceptInvitation(token);
      window.sessionStorage.removeItem('bseo_invite_token');
      setRole(res.role);
      setSessionState('checking');
      setState('done');
      // The session cookie was already switched by the accept call. Verify
      // with /auth/me before navigating; on any failure fall back to the
      // manual sign-in prompt instead of bouncing to a broken dashboard.
      try {
        await authApi.me();
        router.push('/dashboard');
      } catch {
        setSessionState('fallback');
      }
    } catch (e) {
      setState('error');
      if (e instanceof ApiError) {
        if (e.status === 410 || e.code === 'INVITE_EXPIRED') {
          setError('This invitation has expired or was already used. Ask for a new invitation.');
        } else if (e.code === 'INVITE_WOULD_ORPHAN_DATA') {
          setError(
            'You own a workspace with data, so this account cannot move. Delete or transfer that workspace first, then accept.',
          );
        } else if (e.code === 'INVITE_WOULD_ORPHAN_TENANT') {
          setError(
            'You are the last owner of your current workspace. Transfer ownership first, then accept.',
          );
        } else if (e.status === 403) {
          setError('This invitation was sent to a different email address than the one you are signed in with.');
        } else {
          setError(e.message);
        }
      } else {
        setError('Something went wrong accepting this invitation.');
      }
    }
  };

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <p className="bx-micro mb-1">~/ team invite</p>
        <h1 className="bx-h1">Join workspace</h1>
      </div>

      {state === 'done' ? (
        <div className="bx-card">
          <p className="bx-alert-ok">
            You&rsquo;ve joined the workspace{role ? ` as ${role}` : ''}.
          </p>
          {sessionState === 'fallback' ? (
            <>
              <p className="bx-body mt-3">
                Your browser session didn&rsquo;t pick up the new workspace —
                sign in once to continue.
              </p>
              <Link href="/login" className="bx-btn-primary mt-4 inline-block">
                Sign in to continue
              </Link>
            </>
          ) : (
            <p className="bx-body mt-3" role="status">
              Taking you to your new workspace…
            </p>
          )}
        </div>
      ) : state === 'error' ? (
        <div className="bx-card">
          <p className="bx-alert-err" role="alert">{error}</p>
          <Link href="/dashboard" className="bx-link mt-4 inline-block text-sm">
            ← Back to dashboard
          </Link>
        </div>
      ) : (
        <div className="bx-card">
          <p className="bx-body">
            Accepting moves your account into the inviting workspace. If your
            current workspace has data or teammates who depend on you as owner,
            the move is refused — nothing is deleted.
          </p>
          <button onClick={accept} disabled={state === 'busy' || !token} className="bx-btn-primary mt-4">
            {state === 'busy' ? 'Joining…' : 'Accept invitation'}
          </button>
        </div>
      )}
    </div>
  );
}
