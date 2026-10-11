'use client';

import { useMemo } from 'react';
import { encodeQr } from '@/lib/qr';

/**
 * Renders `text` as a QR code SVG using the dependency-free encoder in
 * lib/qr.ts (byte mode, ECC level M). Dark modules on white — scanners
 * need the contrast, so the tile is always light even in dark mode.
 */
export default function QrCode({ text, size = 192 }: { text: string; size?: number }) {
  const { path, dimension } = useMemo(() => {
    const { modules, size: n } = encodeQr(text);
    const quiet = 4;
    const dim = n + quiet * 2;
    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (modules[r][c]) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    return { path: d, dimension: dim };
  }, [text]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${dimension} ${dimension}`}
      role="img"
      aria-label="Two-factor authentication QR code"
      className="rounded-xl bg-white p-3 shadow-[0_0_32px_rgba(45,212,191,0.15)]"
    >
      <rect width={dimension} height={dimension} fill="#ffffff" />
      <path d={path} fill="#0b1518" />
    </svg>
  );
}
