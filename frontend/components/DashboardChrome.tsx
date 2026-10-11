// W-05: dashboard UX chrome — mounts the command palette (⌘K), the
// shortcuts modal (?), and the global keyboard handler, all in the
// dashboard subtree (auth pages and marketing pages stay untouched).
// Also mounts the i18n provider for the chrome strings.
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import CommandPalette from './CommandPalette';
import ShortcutsModal from './ShortcutsModal';
import { I18nProvider } from '@/lib/i18n';

function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return (
    el.isContentEditable ||
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select'
  );
}

const GO_TARGETS: Record<string, string> = {
  d: '/dashboard',
  t: '/dashboard/team',
  a: '/dashboard/api-keys',
  n: '/dashboard/notifications',
  b: '/dashboard/billing',
  s: '/dashboard/settings',
  c: '/dashboard/sites/new',
};

export default function DashboardChrome({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const gPressedAt = useRef(0);

  const togglePalette = useCallback(() => setPaletteOpen((v) => !v), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K always toggles the palette, even mid-typing.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        togglePalette();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e)) return;

      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      // g-sequence: 'g' then a letter within 900 ms.
      const now = Date.now();
      if (e.key.toLowerCase() === 'g') {
        gPressedAt.current = now;
        return;
      }
      if (now - gPressedAt.current < 900) {
        const target = GO_TARGETS[e.key.toLowerCase()];
        if (target) {
          e.preventDefault();
          gPressedAt.current = 0;
          router.push(target);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [router, togglePalette]);

  // Palette trigger button: Navbar dispatches this event (it lives outside
  // this subtree, so it can't receive the setter directly).
  useEffect(() => {
    const open = () => setPaletteOpen(true);
    window.addEventListener('beyonix:open-palette', open);
    return () => window.removeEventListener('beyonix:open-palette', open);
  }, []);

  return (
    <I18nProvider locale="en">
      {children}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
      />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </I18nProvider>
  );
}
