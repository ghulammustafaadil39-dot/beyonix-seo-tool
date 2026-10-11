// W-05 i18n scaffold — minimal in-repo layer (no next-intl dependency).
//
// Coverage: app chrome only (nav, tabs, common actions) — en complete;
// ur/ar registered as RTL-ready stubs (untranslated, honest by design).
// Feature copy stays English until Mustafa asks for a locale to be filled.
//
// Usage: wrap a subtree in <I18nProvider locale="en">, then
//   const { t } = useT(); t('nav.sites')
'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { en, type MessageKey, type Messages } from './locales/en';
import { ur, urDir } from './locales/ur';
import { ar, arDir } from './locales/ar';

export type Locale = 'en' | 'ur' | 'ar';
export type { MessageKey, Messages } from './locales/en';

const REGISTRY: Record<Locale, { messages: Partial<Messages>; dir: 'ltr' | 'rtl' }> = {
  en: { messages: en, dir: 'ltr' },
  ur: { messages: ur, dir: urDir },
  ar: { messages: ar, dir: arDir },
};

function translate(messages: Partial<Messages>, key: MessageKey): string {
  return messages[key] ?? en[key] ?? key;
}

const I18nCtx = createContext<{ locale: Locale; dir: 'ltr' | 'rtl'; t: (key: MessageKey) => string }>({
  locale: 'en',
  dir: 'ltr',
  t: (key) => en[key] ?? key,
});

export function I18nProvider({
  locale: initial = 'en',
  children,
}: {
  locale?: Locale;
  children: React.ReactNode;
}) {
  const [locale, setLocale] = useState<Locale>(initial);
  const entry = REGISTRY[locale];

  useEffect(() => {
    setLocale(initial);
  }, [initial]);

  useEffect(() => {
    // RTL readiness: document direction follows the active locale.
    document.documentElement.lang = locale;
    document.documentElement.dir = entry.dir;
  }, [locale, entry.dir]);

  const value = useMemo(
    () => ({
      locale,
      dir: entry.dir,
      t: (key: MessageKey) => translate(entry.messages, key),
      setLocale,
    }),
    [locale, entry],
  );

  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useT() {
  return useContext(I18nCtx);
}
