'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, authApi } from '@/lib/api';
import { encodeQr } from '@/lib/qr';
import QrCode from '@/components/QrCode';

type TotpStatus = 'loading' | 'enabled' | 'disabled' | 'error';

function friendlyTotpError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'INVALID_CODE')
      return "That code didn't match. Check your authenticator app and try again.";
    if (err.code === 'INVALID_CREDENTIALS') return 'Password is incorrect.';
    if (err.code === 'TOTP_ALREADY_ENABLED')
      return 'Two-factor authentication is already enabled on this account.';
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong. Please try again.';
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="bx-btn-xs-secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard unavailable — the value is still visible to copy by hand.
        }
      }}
    >
      {copied ? 'Copied ✓' : label}
    </button>
  );
}

function TwoFactorCard() {
  const [status, setStatus] = useState<TotpStatus>('loading');
  const [statusError, setStatusError] = useState('');
  // Setup flow state
  const [secret, setSecret] = useState('');
  const [otpauthUrl, setOtpauthUrl] = useState('');
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [qrFailed, setQrFailed] = useState(false);
  const [code, setCode] = useState('');
  const [enableBusy, setEnableBusy] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  // Disable flow state
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableBusy, setDisableBusy] = useState(false);
  const [disableError, setDisableError] = useState('');
  const [notice, setNotice] = useState('');

  // Probe 2FA status: the backend has no status endpoint, so a setup call
  // that answers TOTP_ALREADY_ENABLED means "already on". When off, the
  // call usefully returns a fresh pending secret — but we discard it until
  // the user explicitly starts setup (secret shown only in the setup step).
  useEffect(() => {
    (async () => {
      try {
        await authApi.totpSetup();
        setStatus('disabled');
      } catch (err) {
        if (err instanceof ApiError && err.code === 'TOTP_ALREADY_ENABLED') {
          setStatus('enabled');
        } else {
          setStatusError(friendlyTotpError(err));
          setStatus('error');
        }
      }
    })();
  }, []);

  const startSetup = async () => {
    setSetupBusy(true);
    setSetupError('');
    setQrFailed(false);
    try {
      const res = await authApi.totpSetup();
      setSecret(res.secret);
      setOtpauthUrl(res.otpauthUrl);
      try {
        // Validate the QR renders before showing the setup step; on failure
        // the user can still enroll via manual secret entry.
        encodeQr(res.otpauthUrl);
      } catch {
        setQrFailed(true);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOTP_ALREADY_ENABLED') {
        setStatus('enabled');
      } else {
        setSetupError(friendlyTotpError(err));
      }
    } finally {
      setSetupBusy(false);
    }
  };

  const enable = async (e: React.FormEvent) => {
    e.preventDefault();
    setEnableBusy(true);
    setSetupError('');
    try {
      const res = await authApi.totpEnable(code.replace(/\D/g, ''));
      setBackupCodes(res.backupCodes);
      setStatus('enabled');
      setSecret('');
      setOtpauthUrl('');
      setCode('');
    } catch (err) {
      setSetupError(friendlyTotpError(err));
      setCode('');
    } finally {
      setEnableBusy(false);
    }
  };

  const disable = async (e: React.FormEvent) => {
    e.preventDefault();
    setDisableBusy(true);
    setDisableError('');
    try {
      await authApi.totpDisable(disablePassword);
      setStatus('disabled');
      setConfirmingDisable(false);
      setDisablePassword('');
      setNotice('Two-factor authentication is now off.');
    } catch (err) {
      setDisableError(friendlyTotpError(err));
    } finally {
      setDisableBusy(false);
    }
  };

  const resetSetup = () => {
    setSecret('');
    setOtpauthUrl('');
    setCode('');
    setSetupError('');
    setQrFailed(false);
    setBackupCodes(null);
  };

  return (
    <div className="bx-card space-y-4">
      <div>
        <p className="bx-micro mb-1">~/ security</p>
        <h2 className="text-base font-bold text-white">Two-factor authentication</h2>
        <p className="bx-hint">
          Adds a 6-digit code from your authenticator app to every sign-in.
        </p>
      </div>

      {notice && <p className="bx-alert-ok">{notice}</p>}

      {status === 'loading' && <p className="text-sm text-white/55">Checking 2FA status…</p>}
      {status === 'error' && (
        <p role="alert" className="bx-alert-err">
          {statusError || 'Could not check 2FA status.'}
        </p>
      )}

      {status === 'enabled' && backupCodes === null && !confirmingDisable && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-teal-400/25 bg-teal-400/10 px-3 py-1 text-sm font-medium text-teal-200">
            <span className="h-2 w-2 rounded-full bg-teal-300" /> On
          </span>
          <button
            type="button"
            onClick={() => {
              setConfirmingDisable(true);
              setDisableError('');
              setNotice('');
            }}
            className="bx-btn-xs-danger"
          >
            Disable 2FA
          </button>
        </div>
      )}

      {status === 'enabled' && confirmingDisable && backupCodes === null && (
        <form onSubmit={disable} className="space-y-3 rounded-xl border border-red-400/20 bg-red-400/5 p-4">
          <p className="text-sm font-medium text-white">
            Disable two-factor authentication?
          </p>
          <p className="text-sm text-white/55">
            Your account will be protected by password alone. Confirm with your
            account password.
          </p>
          {disableError && (
            <p role="alert" className="bx-alert-err">
              {disableError}
            </p>
          )}
          <div>
            <label htmlFor="totp-disable-password" className="bx-label">
              Account password
            </label>
            <input
              id="totp-disable-password"
              type="password"
              required
              autoComplete="current-password"
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
              className="bx-input"
            />
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={disableBusy || !disablePassword} className="bx-btn-xs-danger !px-3 !py-2 !text-sm">
              {disableBusy ? 'Disabling…' : 'Disable 2FA'}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmingDisable(false);
                setDisablePassword('');
                setDisableError('');
              }}
              className="bx-btn-secondary !px-3 !py-2 !text-sm"
            >
              Keep it on
            </button>
          </div>
        </form>
      )}

      {status === 'disabled' && !secret && (
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-sm font-medium text-white/60">
            <span className="h-2 w-2 rounded-full bg-white/30" /> Off
          </div>
          {setupError && (
            <p role="alert" className="bx-alert-err mb-3">
              {setupError}
            </p>
          )}
          <div>
            <button type="button" onClick={startSetup} disabled={setupBusy} className="bx-btn-primary">
              {setupBusy ? 'Preparing…' : 'Set up two-factor authentication'}
            </button>
          </div>
        </div>
      )}

      {status === 'disabled' && secret && backupCodes === null && (
        <div className="space-y-4">
          <ol className="space-y-4 text-sm text-white/70">
            <li>
              <p className="mb-2 font-medium text-white">
                <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-teal-400/15 text-xs font-bold text-teal-300">1</span>
                Scan this QR code with your authenticator app
              </p>
              <div className="flex flex-wrap items-start gap-4">
                {qrFailed ? (
                  <p role="alert" className="bx-alert-err">
                    Couldn't render the QR code — enter the secret below manually instead.
                  </p>
                ) : (
                  <QrCode text={otpauthUrl} size={168} />
                )}
                <div className="min-w-0 flex-1">
                  <p className="bx-label">Or enter this secret manually</p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-teal-200">
                      {secret}
                    </code>
                    <CopyButton text={secret} />
                  </div>
                  <p className="bx-hint">Google Authenticator, 1Password, Authy, or any TOTP app works.</p>
                </div>
              </div>
            </li>
            <li>
              <form onSubmit={enable} className="space-y-3">
                <p className="font-medium text-white">
                  <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full bg-teal-400/15 text-xs font-bold text-teal-300">2</span>
                  Enter the 6-digit code from your app to confirm
                </p>
                {setupError && (
                  <p role="alert" className="bx-alert-err">
                    {setupError}
                  </p>
                )}
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <label htmlFor="totp-setup-code" className="bx-label">
                      Authentication code
                    </label>
                    <input
                      id="totp-setup-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      required
                      pattern="[0-9]{6}"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                      placeholder="000000"
                      className="bx-input w-40 text-center text-xl tracking-[0.4em] tabular-nums"
                    />
                  </div>
                  <button type="submit" disabled={enableBusy || code.length < 6} className="bx-btn-primary">
                    {enableBusy ? 'Verifying…' : 'Verify & enable'}
                  </button>
                  <button type="button" onClick={resetSetup} className="bx-link text-sm">
                    Cancel
                  </button>
                </div>
              </form>
            </li>
          </ol>
        </div>
      )}

      {backupCodes !== null && (
        <div className="space-y-3 rounded-xl border border-amber-400/20 bg-amber-400/5 p-4">
          <p className="text-sm font-bold text-white">✓ Two-factor authentication is on</p>
          <p className="text-sm text-white/70">
            Save these backup codes somewhere safe — each works once, and they
            are the only way back in if you lose your authenticator app. They
            will never be shown again.
          </p>
          <div className="grid grid-cols-2 gap-2 font-mono text-sm">
            {backupCodes.map((c) => (
              <code key={c} className="rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-center text-teal-200">
                {c}
              </code>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <CopyButton text={backupCodes.join('\n')} label="Copy all codes" />
            <button
              type="button"
              onClick={resetSetup}
              className="bx-btn-primary"
            >
              I've saved these codes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PasswordChangeCard() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (newPassword !== confirm) {
        throw new Error('The new passwords don’t match — please retype them.');
      }
      if (newPassword.length < 12) {
        throw new Error('New password must be at least 12 characters.');
      }
      if (newPassword === currentPassword) {
        throw new Error('The new password must be different from the current one.');
      }
      await authApi.changePassword(currentPassword, newPassword);
      // The backend revokes ALL sessions on password change, including this
      // one — the user must sign in again.
      setDone(true);
      setTimeout(() => router.push('/login?password-changed=1'), 1800);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'INVALID_CREDENTIALS') {
        setError('Current password is incorrect.');
      } else {
        setError(err instanceof Error ? err.message : 'Password change failed.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="bx-card space-y-3">
        <p className="bx-micro mb-1">~/ security</p>
        <h2 className="text-base font-bold text-white">Password</h2>
        <p className="bx-alert-ok">
          Password changed. For your safety you've been signed out everywhere —
          taking you to the login page…
        </p>
      </div>
    );
  }

  return (
    <div className="bx-card">
      <p className="bx-micro mb-1">~/ security</p>
      <h2 className="text-base font-bold text-white">Password</h2>
      <p className="bx-hint mb-4">
        Changing your password signs you out on all devices.
      </p>
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <p role="alert" className="bx-alert-err">
            {error}
          </p>
        )}
        <div>
          <label htmlFor="pw-current" className="bx-label">Current password</label>
          <input
            id="pw-current"
            type="password"
            required
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="bx-input"
          />
        </div>
        <div>
          <label htmlFor="pw-new" className="bx-label">New password</label>
          <input
            id="pw-new"
            type="password"
            required
            autoComplete="new-password"
            minLength={12}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="bx-input"
          />
          <p className="bx-hint">At least 12 characters. Avoid common or previously breached passwords.</p>
        </div>
        <div>
          <label htmlFor="pw-confirm" className="bx-label">Confirm new password</label>
          <input
            id="pw-confirm"
            type="password"
            required
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="bx-input"
          />
        </div>
        <button type="submit" disabled={busy} className="bx-btn-primary">
          {busy ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </div>
  );
}

export default function SecuritySection() {
  return (
    <div className="space-y-6">
      <TwoFactorCard />
      <PasswordChangeCard />
    </div>
  );
}
