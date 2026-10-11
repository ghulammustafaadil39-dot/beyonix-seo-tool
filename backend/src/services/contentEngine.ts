import { renderPrompt } from './prompt.js';
import { delimitUntrusted, sanitizeJsonLdForScript } from './promptSafety.js';
import { generateMetered } from './llmMetered.js';
import type { QueryFn } from '../db.js';
import { query as defaultQuery } from '../db.js';

export interface OutlineInput {
  keyword: string;
  title: string;
  tone: string;
  siteDomain: string;
  siteId?: string;
}

export interface DraftInput {
  keyword: string;
  title: string;
  outline: string;
  tone: string;
  targetWords: number;
  siteId?: string;
}

/** Generate a blog outline targeting the keyword. Returns Markdown. */
export async function generateOutline(
  tenantId: string,
  input: OutlineInput,
  q: QueryFn = defaultQuery,
): Promise<string> {
  // B1-R2 (S-09): user-controlled template vars are delimited as
  // untrusted data, same convention as onpage/geo/brief.
  const prompt = await renderPrompt('content-outline', {
    keyword: delimitUntrusted(input.keyword, { label: 'keyword', maxChars: 200 }),
    title: delimitUntrusted(input.title, { label: 'title', maxChars: 300 }),
    tone: delimitUntrusted(input.tone, { label: 'tone', maxChars: 100 }),
    siteDomain: delimitUntrusted(input.siteDomain, { label: 'site-domain', maxChars: 253 }),
  });
  const res = await generateMetered(tenantId, { prompt, maxWords: 400, siteId: input.siteId }, q);
  return res.text;
}

/** Generate the full article draft from an outline. Returns text + metered word count. */
export async function generateDraft(
  tenantId: string,
  input: DraftInput,
  q: QueryFn = defaultQuery,
): Promise<{ text: string; words: number }> {
  // B1-R2 (S-09): see generateOutline above.
  const prompt = await renderPrompt('content-draft', {
    keyword: delimitUntrusted(input.keyword, { label: 'keyword', maxChars: 200 }),
    title: delimitUntrusted(input.title, { label: 'title', maxChars: 300 }),
    outline: delimitUntrusted(input.outline, { label: 'outline', maxChars: 8000 }),
    tone: delimitUntrusted(input.tone, { label: 'tone', maxChars: 100 }),
    targetWords: input.targetWords,
  });
  const res = await generateMetered(tenantId, { prompt, maxWords: input.targetWords + 200, siteId: input.siteId }, q);
  return { text: res.text, words: res.words };
}

/** Count whitespace-separated words in text. */
export function estimateWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline markdown: **bold** only (input is escaped first). */
function inline(s: string): string {
  return escapeHtml(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/**
 * Minimal Markdown -> HTML for GEO export.
 * Supports ##/### headings, **bold**, "- " lists, paragraphs.
 * Detects a heading containing "faq" and collects following question lines
 * (bold **Q** or numbered "1. Q") into an FAQPage JSON-LD script appended
 * before </body>. Wraps everything in a full HTML document with <title>.
 */
export function buildGeoHtml(markdown: string, title: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const body: string[] = [];
  const faq: Array<{ q: string; a: string }> = [];

  let inList = false;
  let faqMode = false;
  let current: { q: string; a: string[] } | null = null;

  const closeList = () => {
    if (inList) {
      body.push('</ul>');
      inList = false;
    }
  };
  const closeFaqQ = () => {
    if (current) {
      faq.push({ q: current.q, a: current.a.join(' ').trim() });
      current = null;
    }
  };
  const stripMd = (s: string) => s.replace(/\*\*/g, '').trim();

  for (const raw of lines) {
    const line = raw.trim();

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      closeFaqQ();
      const level = h[1].length;
      const text = h[2].trim();
      faqMode = /faq/i.test(text);
      body.push(`<h${level}>${inline(text)}</h${level}>`);
      continue;
    }

    if (faqMode) {
      const qb = line.match(/^\*\*(.+?)\*\*\s*(.*)$/);
      const qn = qb ? null : line.match(/^\d+[.)]\s+(.+)$/);
      if (qb || qn) {
        closeFaqQ();
        const qText = qb ? stripMd(qb[1]) : stripMd(qn![1]);
        const rest = qb ? stripMd(qb[2]) : '';
        current = { q: qText, a: rest ? [rest] : [] };
        body.push(`<p><strong>${escapeHtml(qText)}</strong></p>`);
        if (rest) body.push(`<p>${escapeHtml(rest)}</p>`);
        continue;
      }
      if (line === '') continue;
      if (current) {
        current.a.push(stripMd(line));
        body.push(`<p>${inline(line)}</p>`);
        continue;
      }
      // stray text in FAQ section with no open question: plain paragraph
    }

    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!inList) {
        body.push('<ul>');
        inList = true;
      }
      body.push(`<li>${inline(li[1])}</li>`);
      continue;
    }

    if (line === '') {
      closeList();
      continue;
    }

    closeList();
    body.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  closeFaqQ();

  let faqScript = '';
  if (faq.length > 0) {
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    };
    // S-09: model output is embedded in a <script> element — escape "<" as
    // \u003c (valid JSON) so a drafted "</script>" cannot break out.
    faqScript = `<script type="application/ld+json">${sanitizeJsonLdForScript(JSON.stringify(schema))}</script>`;
  }

  return (
    `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<title>${escapeHtml(title)}</title>\n</head>\n<body>\n${body.join('\n')}\n` +
    (faqScript ? `${faqScript}\n` : '') +
    `</body>\n</html>\n`
  );
}
