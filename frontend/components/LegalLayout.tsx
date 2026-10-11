import MarketingHeader from '@/components/MarketingHeader';
import Footer from '@/components/Footer';

/** Shared legal-page layout. */
export function LegalLayout({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#04090c] text-white">
      <MarketingHeader />
      <main className="mx-auto max-w-3xl px-4 py-16">
        <p className="bx-micro mb-3">~/ legal</p>
        <h1 className="text-3xl font-extrabold tracking-tight">{title}</h1>
        <p className="mt-2 font-mono text-xs text-white/40">last updated {updated}</p>
        <article className="mt-8 space-y-6">{children}</article>
      </main>
      <Footer />
    </div>
  );
}

export function LegalSection({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-bold text-white">{heading}</h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-white/65">{children}</div>
    </section>
  );
}
