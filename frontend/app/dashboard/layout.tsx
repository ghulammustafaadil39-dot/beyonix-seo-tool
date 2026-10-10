'use client';

import Navbar from '@/components/Navbar';
import { ErrorBannerProvider } from '@/components/ErrorBanner';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBannerProvider>
      <div className="min-h-screen bg-[#04090c]">
        <Navbar />
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </div>
    </ErrorBannerProvider>
  );
}
