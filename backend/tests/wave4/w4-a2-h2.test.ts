/**
 * A2-H2 regression: the production Docker image must ship src/prompts/*.txt
 * (tsc never emits .txt assets — without the COPY every LLM feature throws
 * ENOENT in prod while dev/tests stay green).
 *
 * - The Dockerfile contains the COPY step (file-verified; no Docker daemon
 *   in this VM).
 * - Every renderPrompt('<name>') call site has a matching template file.
 * - The compiled dist/prompts tree contains every template (build smoke).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      walkTs(p, out);
    } else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('A2-H2: prompt templates ship with the build', () => {
  it('the build copies src/prompts into dist/prompts (not just the Dockerfile)', () => {
    // tsc never emits .txt assets — the copy must live in `npm run build`
    // itself so every deployment path (Docker or otherwise) gets them.
    const pkg = JSON.parse(readFileSync(path.join(backendDir, 'package.json'), 'utf8'));
    expect(String(pkg.scripts.build)).toMatch(/src\/prompts/);
    expect(String(pkg.scripts.build)).toMatch(/dist\/prompts/);
  });

  it('Dockerfile fails the image build if the templates did not land', () => {
    const dockerfile = readFileSync(path.join(backendDir, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/dist\/prompts/);
  });

  it('every renderPrompt(name) call site has src/prompts/<name>.txt', () => {
    const used = new Set<string>();
    for (const f of walkTs(path.join(backendDir, 'src'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/renderPrompt\(\s*['"`]([a-z0-9-]+)['"`]/g)) {
        used.add(m[1]);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const name of used) {
      if (!existsSync(path.join(backendDir, 'src', 'prompts', `${name}.txt`))) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  it('dist/prompts contains every src template (post-build smoke)', () => {
    const srcFiles = readdirSync(path.join(backendDir, 'src', 'prompts')).filter((f) => f.endsWith('.txt'));
    expect(srcFiles.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const f of srcFiles) {
      if (!existsSync(path.join(backendDir, 'dist', 'prompts', f))) missing.push(f);
    }
    expect(missing).toEqual([]);
  });
});
