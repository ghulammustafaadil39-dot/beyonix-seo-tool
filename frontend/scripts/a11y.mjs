// W-05 WCAG 2.2 AA checks — runs WITHOUT a browser and reports honestly
// what was machine-verified vs what needs a real browser.
//
// Machine-verified here:
//   1. Contrast ratios of the brand color pairs (computed, not eyeballed)
//      against AA thresholds (4.5:1 normal text, 3:1 large text/UI).
//   2. Static scan of all .tsx: buttons without an accessible name,
//      <img> without alt, <select> without aria-label, presence of the
//      global :focus-visible rule and the prefers-reduced-motion guard.
//   3. axe-core is imported and its version reported; running axe's ruleset
//      against a live render REQUIRES a browser/JS-DOM, which this
//      environment does not have — that part is marked NOT RUN, not faked.
//
// Usage: node scripts/a11y.mjs   (exit 1 on any hard failure)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
let failures = 0;
const notes = [];

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

// ---------- 1. contrast ----------
function luminance(hex) {
  const c = hex.replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const lin = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}
function ratio(fg, bg) {
  const [l1, l2] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
}
// bg() resolves Tailwind white/<alpha> over the base color.
function blendOver(fg, alpha, bg) {
  const mix = (a, b) => Math.round(a * alpha + b * (1 - alpha));
  const h = (x) => x.toString(16).padStart(2, '0');
  const f = [0, 2, 4].map((i) => parseInt(fg.slice(i, i + 2), 16));
  const b = [0, 2, 4].map((i) => parseInt(bg.slice(i, i + 2), 16));
  return '#' + f.map((v, i) => h(mix(v, b[i]))).join('');
}

const BG = '04090c'; // --bx-bg near-black
const SURFACE = '06141d'; // --bx-surface
// Blend alpha of white-on-bg for the white/NN utilities actually used as text.
const pairs = [
  ['teal-300 #5eead4 on bg', '5eead4', BG, 4.5],
  ['teal-400 #2dd4bf on bg', '2dd4bf', BG, 4.5],
  ['teal-200 #99f6e4 on surface', '99f6e4', SURFACE, 4.5],
  ['cyan-300 #67e8f9 on bg', '67e8f9', BG, 4.5],
  ['dark ink #04181a on cyan-300 (primary buttons)', BG === '04090c' ? '04181a' : BG, '67e8f9', 4.5],
  ['red-300 #fca5a5 on bg (error text)', 'fca5a5', BG, 4.5],
  ['amber-300 #fcd34d on bg (warning text)', 'fcd34d', BG, 4.5],
  ['sky-200 #bae6fd on bg', 'bae6fd', BG, 4.5],
  ['violet-300 #c4b5fd on bg', 'c4b5fd', BG, 4.5],
  ['white/60 on bg', blendOver('ffffff', 0.6, BG).slice(1), BG, 4.5],
  ['white/50 on bg', blendOver('ffffff', 0.5, BG).slice(1), BG, 4.5],
  ['white/55 on bg (captions)', blendOver('ffffff', 0.55, BG).slice(1), BG, 4.5],
  ['white/50 on bg (timestamps/micro)', blendOver('ffffff', 0.5, BG).slice(1), BG, 4.5],
];

console.log('\n== contrast (computed, AA: 4.5 normal / 3.0 large/UI) ==');
for (const [name, fg, bg, threshold] of pairs) {
  const r = ratio(fg, bg);
  check(name, r >= threshold, `ratio ${r.toFixed(2)}:1 (needs ${threshold}:1)`);
  if (r < threshold) notes.push(`${name}: ${r.toFixed(2)}:1 < ${threshold}:1`);
}

// ---------- 2. static scan ----------
console.log('\n== static component scan ==');
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === 'node_modules' || e === '.next') continue;
      walk(p);
    } else if (p.endsWith('.tsx')) files.push(p);
  }
})(ROOT);

const css = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
check('global :focus-visible outline rule', /:focus-visible\s*\{[^}]*outline/.test(css));
check('prefers-reduced-motion guard', /prefers-reduced-motion/.test(css));
check('sr-only helper present', /bx-sr-only/.test(css));

let badButtons = [];
let badImgs = [];
let badSelects = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  // buttons: flag <button> whose inner content has no text and no aria-label/title.
  // (Reuses the brace-aware scan — attrs may contain '=>' arrows.)
  const btnRe = /<button((?:[^>"']|"[^"]*"|'[^']*'|\{[^}]*\})*)>/g;
  let m;
  while ((m = btnRe.exec(src))) {
    const end = src.indexOf('</button>', m.index);
    const innerHtml = end === -1 ? '' : src.slice(m.index + m[0].length, end);
    const attrs = m[1];
    const innerText = innerHtml
      .replace(/<[^>]+>/g, ' ')
      .replace(/[{}]/g, ' ')
      .trim();
    const hasDynamicText = /\{[\w.]+\}/.test(innerHtml);
    const labelled = /aria-label|aria-labelledby|title=/.test(attrs);
    // Dynamic text ({t.name}) is an accessible name at runtime — not a
    // violation. Only flag truly contentless, unlabelled buttons.
    if (!labelled && !hasDynamicText && innerText.length === 0) badButtons.push(`${relative(ROOT, f)}`);
  }
  const imgRe = /<img([^>]*)\/?>/g;
  while ((m = imgRe.exec(src))) {
    if (!/alt=/.test(m[1])) badImgs.push(relative(ROOT, f));
  }
  const labelledIds = new Set();
  const lblRe = /<label[^>]*htmlFor="([^"]+)"[^>]*>/g;
  while ((m = lblRe.exec(src))) labelledIds.add(m[1]);
  // Brace-aware tag scan: JSX handlers contain '=>' arrows, so a plain
  // regex would end the attribute list at the arrow's '>'.
  function selectAttrs(src) {
    const out = [];
    let i = 0;
    while ((i = src.indexOf('<select', i)) !== -1) {
      let j = i + '<select'.length;
      let depth = 0;
      let inStr = null;
      while (j < src.length) {
        const c = src[j];
        if (inStr) {
          if (c === inStr) inStr = null;
        } else if (c === '"' || c === "'" || c === '\`') {
          inStr = c;
        } else if (c === '{') {
          depth++;
        } else if (c === '}') {
          depth--;
        } else if (c === '>' && depth === 0) {
          out.push(src.slice(i + '<select'.length, j));
          break;
        }
        j++;
      }
      i = j + 1;
    }
    return out;
  }
  for (const attrs of selectAttrs(src)) {
    const idM = /id="([^"]+)"/.exec(attrs);
    const ok = /aria-label|aria-labelledby/.test(attrs) || (idM && labelledIds.has(idM[1]));
    if (!ok) badSelects.push(relative(ROOT, f));
  }
}
check('icon-only buttons all labelled', badButtons.length === 0, badButtons.slice(0, 5).join(', '));
check('all <img> have alt', badImgs.length === 0, badImgs.slice(0, 5).join(', '));
check('all <select> have accessible name', badSelects.length === 0, badSelects.slice(0, 5).join(', '));

// ---------- 3. axe-core ----------
console.log('\n== axe-core ==');
try {
  const axe = await import('axe-core');
  const version = axe.default?.version ?? axe.version ?? 'unknown';
  console.log(`axe-core ${version} installed and importable.`);
  if (typeof document === 'undefined') {
    console.log(
      'NOT RUN: axe ruleset needs a rendered DOM (real browser or jsdom).\n' +
        'No browser is available in this environment, so axe was NOT executed —\n' +
        'the manual checklist in frontend/ACCESSIBILITY.md covers what must be\n' +
        'verified by hand (keyboard traversal, focus order, screen-reader pass).',
    );
  }
} catch (e) {
  check('axe-core importable', false, String(e));
}

// ---------- summary ----------
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
if (notes.length) {
  console.log('\nContrast notes for the manual pass:');
  for (const n of notes) console.log(' -', n);
}
process.exit(failures === 0 ? 0 : 1);
