import Link from 'next/link';

const FEATURES = [
  {
    title: 'Site audits & on-page fixes',
    body: 'A real crawler checks every page for technical issues — missing meta tags, broken links, slow pages — and tells you exactly how to fix each one.',
  },
  {
    title: 'Keywords & rank tracking',
    body: 'Discover keywords with real search volume, difficulty, and intent scoring, then watch your Google positions move with weekly rank checks.',
  },
  {
    title: 'AI content + GEO visibility',
    body: 'Generate SEO-ready article drafts, and track whether AI assistants like ChatGPT and Gemini mention your brand in their answers.',
  },
];

const STEPS = [
  {
    n: '01',
    title: 'Connect your site',
    body: 'Add your domain, verify ownership, and optionally connect Google Search Console.',
  },
  {
    n: '02',
    title: 'Run the audit',
    body: 'One click crawls your site and scores its health — issues come with plain-English fixes.',
  },
  {
    n: '03',
    title: 'Grow every week',
    body: 'Track keywords, publish AI-drafted content, and get a weekly report of what improved.',
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-[#04090c] text-white">
      <header className="border-b border-white/10 bg-[#04090c]/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <span className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-cyan-300 to-teal-400 text-lg font-bold text-[#04181a] shadow-[0_0_24px_rgba(45,212,191,0.45)]">
              B
            </span>
            <span className="text-lg font-bold tracking-tight">
              Beyonix <span className="text-teal-300">SEO</span>
            </span>
          </span>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm font-medium text-white/60 transition hover:text-white"
            >
              Log in
            </Link>
            <Link href="/signup" className="bx-btn-primary">
              Start free
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="bx-glow">
          <div className="relative mx-auto max-w-6xl px-4 py-24 text-center">
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
              Audits, keywords, rank tracking, AI-written content, and visibility tracking
              across ChatGPT, Gemini, and Claude — one simple dashboard, no agency needed.
            </p>
            <div className="mt-9 flex items-center justify-center gap-4">
              <Link href="/signup" className="bx-btn-primary px-7 py-3 text-base">
                Start free
              </Link>
              <Link href="/login" className="bx-btn-secondary px-7 py-3 text-base">
                Log in
              </Link>
            </div>
            <p className="mt-5 font-mono text-xs text-white/30">
              $ ./beyonix-seo --init <span className="text-teal-300/70">▊</span>
            </p>
          </div>
        </section>

        <section className="border-t border-white/5 py-20">
          <div className="mx-auto max-w-6xl px-4">
            <p className="bx-micro mb-3 text-center">~/ capabilities</p>
            <h2 className="text-center text-3xl font-bold tracking-tight">
              Everything a small business needs for SEO
            </h2>
            <div className="mt-10 grid gap-5 md:grid-cols-3">
              {FEATURES.map((f, i) => (
                <div key={f.title} className="bx-card bx-glow">
                  <p className="bx-micro mb-3">0{i + 1}</p>
                  <h3 className="text-base font-semibold text-white">{f.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/60">{f.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-white/5 py-20">
          <div className="mx-auto max-w-6xl px-4">
            <p className="bx-micro mb-3 text-center">~/ protocol</p>
            <h2 className="text-center text-3xl font-bold tracking-tight">How it works</h2>
            <div className="mt-10 grid gap-5 md:grid-cols-3">
              {STEPS.map((s) => (
                <div key={s.n} className="bx-card text-center">
                  <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-teal-400/30 bg-teal-400/10 font-mono text-sm font-bold text-teal-300">
                    {s.n}
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-white">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/60">{s.body}</p>
                </div>
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

      <footer className="border-t border-white/10 py-8">
        <p className="text-center font-mono text-xs text-white/30">
          © 2026 Beyonix Solutions — Beyonix SEO
        </p>
      </footer>
    </div>
  );
}
