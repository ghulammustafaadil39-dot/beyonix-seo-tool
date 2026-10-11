'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const KEY = 'bseo_cookie_consent_v1';

/**
 * Cookie consent banner (F-12). B3-L2: the product loads NO analytics or
 * tracking scripts, so the old "Accept all" option was theater — nothing
 * optional ever existed. The banner now honestly states essential-only
 * behavior; the stored choice just records the acknowledgement and
 * dismisses the notice.
 */
export default function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!window.localStorage.getItem(KEY)) setVisible(true);
    } catch {
      setVisible(true);
    }
  }, []);

  const choose = () => {
    try {
      window.localStorage.setItem(
        KEY,
        JSON.stringify({ value: 'essential', at: new Date().toISOString() }),
      );
    } catch {
      // storage unavailable — banner just disappears for this session
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-3xl rounded-xl border border-white/10 bg-[#06141d]/95 p-4 shadow-2xl backdrop-blur sm:bottom-6 sm:left-auto sm:right-6 sm:max-w-md"
    >
      <p className="text-sm font-semibold text-white">Cookies</p>
      <p className="mt-1 text-sm text-white/60">
        We use only essential cookies — to keep you logged in and remember
        this choice. No analytics or tracking cookies.{' '}
        <Link href="/legal/privacy" className="bx-link">
          Privacy policy
        </Link>
      </p>
      <div className="mt-3 flex gap-2">
        <button onClick={choose} className="bx-btn-primary !text-xs">
          Got it
        </button>
      </div>
    </div>
  );
}
