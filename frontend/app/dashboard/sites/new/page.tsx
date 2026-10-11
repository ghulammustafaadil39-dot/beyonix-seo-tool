'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { sitesApi, auditsApi, type Site, type VerifyResult } from '@/lib/api';
import { useErrorReporter } from '@/components/ErrorBanner';

type Step = 1 | 2 | 3;

function NewSiteForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { report } = useErrorReporter();
  const [step, setStep] = useState<Step>(1);
  const [domain, setDomain] = useState('');
  const [site, setSite] = useState<Site | null>(null);
  const [verifyMethod, setVerifyMethod] = useState<'meta' | 'file' | 'dns'>('meta');
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [working, setWorking] = useState(false);
  const [gscUrl, setGscUrl] = useState<string | null>(null);

  // Resume setup for an existing (unverified) site instead of creating a
  // duplicate: /dashboard/sites/new?siteId=<id>
  const resumeId = searchParams.get('siteId');
  useEffect(() => {
    if (!resumeId || site) return;
    (async () => {
      setWorking(true);
      try {
        const s = await sitesApi.get(resumeId);
        setSite(s);
        setDomain(s.domain);
        setStep(2);
      } catch (e) {
        report(e);
      } finally {
        setWorking(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeId]);

  const createSite = async (e: React.FormEvent) => {
    e.preventDefault();
    setWorking(true);
    try {
      const s = await sitesApi.create(domain.trim());
      setSite(s);
      setStep(2);
    } catch (err) {
      report(err);
    } finally {
      setWorking(false);
    }
  };

  const getInstructions = async () => {
    if (!site) return;
    setWorking(true);
    try {
      const res = await sitesApi.verify(site.id, verifyMethod);
      setVerifyResult(res);
      if (res.verified) {
        const fresh = await sitesApi.get(site.id);
        setSite(fresh);
      }
    } catch (err) {
      report(err);
    } finally {
      setWorking(false);
    }
  };

  const checkVerification = async () => {
    // Re-submit the same method: the API re-checks the token's presence.
    await getInstructions();
  };

  const connectGsc = async () => {
    if (!site) return;
    try {
      const { url } = await sitesApi.gscAuthUrl(site.id);
      setGscUrl(url);
    } catch (err) {
      report(err);
    }
  };

  const runFirstAudit = async () => {
    if (!site) return;
    setWorking(true);
    try {
      await auditsApi.start(site.id);
      // Land on the Audit tab (it polls for progress) instead of the static overview.
      router.push(`/dashboard/sites/${site.id}/audit`);
    } catch (err) {
      report(err);
    } finally {
      setWorking(false);
    }
  };

  const finish = () => {
    if (site) router.push(`/dashboard/sites/${site.id}`);
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <p className="bx-micro mb-1">~/ onboarding</p>
        <h1 className="bx-h1">Add a site</h1>
      </div>

      <ol className="flex items-center gap-2 text-sm">
        {(['1. Domain', '2. Verify', '3. Connect'] as const).map((label, i) => {
          const n = (i + 1) as Step;
          return (
            <li
              key={label}
              className={`flex-1 rounded-lg border px-3 py-2 text-center font-mono text-xs font-medium tracking-wide ${
                step === n
                  ? 'border-teal-400/40 bg-teal-400/10 text-teal-200'
                  : step > n
                    ? 'border-white/10 bg-white/[0.02] text-white/50'
                    : 'border-white/10 text-white/55'
              }`}
            >
              {label}
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <div className="bx-card">
          <h2 className="mb-2 text-base font-semibold text-white">Enter your domain</h2>
          <form onSubmit={createSite} className="flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              required
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="example.com"
              className="bx-input font-mono"
            />
            <button type="submit" disabled={working} className="bx-btn-primary shrink-0">
              {working ? 'Adding…' : 'Continue'}
            </button>
          </form>
        </div>
      )}

      {step === 2 && site && (
        <div className="bx-card">
          <h2 className="mb-2 text-base font-semibold text-white">
            Verify ownership of <span className="font-mono text-teal-300">{site.domain}</span>
          </h2>
          {site.verified ? (
            <div className="space-y-3">
              <p className="bx-alert-ok">✓ This site is verified.</p>
              <button onClick={() => setStep(3)} className="bx-btn-primary">
                Continue
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex gap-2">
                {(['meta', 'file', 'dns'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setVerifyMethod(m);
                      setVerifyResult(null);
                    }}
                    className={`rounded-lg border px-4 py-2 text-sm font-medium transition ${
                      verifyMethod === m
                        ? 'border-teal-400/40 bg-teal-400/10 text-teal-200'
                        : 'border-white/10 text-white/50 hover:bg-white/5'
                    }`}
                  >
                    {m === 'meta' ? 'Meta tag' : m === 'file' ? 'HTML file' : 'DNS record'}
                  </button>
                ))}
              </div>
              <button
                onClick={getInstructions}
                disabled={working}
                className="bx-btn-secondary"
              >
                {working ? 'Working…' : 'Get verification instructions'}
              </button>
              {verifyResult && (
                <div className="bx-panel space-y-3 text-sm">
                  {verifyResult.token && (
                    <p className="break-all text-white/80">
                      <strong className="text-white">Token:</strong>{' '}
                      <code className="rounded border border-white/10 bg-[#04090c] px-1.5 py-0.5 font-mono text-xs text-teal-300">
                        {verifyResult.token}
                      </code>
                    </p>
                  )}
                  <p className="whitespace-pre-wrap text-white/60">
                    {verifyResult.instructions}
                  </p>
                  <button
                    onClick={checkVerification}
                    disabled={working}
                    className="bx-btn-primary"
                  >
                    {working ? 'Checking…' : 'Check verification'}
                  </button>
                </div>
              )}
              <button
                onClick={() => setStep(3)}
                className="text-sm font-medium text-white/55 hover:text-white/70 hover:underline"
              >
                Skip for now →
              </button>
            </div>
          )}
        </div>
      )}

      {step === 3 && site && (
        <div className="bx-card">
          <h2 className="mb-4 text-base font-semibold text-white">
            Connect data sources & run your first audit
          </h2>
          <div className="space-y-4">
            <div className="bx-panel">
              <p className="text-sm font-medium text-white">Google Search Console</p>
              <p className="mt-1 text-xs text-white/55">
                Brings in real click/impression data and backlink info for your site.
              </p>
              {gscUrl ? (
                <a href={gscUrl} className="bx-btn-primary mt-3 inline-flex">
                  Authorize with Google →
                </a>
              ) : (
                <button onClick={connectGsc} className="bx-btn-secondary mt-3">
                  Get Google connect link
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                onClick={runFirstAudit}
                disabled={working}
                className="bx-btn-primary"
              >
                {working ? 'Starting…' : 'Run first audit'}
              </button>
              <button onClick={finish} className="bx-btn-secondary">
                Skip to dashboard
              </button>
            </div>
            <Link href="/dashboard" className="block text-sm text-white/55 hover:text-white/70 hover:underline">
              ← Back to sites
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export default function NewSitePage() {
  return (
    <Suspense fallback={<p className="font-mono text-sm text-white/55">$ loading…</p>}>
      <NewSiteForm />
    </Suspense>
  );
}
