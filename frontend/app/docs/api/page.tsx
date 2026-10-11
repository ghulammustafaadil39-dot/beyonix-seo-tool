import type { Metadata } from 'next';
import MarketingHeader from '@/components/MarketingHeader';
import Footer from '@/components/Footer';

export const metadata: Metadata = {
  title: 'API documentation',
  description: 'Beyonix SEO public API: authentication, scopes, rate limits, endpoints, and webhooks.',
  alternates: { canonical: '/docs/api' },
};

const ENDPOINTS: Array<{ method: string; path: string; desc: string; scope: string }> = [
  { method: 'GET', path: '/api/v1/sites', desc: 'List your sites', scope: 'sites:read' },
  { method: 'GET', path: '/api/v1/sites/:id/overview', desc: 'Site health overview', scope: 'sites:read' },
  { method: 'GET', path: '/api/v1/sites/:id/audits', desc: 'List audits', scope: 'audits:read' },
  { method: 'GET', path: '/api/v1/audits/:id/issues', desc: 'Audit issues', scope: 'audits:read' },
  { method: 'GET', path: '/api/v1/sites/:id/keywords', desc: 'List keywords', scope: 'keywords:read' },
  { method: 'GET', path: '/api/v1/sites/:id/ranks', desc: 'Latest rank positions', scope: 'ranks:read' },
  { method: 'GET', path: '/api/v1/sites/:id/content', desc: 'List content pieces', scope: 'content:read' },
  { method: 'POST', path: '/api/v1/sites/:id/content', desc: 'Create a content draft', scope: 'content:write' },
  { method: 'GET', path: '/api/v1/sites/:id/reports', desc: 'List reports', scope: 'reports:read' },
];

const WEBHOOKS = [
  { event: 'audit.completed', desc: 'An audit finished — includes the new health score.' },
  { event: 'rank.changed', desc: 'A tracked keyword moved significantly.' },
  { event: 'report.ready', desc: 'A scheduled or manual report was generated.' },
  { event: 'limit.near', desc: 'A plan usage limit hit 80% or 100%.' },
  { event: 'invoice.paid', desc: 'An invoice was paid.' },
  { event: 'invoice.payment_failed', desc: 'An invoice payment failed.' },
  { event: 'subscription.updated', desc: 'A subscription changed (plan, status, renewal).' },
  { event: 'site.down', desc: 'A site was unreachable during a crawl.' },
  { event: 'issue.critical', desc: 'A crawl found a critical issue.' },
];

function Code({ children }: { children: string }) {
  return (
    <code className="block overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs leading-relaxed text-teal-200">
      {children}
    </code>
  );
}

/**
 * F-13 — public API docs page. The machine-readable OpenAPI 3.1 spec is
 * the source of truth and is served live by the backend at
 * GET /api/v1/openapi.json (linked below); this page is the
 * human-readable companion and a summary — not a hand-maintained copy.
 */
export default function ApiDocsPage() {
  return (
    <div className="min-h-screen bg-[#04090c] text-white">
      <MarketingHeader />
      <main className="mx-auto max-w-3xl px-4 py-16">
        <p className="bx-micro mb-3">~/ developers</p>
        <h1 className="text-4xl font-extrabold tracking-tight">API documentation</h1>
        <p className="mt-4 text-white/60">
          Pull your SEO data into Looker Studio, Google Sheets, Zapier/Make, or
          your own stack. REST + JSON, versioned under <code className="font-mono text-sm">/api/v1</code>.
        </p>

        <section className="mt-10">
          <h2 className="text-xl font-bold text-white">OpenAPI spec</h2>
          <p className="mt-3 text-sm leading-relaxed text-white/65">
            The complete, generated OpenAPI 3.1 specification is the source of
            truth for every endpoint, schema, and scope:
          </p>
          <div className="mt-3">
            <Code>{`GET /api/v1/openapi.json`}</Code>
          </div>
          <p className="mt-3 text-sm">
            <a href="/api/v1/openapi.json" className="bx-link">
              Download openapi.json ↗
            </a>{' '}
            <span className="text-white/40">
              — import it into Postman, Insomnia, or your client generator.
            </span>
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-bold text-white">Authentication</h2>
          <p className="mt-3 text-sm leading-relaxed text-white/65">
            Create a key in <span className="font-mono text-xs">Dashboard → API keys</span> and send it
            either as a Bearer token or in the <code className="font-mono text-xs">x-api-key</code> header.
            Keys are scoped — a key can only call what its scopes allow, and a{' '}
            <code className="font-mono text-xs">:write</code> scope also covers the matching{' '}
            <code className="font-mono text-xs">:read</code>. A key that lacks a scope gets{' '}
            <code className="font-mono text-xs">403 INSUFFICIENT_SCOPE</code> with the missing scopes listed.
          </p>
          <div className="mt-3">
            <Code>{`curl -H "Authorization: Bearer bseo_..." \\
  https://app.beyonixseo.com/api/v1/sites

# or equivalently:
curl -H "x-api-key: bseo_..." \\
  https://app.beyonixseo.com/api/v1/sites`}</Code>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-bold text-white">Rate limits</h2>
          <p className="mt-3 text-sm leading-relaxed text-white/65">
            Limits are per tenant per minute. Exceeding them returns <code className="font-mono text-xs">429</code> with
            a <code className="font-mono text-xs">Retry-After</code> header — back off and retry.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-bold text-white">Endpoints (summary)</h2>
          <p className="mt-3 text-sm leading-relaxed text-white/65">
            A short summary — the full list lives in the{' '}
            <a href="/api/v1/openapi.json" className="bx-link">OpenAPI spec</a>.
          </p>
          <div className="mt-4 space-y-2">
            {ENDPOINTS.map((e) => (
              <div key={e.path + e.method} className="bx-panel">
                <p className="font-mono text-sm">
                  <span className={`mr-2 inline-block w-12 font-bold ${e.method === 'GET' ? 'text-teal-300' : 'text-amber-300'}`}>
                    {e.method}
                  </span>
                  <span className="text-white/90">{e.path}</span>
                </p>
                <p className="mt-1 text-xs text-white/55">
                  {e.desc} · scope <code className="font-mono text-teal-300/80">{e.scope}</code>
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-bold text-white">Webhooks</h2>
          <p className="mt-3 text-sm leading-relaxed text-white/65">
            Register a URL in <span className="font-mono text-xs">Dashboard → Notifications</span> to
            receive signed event deliveries (header{' '}
            <code className="font-mono text-xs">X-BSEO-Signature: sha256=…</code>) with automatic
            retries and manual replay.
          </p>
          <div className="mt-4 space-y-2">
            {WEBHOOKS.map((w) => (
              <div key={w.event} className="bx-panel">
                <p className="font-mono text-sm text-teal-300">{w.event}</p>
                <p className="mt-1 text-xs text-white/55">{w.desc}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-xl font-bold text-white">Errors</h2>
          <p className="mt-3 text-sm leading-relaxed text-white/65">
            All errors use a consistent envelope. Plan-limit errors return <code className="font-mono text-xs">402</code> with
            upgrade guidance.
          </p>
          <div className="mt-3">
            <Code>{`{ "error": {
  "code": "LIMIT_EXCEEDED",
  "message": "AI words limit reached",
  "upgrade": true, "used": 5000, "limit": 5000
} }`}</Code>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
