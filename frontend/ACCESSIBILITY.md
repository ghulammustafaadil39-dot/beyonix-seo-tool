# Accessibility — WCAG 2.2 AA (W-05)

Machine-verified via `npm run a11y` (node scripts/a11y.mjs):
- **Contrast**: all brand text/background pairs computed ≥ 4.5:1.
  During this pass `text-white/40` (3.73:1) and `text-white/30` (2.57:1)
  FAILED — elevated to `text-white/55` (6.25:1) and `text-white/50` (5.33:1)
  across the app. Teal/cyan on near-black all ≥ 10:1.
- **Static scan**: every icon-only button has an accessible name, every
  `<img>` has alt, every `<select>` has an accessible name
  (aria-label or htmlFor-paired label).
- **axe-core 4.14.0 installed and importable — but NOT executed**: axe needs
  a rendered DOM (real browser or jsdom). No browser is available in this
  environment, so axe's ruleset could not run. The checklist below must be
  done by hand (or in CI with a browser) before claiming full AA.

## Implemented (code)

- Global `:focus-visible` outline (2px teal, 2px offset) — 2.4.7 Focus Visible.
- `prefers-reduced-motion` kills the skeleton shimmer and all transitions — 2.3.3.
- Skip-to-main-content link on the dashboard shell.
- Modal: focus trap, Escape closes, backdrop click closes, focus restored to
  trigger, `role="dialog"` + `aria-modal` — 2.1.1 / 2.4.3.
- Command palette: ARIA combobox + listbox, `aria-activedescendant`,
  ↑↓/Home/End/Enter/Esc, focus lands in the input on open — 2.1.1 / 4.1.2.
- Job progress: `role="progressbar"` with `aria-valuenow`, polite live
  region for step labels — 4.1.3.
- Skeletons carry `role="status"` + `aria-label`, inner shapes `aria-hidden`.
- TabNav: `aria-label="Site sections"`, `aria-current="page"`.
- Breadcrumbs: `aria-label="Breadcrumb"`, current page marked.
- Shortcuts are inert inside form fields (except ⌘K) — 2.1.4 Character Key
  Shortcuts (single-key `?` only fires when not typing).

## Manual checklist (NOT machine-verified here — needs a browser)

- [ ] Full keyboard walk: every page, menu (mobile hamburger), modal,
      palette, shortcuts modal — no focus traps except dialogs, visible
      focus everywhere, logical order.
- [ ] Screen-reader pass (NVDA/VoiceOver): palette options announced,
      progress bar value announced, skeleton regions silent-or-labelled,
      tables have sensible reading order.
- [ ] 200% zoom: layouts don't overlap; tables scroll horizontally.
- [ ] axe DevTools / Lighthouse accessibility run on: dashboard, site
      overview, audit tab (running + done), insights tab, billing, login.
- [ ] Color is never the only signal: status pills pair color with text —
      spot-check in the UI.
- [ ] Contrast of text over the primary gradient button verified visually
      (computed 12.59:1 for the ink-on-cyan pair).
- [ ] RTL smoke: set locale to `ur`/`ar` in I18nProvider — chrome should
      flip direction (content still English until translated).
