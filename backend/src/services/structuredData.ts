// Structured-data (JSON-LD) validation (C-04).
// Parses every application/ld+json block and validates the required fields
// of the schema.org types we advise on. Returns the detected types plus
// actionable issues. Pure — no network.

export interface SchemaValidationIssue {
  type: string; // e.g. 'schema-missing-field'
  message: string;
  fix: string;
}

export interface SchemaValidation {
  /** All @type values found across blocks. */
  types: string[];
  /** True when at least one block failed to parse as JSON. */
  hasParseErrors: boolean;
  issues: SchemaValidationIssue[];
}

/** Required fields per well-known type (property must be present and non-empty). */
const REQUIRED_FIELDS: Record<string, string[]> = {
  Article: ['headline'],
  NewsArticle: ['headline'],
  BlogPosting: ['headline'],
  Product: ['name'],
  FAQPage: ['mainEntity'],
  BreadcrumbList: ['itemListElement'],
  Organization: ['name'],
  LocalBusiness: ['name', 'address'],
  Recipe: ['name'],
  Event: ['name', 'startDate'],
  Review: ['itemReviewed', 'reviewRating'],
  WebSite: ['name', 'url'],
};

function collectTypedNodes(node: unknown, out: Array<Record<string, unknown>>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectTypedNodes(n, out);
    return;
  }
  if (node && typeof node === 'object') {
    const rec = node as Record<string, unknown>;
    if (typeof rec['@type'] === 'string' || Array.isArray(rec['@type'])) out.push(rec);
    for (const v of Object.values(rec)) collectTypedNodes(v, out);
  }
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

export function validateJsonLd(blocks: string[]): SchemaValidation {
  const types: string[] = [];
  const issues: SchemaValidationIssue[] = [];
  let hasParseErrors = false;

  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block);
    } catch {
      hasParseErrors = true;
      issues.push({
        type: 'schema-invalid-json',
        message: 'A <script type="application/ld+json"> block is not valid JSON, so search engines ignore it.',
        fix: 'Fix the JSON syntax of the structured-data block (check commas, quotes and brackets).',
      });
      continue;
    }
    const nodes: Array<Record<string, unknown>> = [];
    collectTypedNodes(parsed, nodes);
    for (const node of nodes) {
      const t = node['@type'];
      const typeList = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
      for (const typeName of typeList) {
        if (!types.includes(typeName)) types.push(typeName);
        const required = REQUIRED_FIELDS[typeName];
        if (!required) continue;
        for (const field of required) {
          if (isEmpty(node[field])) {
            issues.push({
              type: 'schema-missing-field',
              message: `Structured data of type "${typeName}" is missing the required "${field}" property, so rich results may not show.`,
              fix: `Add the "${field}" property to the ${typeName} JSON-LD block.`,
            });
          }
        }
      }
    }
  }
  return { types, hasParseErrors, issues };
}
