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
  { event: 'limit.reached', desc: 'A plan usage limit hit 80% or 100%.' },
];

function Code({ children }: { children: string }) {
  return (
    <code className="block overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs leading-relaxed text-teal-200">
      {children}
    </code>
  );
}

/**
 * F-13 — public API docs page (OpenAPI served at /api/v1/openapi.json
 * by the backend; this page is the human-readable companion).
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
          <h2 className="text-xl font-bold text-white">Authentication</h2>
          <p className="mt-3 text-sm leading-relaxed text-white/65">
            Create a key in <span className="font-mono text-xs">Dashboard → API keys</span> and send it
            as a Bearer token. Keys are scoped — a key can only call what its scopes allow.
          </p>
          <div className="mt-3">
            <Code>{`curl -H "Authorization: Bearer bseo_sk_..." \\
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
          <h2 className="text-xl font-bold text-white">Endpoints</h2>
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
            receive signed event deliveries with automatic retries.
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
            <Code>{`{ "ok": false, "error": {
  "code": "LIMIT_REACHED",
  "message": "AI words limit reached",
  "requestId": "req_abc123",
  "upgrade": true, "used": 5000, "limit": 5000
} }`}</Code>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
