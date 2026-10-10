import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cache = new Map<string, string>();

/** Loads a versioned prompt template from src/prompts/<name>.txt and interpolates {{var}}. */
export async function renderPrompt(name: string, vars: Record<string, string | number>): Promise<string> {
  let tpl = cache.get(name);
  if (!tpl) {
    // templates live in src/prompts/ (per CONTRACTS.md section 8)
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
    tpl = await readFile(path.join(dir, `${name}.txt`), 'utf8');
    cache.set(name, tpl);
  }
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
}
