// W-05 i18n scaffold — English (complete for app chrome).
//
// Scope (LA-approved): app chrome strings only (nav, tabs, common actions).
// Feature copy inside panels stays English-for-now; per-locale files can
// grow key by key. Additional locales register in lib/i18n/index.tsx as
// Partial<Messages> (ur/ar stubs ship with the same key space and RTL flag).
export const en = {
  // ——— nav ———
  'nav.sites': 'Sites',
  'nav.team': 'Team',
  'nav.apiKeys': 'API keys',
  'nav.notifications': 'Notifications',
  'nav.billing': 'Billing',
  'nav.settings': 'Settings',
  'nav.admin': 'Admin',
  'nav.logOut': 'Log out',
  'nav.openMenu': 'Open menu',
  'nav.closeMenu': 'Close menu',
  // ——— site tabs ———
  'tabs.overview': 'Overview',
  'tabs.audit': 'Audit',
  'tabs.keywords': 'Keywords',
  'tabs.rankings': 'Rankings',
  'tabs.content': 'Content',
  'tabs.onpage': 'On-page',
  'tabs.backlinks': 'Backlinks',
  'tabs.geo': 'GEO',
  'tabs.competitors': 'Competitors',
  'tabs.reports': 'Reports',
  'tabs.insights': 'Insights',
  // ——— common actions ———
  'actions.save': 'Save',
  'actions.saving': 'Saving…',
  'actions.saved': 'Saved',
  'actions.cancel': 'Cancel',
  'actions.delete': 'Delete',
  'actions.remove': 'Remove',
  'actions.retry': 'Retry',
  'actions.dismiss': 'Dismiss',
  'actions.close': 'Close',
  'actions.loading': 'Loading…',
  'actions.viewAll': 'View all',
  'actions.track': 'Track',
  'actions.untrack': 'Untrack',
  'actions.copy': 'Copy',
  'actions.copied': 'Copied',
  // ——— chrome ———
  'chrome.commandPalette': 'Command palette',
  'chrome.searchPlaceholder': 'Type a page, site, or action…',
  'chrome.keyboardShortcuts': 'Keyboard shortcuts',
  'chrome.noResults': 'No matches — try different words.',
  'chrome.sectionPages': 'Pages',
  'chrome.sectionSites': 'Sites',
  'chrome.sectionActions': 'Actions',
  'chrome.openShortcutsHint': 'Press ? to see all shortcuts',
} as const;

export type Messages = typeof en;
export type MessageKey = keyof Messages;
