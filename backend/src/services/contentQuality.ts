/**
 * contentQuality.ts — Phase 4 rebuild.
 *
 * Deterministic (no LLM) content quality scoring. The user demanded
 * "zero compromise" on content quality: human-writer style, NOT
 * AI-looking, penalty-risk unacceptable. Minimum score 75 to pass.
 *
 * scoreContent(text, keyword) → 0-100 with breakdown:
 *   Originality (25) · Depth (20) · E-E-A-T (25) · Intent (15) · Readability (15)
 * isHumanLike(text) → AI-pattern detection (uniform sentence length,
 * cliché transitions, vague claims, no specifics).
 */

export interface QualityDimension {
  label: string;
  points: number;
  max: number;
  note: string;
}

export interface QualityResult {
  score: number;
  passed: boolean;
  breakdown: QualityDimension[];
  suggestions: string[];
}

export interface HumanLikeResult {
  humanLike: boolean;
  issues: string[];
}

const PASS_THRESHOLD = 75;

/** Classic AI-tell transition clichés. */
const CLICHES = [
  'moreover',
  'furthermore',
  'in conclusion',
  'in summary',
  'in today\'s fast-paced world',
  'in today’s fast-paced world',
  'it is important to note',
  'it\'s important to note',
  'delve into',
  'delving into',
  'tapestry',
  'landscape',
  'additionally',
  'consequently',
  'nevertheless',
  'nonetheless',
  'in essence',
  'overall,',
  'ultimately,',
  'when it comes to',
  'in the realm of',
  'it goes without saying',
  'needless to say',
  'as an ai',
  'as a language model',
];

/** Vague claims with no specifics — E-E-A-T killers. */
const VAGUE_PATTERNS = [
  /\bmany experts (say|believe|agree)\b/i,
  /\bstudies show\b/i,
  /\bresearch (shows|suggests)\b/i,
  /\bit is widely (known|believed|accepted)\b/i,
  /\bvarious (studies|experts|sources)\b/i,
  /\ba lot of\b/i,
  /\bsome people say\b/i,
  /\bexperts recommend\b/i,
];

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

function sentences(text: string): string[] {
  // Split on sentence-ending punctuation, keep non-empty.
  return text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function headings(text: string): string[] {
  return text.split('\n').filter((l) => /^#{1,3}\s+/.test(l.trim()));
}

function listItems(text: string): string[] {
  return text.split('\n').filter((l) => /^\s*([-*]|\d+[.)])\s+/.test(l));
}

/** Find repeated 4-word phrases (3+ occurrences = template repetition). */
function repeatedPhrases(text: string): string[] {
  const ws = words(text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' '));
  const counts = new Map<string, number>();
  for (let i = 0; i + 4 <= ws.length; i++) {
    const phrase = ws.slice(i, i + 4).join(' ');
    // Skip phrases that are mostly stopwords
    const meaningful = phrase.split(' ').filter((w) => w.length > 3).length;
    if (meaningful < 2) continue;
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 3)
    .map(([p]) => p)
    .slice(0, 5);
}

function countCliches(text: string): string[] {
  const lower = text.toLowerCase();
  return CLICHES.filter((c) => lower.includes(c));
}

/** ---- Originality (25): repetition + template patterns ---- */
function scoreOriginality(text: string): QualityDimension {
  let points = 25;
  const notes: string[] = [];
  const suggestions: string[] = [];

  const reps = repeatedPhrases(text);
  if (reps.length > 0) {
    points -= Math.min(10, reps.length * 4);
    notes.push(`${reps.length} repeated phrase(s)`);
    suggestions.push(`Rewrite repeated phrases: "${reps[0]}" appears 3+ times — vary the wording.`);
  }

  const cliches = countCliches(text);
  if (cliches.length > 0) {
    points -= Math.min(10, cliches.length * 3);
    notes.push(`${cliches.length} AI cliché(s): ${cliches.slice(0, 3).join(', ')}`);
    suggestions.push(`Remove AI clichés (${cliches.slice(0, 3).join(', ')}) — a human writer would not use these.`);
  }

  // Identical paragraph openers = template writing
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 40);
  const openers = new Map<string, number>();
  for (const p of paras) {
    const opener = p.split(/\s+/).slice(0, 3).join(' ').toLowerCase();
    openers.set(opener, (openers.get(opener) ?? 0) + 1);
  }
  const dupOpeners = [...openers.values()].filter((c) => c >= 3).length;
  if (dupOpeners > 0) {
    points -= 5;
    notes.push('paragraphs start the same way');
    suggestions.push('Vary paragraph openings — multiple paragraphs start with identical phrasing.');
  }

  return {
    label: 'Originality',
    points: Math.max(0, points),
    max: 25,
    note: notes.length ? notes.join('; ') : 'No repetition or template patterns detected',
    suggestions,
  } as QualityDimension & { suggestions: string[] };
}

/** ---- Depth (20): word count, structure ---- */
function scoreDepth(text: string): QualityDimension {
  let points = 0;
  const notes: string[] = [];
  const suggestions: string[] = [];
  const wc = words(text).length;

  // Word count: min 1200 for informational
  if (wc >= 1200) {
    points += 10;
    notes.push(`${wc} words`);
  } else if (wc >= 900) {
    points += 7;
    notes.push(`${wc} words (target 1200+)`);
    suggestions.push(`Expand to 1200+ words (currently ${wc}) — add examples, steps, or a deeper FAQ.`);
  } else if (wc >= 600) {
    points += 4;
    notes.push(`${wc} words (thin — target 1200+)`);
    suggestions.push(`Content is thin at ${wc} words. Target 1200+ with concrete examples and practical steps.`);
  } else {
    notes.push(`${wc} words (far too thin)`);
    suggestions.push(`Only ${wc} words — far below the 1200-word minimum. This will not rank.`);
  }

  const hs = headings(text);
  const h2h3 = hs.filter((h) => /^#{2,3}\s+/.test(h.trim())).length;
  if (h2h3 >= 4) {
    points += 6;
    notes.push(`${h2h3} subheadings`);
  } else if (h2h3 >= 2) {
    points += 3;
    notes.push(`only ${h2h3} subheadings`);
    suggestions.push('Add more H2/H3 subheadings to structure the article (aim for 4+).');
  } else {
    notes.push('no subheadings');
    suggestions.push('Add H2/H3 subheadings — a wall of text will not rank or be read.');
  }

  const lists = listItems(text);
  if (lists.length >= 3) {
    points += 4;
    notes.push(`${lists.length} list items`);
  } else if (lists.length > 0) {
    points += 2;
    notes.push('few list items');
  } else {
    notes.push('no lists');
    suggestions.push('Add at least one bullet/numbered list — scannable structure helps rankings.');
  }

  return {
    label: 'Depth',
    points: Math.min(20, points),
    max: 20,
    note: notes.join('; '),
    suggestions,
  } as QualityDimension & { suggestions: string[] };
}

/** ---- E-E-A-T (25): specifics, no vague claims, author voice ---- */
function scoreEEAT(text: string): QualityDimension {
  let points = 0;
  const notes: string[] = [];
  const suggestions: string[] = [];

  // Specific details: numbers, years, named entities (capitalized multi-word)
  const numbers = text.match(/\b\d+(\.\d+)?(%|x)?\b/g) ?? [];
  const years = text.match(/\b(19|20)\d{2}\b/g) ?? [];
  const entities = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) ?? [];
  const specificity = numbers.length + years.length * 2 + entities.length;

  if (specificity >= 15) {
    points += 12;
    notes.push(`${numbers.length} numbers, ${entities.length} named entities`);
  } else if (specificity >= 7) {
    points += 7;
    notes.push(`some specifics (${numbers.length} numbers)`);
    suggestions.push('Add more specific details — exact numbers, names, places, dates. Vague content does not demonstrate expertise.');
  } else {
    notes.push('almost no specific details');
    suggestions.push('Add concrete specifics: real numbers, named tools/people/places, dates. Without these the article reads as generic AI filler.');
  }

  // Vague claims penalty
  const vague = VAGUE_PATTERNS.filter((re) => re.test(text));
  if (vague.length === 0) {
    points += 7;
    notes.push('no vague claims');
  } else {
    points += Math.max(0, 7 - vague.length * 3);
    notes.push(`${vague.length} vague claim(s)`);
    suggestions.push('Replace vague claims ("studies show", "many experts say") with named sources or specific data — or remove them.');
  }

  // Author voice: first/second person, direct address, opinions
  const voice = /\b(I|we|you|your|my|our)\b/i.test(text);
  const opinion = /\b(in my experience|i recommend|i suggest|personally|frankly|honestly)\b/i.test(text);
  if (voice && opinion) {
    points += 6;
    notes.push('clear author voice');
  } else if (voice) {
    points += 3;
    notes.push('some direct address');
    suggestions.push('Add author voice — a first-person recommendation or direct "you" guidance makes content feel written by a human expert.');
  } else {
    notes.push('no author voice');
    suggestions.push('Write with a human voice: address the reader directly ("you"), share a recommendation. Faceless third-person reads as AI-generated.');
  }

  return {
    label: 'E-E-A-T',
    points: Math.min(25, points),
    max: 25,
    note: notes.join('; '),
    suggestions,
  } as QualityDimension & { suggestions: string[] };
}

/** ---- Intent match (15): keyword placement ---- */
function scoreIntent(text: string, keyword: string): QualityDimension {
  let points = 0;
  const notes: string[] = [];
  const suggestions: string[] = [];
  const kw = keyword.toLowerCase().trim();
  if (!kw) {
    return { label: 'Intent match', points: 0, max: 15, note: 'no keyword provided', suggestions: ['Provide a target keyword to check intent match.'] } as QualityDimension & { suggestions: string[] };
  }
  const lower = text.toLowerCase();
  const firstLine = text.split('\n').find((l) => l.trim().length > 0) ?? '';

  if (firstLine.toLowerCase().includes(kw)) {
    points += 5;
    notes.push('keyword in title/opening');
  } else {
    suggestions.push(`Put the target keyword "${keyword}" in the title or opening line.`);
  }

  const h1 = headings(text).find((h) => /^#\s+/.test(h.trim()));
  if (h1 && h1.toLowerCase().includes(kw)) {
    points += 5;
    notes.push('keyword in H1');
  } else {
    suggestions.push(`Include "${keyword}" in the H1 heading.`);
  }

  const first100 = words(text).slice(0, 100).join(' ').toLowerCase();
  if (first100.includes(kw)) {
    points += 5;
    notes.push('keyword in first 100 words');
  } else {
    suggestions.push(`Mention "${keyword}" within the first 100 words.`);
  }

  return {
    label: 'Intent match',
    points,
    max: 15,
    note: notes.length ? notes.join('; ') : 'keyword missing from key positions',
    suggestions,
  } as QualityDimension & { suggestions: string[] };
}

/** ---- Readability (15): sentence variety (anti-AI), structure ---- */
function scoreReadability(text: string): QualityDimension {
  let points = 0;
  const notes: string[] = [];
  const suggestions: string[] = [];
  const sents = sentences(text).filter((s) => !/^#{1,3}\s/.test(s));
  if (sents.length === 0) {
    return { label: 'Readability', points: 0, max: 15, note: 'no sentences found', suggestions: [] } as QualityDimension & { suggestions: string[] };
  }

  const lens = sents.map((s) => words(s).length);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
  const sd = Math.sqrt(variance);
  // Humans vary sentence length a lot; AI tends toward uniform ~15-20 word sentences.
  const cv = mean > 0 ? sd / mean : 0; // coefficient of variation

  if (cv >= 0.55) {
    points += 8;
    notes.push(`natural sentence variety (CV ${cv.toFixed(2)})`);
  } else if (cv >= 0.35) {
    points += 4;
    notes.push(`moderate variety (CV ${cv.toFixed(2)})`);
    suggestions.push('Vary sentence length more — mix short punchy sentences with longer ones. Uniform length is the #1 AI tell.');
  } else {
    notes.push(`uniform sentences (CV ${cv.toFixed(2)}) — reads as AI-generated`);
    suggestions.push('Sentence length is suspiciously uniform — the strongest AI signal. Break up the rhythm: add short sentences. Fragments work.');
  }

  if (mean >= 10 && mean <= 25) {
    points += 4;
    notes.push(`avg ${mean.toFixed(0)} words/sentence`);
  } else {
    points += 1;
    notes.push(`avg ${mean.toFixed(0)} words/sentence (aim 10-25)`);
    suggestions.push(`Average sentence length is ${mean.toFixed(0)} words — aim for 10-25.`);
  }

  // Excessive bullets = AI listicle pattern
  const listCount = listItems(text).length;
  const totalLines = text.split('\n').filter((l) => l.trim().length > 0).length;
  const listRatio = totalLines > 0 ? listCount / totalLines : 0;
  if (listRatio <= 0.4) {
    points += 3;
  } else {
    points += 1;
    notes.push('excessive bullet points');
    suggestions.push('Too much of the article is bullet points — convert some lists into flowing paragraphs.');
  }

  return {
    label: 'Readability',
    points: Math.min(15, points),
    max: 15,
    note: notes.join('; ') || 'ok',
    suggestions,
  } as QualityDimension & { suggestions: string[] };
}

/** Main entry: score content 0-100. Pass threshold 75. */
export function scoreContent(text: string, keyword = ''): QualityResult {
  if (!text || text.trim().length < 50) {
    return {
      score: 0,
      passed: false,
      breakdown: [],
      suggestions: ['Content is empty or far too short to score.'],
    };
  }
  const dims = [
    scoreOriginality(text),
    scoreDepth(text),
    scoreEEAT(text),
    scoreIntent(text, keyword),
    scoreReadability(text),
  ];
  const score = dims.reduce((a, d) => a + d.points, 0);
  const suggestions = dims.flatMap((d) => (d as unknown as { suggestions: string[] }).suggestions ?? []);
  const breakdown: QualityDimension[] = dims.map(({ label, points, max, note }) => ({ label, points, max, note }));
  return {
    score: Math.min(100, Math.round(score)),
    passed: score >= PASS_THRESHOLD,
    breakdown,
    suggestions,
  };
}

/** AI-pattern detection. Returns false + issues when text looks machine-generated. */
export function isHumanLike(text: string): HumanLikeResult {
  const issues: string[] = [];
  if (!text || text.trim().length < 50) {
    return { humanLike: false, issues: ['Text too short to evaluate'] };
  }

  const sents = sentences(text).filter((s) => !/^#{1,3}\s/.test(s));
  if (sents.length >= 5) {
    const lens = sents.map((s) => words(s).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    const cv = mean > 0 ? sd / mean : 0;
    if (cv < 0.35) {
      issues.push(`Uniform sentence length (variation ${cv.toFixed(2)} < 0.35) — the strongest AI-generated signal. Human writers vary rhythm naturally.`);
    }
  }

  const cliches = countCliches(text);
  if (cliches.length >= 3) {
    issues.push(`AI cliché transitions overused: ${cliches.slice(0, 5).join(', ')}. Human writers rarely stack these.`);
  } else if (cliches.length >= 1) {
    issues.push(`AI cliché detected: "${cliches[0]}" — replace with plain phrasing.`);
  }

  const numbers = text.match(/\b\d+(\.\d+)?\b/g) ?? [];
  const entities = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) ?? [];
  if (numbers.length < 3 && entities.length < 2) {
    issues.push('No specific details (numbers, names, places) — generic text with zero specifics reads as AI filler and carries penalty risk.');
  }

  const vague = VAGUE_PATTERNS.filter((re) => re.test(text));
  if (vague.length > 0) {
    issues.push(`${vague.length} vague unattributed claim(s) ("studies show", "experts say") — either name the source or remove the claim.`);
  }

  if (!/\b(I|we|you|your)\b/i.test(text)) {
    issues.push('No human voice — no "I/you/we" anywhere. Faceless third-person narration is a classic AI tell.');
  }

  // Every paragraph same length (±20%) = template
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 100);
  if (paras.length >= 4) {
    const plens = paras.map((p) => words(p).length);
    const pmean = plens.reduce((a, b) => a + b, 0) / plens.length;
    const uniform = plens.every((l) => Math.abs(l - pmean) / pmean < 0.2);
    if (uniform) {
      issues.push('All paragraphs are nearly the same length — humans write uneven paragraphs; templates do not.');
    }
  }

  return { humanLike: issues.length === 0, issues };
}

export const QUALITY_PASS_THRESHOLD = PASS_THRESHOLD;
