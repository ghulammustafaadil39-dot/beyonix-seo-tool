import type { Metadata } from 'next';
import Link from 'next/link';
import MarketingHeader from '@/components/MarketingHeader';
import Footer from '@/components/Footer';

export const metadata: Metadata = {
  title: 'Get found on Google and in AI answers',
  description:
    'Beyonix SEO: site audits, keyword research, rank tracking, AI content, and GEO visibility across ChatGPT, Gemini and Claude — one simple dashboard for small businesses.',
  alternates: { canonical: '/' },
};

const FEATURES = [
  {
    tag: '01 / audit',
    title: 'Site audits that explain themselves',
    body: 'A real crawler checks every page — missing meta tags, broken links, slow pages, thin content — then tells you in plain language exactly how to fix each issue, ordered by impact.',
  },
  {
    tag: '02 / keywords',
    title: 'Keywords with real search volume',
    body: 'Research keywords with volume, difficulty, and intent scoring. Cluster them by topic, track their Google positions weekly, and spot cannibalization before it costs you traffic.',
  },
  {
    tag: '03 / content',
    title: 'AI content, brief → publish',
    body: 'Turn a keyword into a brief, an outline, and a full SEO-ready draft with NLP term coverage, internal-link suggestions, and meta/schema generation — ready to export to WordPress.',
  },
  {
    tag: '04 / geo',
    title: 'GEO: be cited by AI assistants',
    body: 'Track whether ChatGPT, Perplexity, Gemini, and Claude mention your brand in their answers. Get concrete recommendations — llms.txt, schema, entity pages — to win AI citations.',
  },
  {
    tag: '05 / links',
    title: 'Backlinks without the mystery',
    body: 'See new and lost links, anchor distribution, and toxicity flags. Find link-building opportunities and generate a disavow file when you need one.',
  },
  {
    tag: '06 / reports',
    title: 'Reports clients actually read',
    body: 'White-label PDF and HTML reports with your logo and colors, an executive summary in plain language, period-over-period comparisons, and scheduled email delivery.',
  },
];

const FLOW = [
  {
    n: '01',
    title: 'Connect your site',
    body: 'Add your domain, verify ownership in minutes, and optionally connect Google Search Console and Analytics.',
  },
  {
    n: '02',
    title: 'Run the audit',
    body: 'One click crawls your site and scores its health. Issues come with plain-English fixes, prioritized by impact.',
  },
  {
    n: '03',
    title: 'Grow every week',
    body: 'Track keywords, publish AI-drafted content, monitor AI citations — and get a weekly "do this next" report.',
  },
];

const FAQ = [
  {
    q: 'Do I need an agency to use this?',
    a: 'No. Beyonix SEO is built for small businesses: every issue explains itself in plain language, and the weekly report tells you exactly what to do next.',
  },
  {
    q: 'Where does the data come from?',
    a: 'Your own site (crawled directly), Google Search Console and Analytics (which you connect), and licensed SERP/AI-visibility data providers. Nothing is scraped blindly.',
  },
  {
    q: 'What is GEO?',
    a: 'Generative Engine Optimization — making sure AI assistants like ChatGPT, Gemini, and Claude mention and cite your business in their answers. We track mentions, citations, and sentiment across engines and tell you how to improve.',
  },
  {
    q: 'Can I cancel anytime?',
    a: 'Yes. Plans are month-to-month or annual; cancel from your billing page in two clicks. Your data stays exportable.',
  },
  {
    q: 'Is there a free trial?',
    a: 'Yes — every new account starts with a 14-day free trial, no credit card required, with full Starter access. Subscribe before it ends to keep your access.',
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-[#04090c] text-white">
      <MarketingHeader />

      <main>
        {/* ——— Hero ——— */}
        <section className="bx-glow">
          <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-20 text-center sm:pt-24">
            <p className="bx-micro mb-5 inline-block rounded-full border border-teal-400/20 bg-teal-400/10 px-4 py-1.5">
              ~/ SEO + GEO for small businesses
            </p>
            <h1 className="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight sm:text-6xl">
              Get found on Google{' '}
              <span className="bg-gradient-to-r from-cyan-300 to-teal-400 bg-clip-text text-transparent">
                and
              </span>{' '}
              in AI answers
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-white/60">
              Audits, keywords, rank tracking, AI-written content, and visibility
              tracking across ChatGPT, Gemini, and Claude — one simple dashboard,
              no agency needed.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <Link href="/signup" className="bx-btn-primary px-7 py-3 text-base">
                Start free trial
              </Link>
              <Link href="/pricing" className="bx-btn-secondary px-7 py-3 text-base">
                See pricing
              </Link>
            </div>
            <p className="mt-5 font-mono text-xs text-white/50">
              $ ./beyonix-seo --init <span className="text-teal-300/70">▊</span>
            </p>

            {/* Terminal-style product preview */}
            <div className="mx-auto mt-14 max-w-3xl text-left">
              <div className="overflow-hidden rounded-xl border border-white/10 bg-[#06141d] shadow-2xl">
                <div className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
                  <span className="h-3 w-3 rounded-full bg-red-400/60" />
                  <span className="h-3 w-3 rounded-full bg-amber-400/60" />
                  <span className="h-3 w-3 rounded-full bg-teal-400/60" />
                  <span className="ml-2 font-mono text-xs text-white/55">
                    beyonix-seo — weekly health report
                  </span>
                </div>
                <div className="space-y-2.5 p-5 font-mono text-sm">
                  <p className="text-white/60">
                    $ audit <span className="text-teal-300">example.com</span> …
                    done in 47s — <span className="text-teal-300">score 87/100</span> (+4)
                  </p>
                  <p className="text-white/60">
                    $ rank check … <span className="text-teal-300">12 keywords up</span>, 3 down
                  </p>
                  <p className="text-white/60">
                    $ geo … <span className="text-teal-300">cited by ChatGPT</span> for
                    &quot;best invoicing tool for freelancers&quot;
                  </p>
                  <p className="text-white/60">
                    $ next actions … <span className="text-amber-300">3 quick wins</span> queued
                    for review
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ——— Features ——— */}
        <section id="features" className="border-t border-white/5 py-20">
          <div className="mx-auto max-w-6xl px-4">
            <p className="bx-micro mb-3 text-center">~/ capabilities</p>
            <h2 className="mx-auto max-w-2xl text-center text-3xl font-bold tracking-tight">
              Everything a small business needs to win search
            </h2>
            <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((f) => (
                <div key={f.tag} className="bx-card bx-glow">
                  <p className="bx-micro mb-3">{f.tag}</p>
                  <h3 className="text-base font-semibold text-white">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/60">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ——— How it works ——— */}
        <section className="border-t border-white/5 py-20">
          <div className="mx-auto max-w-6xl px-4">
            <p className="bx-micro mb-3 text-center">~/ protocol</p>
            <h2 className="text-center text-3xl font-bold tracking-tight">How it works</h2>
            <div className="mt-10 grid gap-5 md:grid-cols-3">
              {FLOW.map((s) => (
                <div key={s.n} className="bx-card text-center">
                  <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-teal-400/30 bg-teal-400/10 font-mono text-sm font-bold text-teal-300">
                    {s.n}
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-white">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/60">{s.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ——— Pricing teaser ——— */}
        <section className="border-t border-white/5 py-20">
          <div className="mx-auto max-w-6xl px-4 text-center">
            <p className="bx-micro mb-3">~/ pricing</p>
            <h2 className="text-3xl font-bold tracking-tight">
              Simple plans that scale with you
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-white/60">
              Start with a 14-day free trial, upgrade when you grow. Monthly or annual billing,
              cancel anytime, usage limits that are honest about what you get.
            </p>
            <div className="mt-8">
              <Link href="/pricing" className="bx-btn-primary px-8 py-3 text-base">
                Compare plans
              </Link>
            </div>
          </div>
        </section>

        {/* ——— FAQ ——— */}
        <section id="faq" className="border-t border-white/5 py-20">
          <div className="mx-auto max-w-3xl px-4">
            <p className="bx-micro mb-3 text-center">~/ faq</p>
            <h2 className="text-center text-3xl font-bold tracking-tight">
              Questions, answered
            </h2>
            <div className="mt-10 space-y-4">
              {FAQ.map((f) => (
                <details key={f.q} className="bx-card group">
                  <summary className="cursor-pointer list-none text-sm font-semibold text-white marker:hidden [&::-webkit-details-marker]:hidden">
                    <span className="flex items-center justify-between gap-4">
                      {f.q}
                      <span className="font-mono text-teal-300 transition group-open:rotate-45">
                        +
                      </span>
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-white/60">{f.a}</p>
                </details>
              ))}
            </div>
            <div className="mt-12 text-center">
              <Link href="/signup" className="bx-btn-primary px-8 py-3 text-base">
                Create your free account
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
