// W-05: global keyboard shortcuts + the shortcuts reference modal.
// '?' opens this modal. All shortcuts are inert while typing in form
// fields (except ⌘K/Ctrl+K, which always toggles the palette).
'use client';

import Modal from './Modal';
import { useT } from '@/lib/i18n';

export interface Shortcut {
  keys: string[];
  label: string;
}

/** The full shortcut contract — DashboardChrome implements every one. */
export const SHORTCUTS: Shortcut[] = [
  { keys: ['⌘', 'K'], label: 'Command palette — jump to any page, site, or action' },
  { keys: ['?'], label: 'Open this shortcuts list' },
  { keys: ['g', 'then', 'd'], label: 'Go to Sites (dashboard)' },
  { keys: ['g', 'then', 't'], label: 'Go to Team' },
  { keys: ['g', 'then', 'a'], label: 'Go to API keys' },
  { keys: ['g', 'then', 'n'], label: 'Go to Notifications' },
  { keys: ['g', 'then', 'b'], label: 'Go to Billing' },
  { keys: ['g', 'then', 's'], label: 'Go to Settings' },
  { keys: ['g', 'then', 'c'], label: 'Add a site' },
  { keys: ['Esc'], label: 'Close dialog / palette' },
];

export default function ShortcutsModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useT();
  if (!open) return null;
  return (
    <Modal title={t('chrome.keyboardShortcuts')} onClose={onClose}>
      <p className="mb-4 text-sm text-white/50">
        Keyboard-first navigation. Shortcuts don&apos;t fire while you&apos;re typing in a field —
        except ⌘K, which always works.
      </p>
      <ul className="space-y-2.5">
        {SHORTCUTS.map((s, i) => (
          <li key={i} className="flex items-center justify-between gap-4">
            <span className="text-sm text-white/70">{s.label}</span>
            <span className="flex shrink-0 gap-1">
              {s.keys.map((k, j) => (
                <kbd
                  key={j}
                  className="rounded-md border border-white/15 bg-white/5 px-2 py-1 font-mono text-xs text-teal-200"
                >
                  {k}
                </kbd>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
