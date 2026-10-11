// W-05: ⌘K command palette — keyboard-first navigation to pages, sites,
// and actions. Fully keyboard operable (↑↓/Enter/Home/End/Esc), ARIA
// combobox+listbox, fuzzy-matched across titles, paths, and keywords.
'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Modal from './Modal';
import { sitesApi, type Site } from '@/lib/api';
import { SITE_TABS } from './TabNav';
import { fuzzyFilter } from '@/lib/fuzzy';
import { useT } from '@/lib/i18n';

interface PaletteItem {
  id: string;
  title: string;
  hint: string;
  keywords: string;
  kind: 'page' | 'site' | 'action';
  run: () => void;
}

const PAGES: Array<{ href: string; label: string; keywords: string }> = [
  { href: '/dashboard', label: 'Sites', keywords: 'home dashboard all sites' },
  { href: '/dashboard/team', label: 'Team', keywords: 'members invite roles workspaces' },
  { href: '/dashboard/api-keys', label: 'API keys', keywords: 'tokens integration developer' },
  { href: '/dashboard/notifications', label: 'Notifications', keywords: 'alerts webhooks rules' },
  { href: '/dashboard/billing', label: 'Billing', keywords: 'subscription plan invoices payment' },
  { href: '/dashboard/settings', label: 'Settings', keywords: 'preferences llm provider notifications email' },
  { href: '/dashboard/sites/new', label: 'Add site', keywords: 'new create site domain add' },
];

export default function CommandPalette({
  open,
  onClose,
  onOpenShortcuts,
}: {
  open: boolean;
  onClose: () => void;
  onOpenShortcuts: () => void;
}) {
  const router = useRouter();
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [sites, setSites] = useState<Site[]>([]);
  const [sitesError, setSitesError] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const go = useCallback(
    (href: string) => {
      onClose();
      router.push(href);
    },
    [onClose, router],
  );

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setSitesError(false);
    (async () => {
      try {
        const res = await sitesApi.list();
        setSites(res.data ?? []);
      } catch {
        setSites([]);
        setSitesError(true);
      }
    })();
    // Focus the input after Modal's focus-trap steals it (Modal focuses its
    // own close button on mount).
    const tId = setTimeout(() => inputRef.current?.focus(), 40);
    return () => clearTimeout(tId);
  }, [open ]);

  const items: PaletteItem[] = useMemo(() => {
    const list: PaletteItem[] = PAGES.map((p) => ({
      id: `page:${p.href}`,
      title: p.label,
      hint: p.href,
      keywords: p.keywords,
      kind: 'page',
      run: () => go(p.href),
    }));
    for (const s of sites) {
      list.push({
        id: `site:${s.id}`,
        title: s.domain,
        hint: `/dashboard/sites/${s.id}`,
        keywords: `site ${s.domain} overview`,
        kind: 'site',
        run: () => go(`/dashboard/sites/${s.id}`),
      });
      for (const tab of SITE_TABS) {
        list.push({
          id: `site:${s.id}:${tab.slug}`,
          title: `${tab.label} — ${s.domain}`,
          hint: `/dashboard/sites/${s.id}/${tab.slug}`,
          keywords: `${tab.slug} ${tab.label} ${s.domain}`,
          kind: 'site',
          run: () => go(`/dashboard/sites/${s.id}/${tab.slug}`),
        });
      }
    }
    list.push({
      id: 'action:shortcuts',
      title: t('chrome.keyboardShortcuts'),
      hint: '?',
      keywords: 'shortcuts keys help keyboard',
      kind: 'action',
      run: () => {
        onClose();
        onOpenShortcuts();
      },
    });
    return list;
  }, [sites, go, onClose, onOpenShortcuts, t]);

  const results = useMemo(
    () => fuzzyFilter(query, items, (i) => `${i.title} ${i.hint} ${i.keywords}`).slice(0, 12),
    [query, items],
  );

  useEffect(() => {
    setActive(0);
  }, [query]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(results.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      results[active]?.run();
    }
  };

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  return (
    <Modal title={t('chrome.commandPalette')} onClose={onClose}>
      <div role="combobox" aria-expanded="true" aria-haspopup="listbox" aria-owns="palette-listbox">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          role="searchbox"
          aria-controls="palette-listbox"
          aria-activedescendant={results[active] ? `palette-opt-${results[active].id}` : undefined}
          aria-label={t('chrome.searchPlaceholder')}
          placeholder={t('chrome.searchPlaceholder')}
          className="bx-input !py-2.5 font-mono"
          autoComplete="off"
          spellCheck={false}
        />
        {sitesError && (
          <p className="mt-2 text-xs text-white/55">
            Couldn't load your sites — pages and actions are still searchable.
          </p>
        )}
        <div
          ref={listRef}
          id="palette-listbox"
          role="listbox"
          aria-label={t('chrome.commandPalette')}
          className="mt-3 max-h-[50vh] space-y-0.5 overflow-y-auto"
        >
          {results.map((item, i) => (
            <button
              key={item.id}
              id={`palette-opt-${item.id}`}
              data-idx={i}
              role="option"
              aria-selected={i === active}
              onClick={() => item.run()}
              onMouseEnter={() => setActive(i)}
              className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left transition ${
                i === active ? 'bg-teal-400/15 text-white' : 'text-white/60 hover:bg-white/5'
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{item.title}</span>
                <span className="block truncate font-mono text-[11px] text-white/50">{item.hint}</span>
              </span>
              <span
                className={`bx-pill shrink-0 ${
                  item.kind === 'site' ? 'bx-pill-ok' : item.kind === 'action' ? 'bx-pill-violet' : 'bx-pill-info'
                }`}
              >
                {item.kind}
              </span>
            </button>
          ))}
          {results.length === 0 && (
            <p role="status" className="px-3 py-6 text-center text-sm text-white/55">
              {t('chrome.noResults')}
            </p>
          )}
        </div>
        <p className="mt-3 font-mono text-[11px] text-white/50">
          ↑↓ navigate · Enter open · Esc close · {t('chrome.openShortcutsHint')}
        </p>
      </div>
    </Modal>
  );
}
