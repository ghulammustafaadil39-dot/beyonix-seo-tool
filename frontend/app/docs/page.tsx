import type { Metadata } from 'next';
import Link from 'next/link';
import MarketingHeader from '@/components/MarketingHeader';
import Footer from '@/components/Footer';
import { DOC_INDEX } from '@/lib/docs';

export const metadata: Metadata = {
  title: 'Docs & help center',
  description: 'Guides for using Beyonix SEO: getting started, Google connections, keyword research, GEO, and how scores are computed.',
};

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-[#04090c] text-white">
      <MarketingHeader />
      <main className="mx-auto max-w-6xl px-4 py-16">
        <p className="bx-micro mb-3 text-center">~/ docs</p>
        <h1 className="text-center text-4xl font-extrabold tracking-tight">
          Help center
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-center text-white/60">
          Guides and references for every part of Beyonix SEO — written in
          plain language.
        </p>
        <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {DOC_INDEX.map((d, i) => (
            <Link key={d.slug} href={`/docs/${d.slug}`} className="bx-card group transition hover:border-teal-400/30">
              <p className="bx-micro mb-3">0{i + 1}</p>
              <h2 className="text-base font-semibold text-white group-hover:text-teal-300">
                {d.title}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-white/60">{d.description}</p>
              <p className="mt-4 text-sm font-medium text-teal-300">Read guide →</p>
            </Link>
          ))}
        </div>
      </main>
      <Footer />
    </div>
  );
}
