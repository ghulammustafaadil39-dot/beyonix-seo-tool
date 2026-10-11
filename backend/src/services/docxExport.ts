// Minimal Markdown -> .docx export (F-04). Pure-JS `docx` package (no binaries).
// Supports #, ##, ### headings, **bold**, "- " lists, paragraphs.

import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';

function inlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push(new TextRun(text.slice(last, m.index)));
    runs.push(new TextRun({ text: m[1], bold: true }));
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push(new TextRun(text.slice(last)));
  if (runs.length === 0) runs.push(new TextRun(''));
  return runs;
}

/** Build a .docx Buffer from a title + Markdown body. */
export async function markdownToDocx(title: string, markdown: string): Promise<Buffer> {
  const children: Paragraph[] = [new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] })];
  let inList = false;
  void inList;
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length === 1 ? HeadingLevel.HEADING_1 : h[1].length === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      children.push(new Paragraph({ heading: level, children: inlineRuns(h[2]) }));
      continue;
    }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      children.push(new Paragraph({ bullet: { level: 0 }, children: inlineRuns(li[1]) }));
      continue;
    }
    children.push(new Paragraph({ children: inlineRuns(line) }));
  }
  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}
