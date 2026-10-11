'use client';

import Navbar from '@/components/Navbar';
import DashboardChrome from '@/components/DashboardChrome';
import { ErrorBannerProvider } from '@/components/ErrorBanner';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBannerProvider>
      <div className="min-h-screen bg-[#04090c]">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-teal-400 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-[#04181a]"
        >
          Skip to main content
        </a>
        <Navbar />
        <main id="main-content" className="mx-auto max-w-6xl px-4 py-8">
          <DashboardChrome>{children}</DashboardChrome>
        </main>
      </div>
    </ErrorBannerProvider>
  );
}
