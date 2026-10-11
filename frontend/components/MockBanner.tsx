'use client';

/**
 * Mandatory banner wherever sample/mock data is shown because the
 * backing API endpoint has not landed yet. Keeps the honest boundary:
 * nothing fake is ever presented as real.
 */
export default function MockBanner({ label = 'this panel' }: { label?: string }) {
  return (
    <div className="bx-alert-warn flex items-start gap-2" role="status">
      <span aria-hidden="true">⌁</span>
      <p>
        <strong className="font-semibold">Sample data</strong> — {label} shows
        placeholder values while the live API endpoint is being built. Actions
        here don&rsquo;t affect your account.
      </p>
    </div>
  );
}
