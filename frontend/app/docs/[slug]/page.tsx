import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import MarketingHeader from '@/components/MarketingHeader';
import Footer from '@/components/Footer';
import { DOCS } from '@/lib/docs';

export async function generateStaticParams() {
  return Object.keys(DOCS).map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const doc = DOCS[params.slug];
  if (!doc) return { title: 'Not found' };
  return {
    title: doc.title,
    description: doc.description,
    alternates: { canonical: `/docs/${doc.slug}` },
  };
}

export default function DocArticlePage({ params }: { params: { slug: string } }) {
  const doc = DOCS[params.slug];
  if (!doc) notFound();

  return (
    <div className="min-h-screen bg-[#04090c] text-white">
      <MarketingHeader />
      <main className="mx-auto max-w-3xl px-4 py-16">
        <nav className="font-mono text-sm text-white/40" aria-label="Breadcrumb">
          <Link href="/docs" className="hover:text-white/70 hover:underline">
            Docs
          </Link>
          <span className="mx-2">/</span>
          <span className="text-teal-300">{doc.title}</span>
        </nav>
        <h1 className="mt-4 text-3xl font-extrabold tracking-tight">{doc.title}</h1>
        <p className="mt-2 font-mono text-xs text-white/40">
          last updated {doc.updated}
        </p>
        <article className="mt-8 space-y-8">
          {doc.sections.map((s) => (
            <section key={s.heading}>
              <h2 className="text-lg font-bold text-white">{s.heading}</h2>
              <div className="mt-3 space-y-3">
                {s.body.map((p, i) => (
                  <p key={i} className="text-sm leading-relaxed text-white/65">
                    {p}
                  </p>
                ))}
              </div>
            </section>
          ))}
        </article>
        <div className="mt-12 border-t border-white/10 pt-6">
          <Link href="/docs" className="bx-link text-sm">
            ← Back to all docs
          </Link>
        </div>
      </main>
      <Footer />
    </div>
  );
}
