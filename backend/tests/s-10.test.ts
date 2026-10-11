// S-10 — container hardening, verified by static assertions over the
// Dockerfiles, compose file and CI workflow (no Docker daemon in this env,
// so these are file-review guards against regressions).
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const read = (p: string) => readFileSync(path.join(repo, p), 'utf8');

const DIGEST_RE = /@sha256:[0-9a-f]{64}/;

describe('S-10 Dockerfiles', () => {
  for (const f of ['backend/Dockerfile', 'frontend/Dockerfile']) {
    it(`${f}: base images are digest-pinned`, () => {
      const fromLines = read(f).split('\n').filter((l) => l.startsWith('FROM'));
      expect(fromLines.length).toBeGreaterThan(0);
      for (const l of fromLines) expect(l).toMatch(DIGEST_RE);
    });

    it(`${f}: runs as non-root`, () => {
      expect(read(f)).toMatch(/^USER (node|nextjs|appuser)/m);
    });

    it(`${f}: no silent npm-install fallback`, () => {
      const code = read(f)
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      expect(code).not.toMatch(/\|\|\s*npm install/);
      expect(code).not.toContain('2>/dev/null ||');
    });
  }

  it('backend has a .dockerignore that excludes secrets and build junk', () => {
    expect(existsSync(path.join(repo, 'backend', '.dockerignore'))).toBe(true);
    const di = read('backend/.dockerignore');
    for (const entry of ['node_modules', '.env', 'tests', 'dist']) {
      expect(di).toContain(entry);
    }
  });

  // B2-H1: typescript is a devDependency — `npm ci --omit=dev` before the
  // build drops tsc and `npm run build` dies. The image must install FULL,
  // build, then prune dev deps.
  it('backend/Dockerfile installs devDependencies for the build, prunes after', () => {
    const code = read('backend/Dockerfile')
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    const ciIdx = code.search(/^RUN npm ci\b/m);
    const buildIdx = code.indexOf('npm run build');
    expect(ciIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(ciIdx);
    expect(code.slice(ciIdx, buildIdx)).not.toContain('--omit=dev');
    expect(code.slice(buildIdx)).toContain('npm prune --omit=dev');
  });

  // B2-L9: the image must define a healthcheck so orchestrators can tell a
  // wedged API from a healthy one.
  it('backend/Dockerfile defines a HEALTHCHECK against /healthz', () => {
    const code = read('backend/Dockerfile');
    expect(code).toMatch(/^HEALTHCHECK/m);
    expect(code).toContain('/healthz');
  });
});

describe('S-10 docker-compose.yml', () => {
  const compose = () => read('docker-compose.yml');

  it('does not publish postgres/redis ports to the host', () => {
    const pg = compose().split('redis:')[0];
    expect(pg).not.toMatch(/ports:\s*\n\s*- "5432/);
    expect(compose()).not.toMatch(/- "6379:6379"/);
  });

  it('requires Redis auth (REDIS_PASSWORD) and wires it into REDIS_URL', () => {
    expect(compose()).toMatch(/requirepass/);
    expect(compose()).toMatch(/REDIS_PASSWORD/);
    expect(compose()).toMatch(/redis:\/\/:\$\{REDIS_PASSWORD/);
  });

  it('requires POSTGRES_PASSWORD from the environment (no committed default)', () => {
    expect(compose()).not.toMatch(/POSTGRES_PASSWORD: bseo/);
    expect(compose()).toMatch(/POSTGRES_PASSWORD:\s*\$\{POSTGRES_PASSWORD/);
  });

  it('app services are read-only with resource limits', () => {
    const c = compose();
    for (const svc of ['api:', 'worker:', 'web:', 'migrate:']) {
      const block = c.slice(c.indexOf(`\n  ${svc}`), c.indexOf(`\n  ${svc}`) + 1200);
      expect(block).toMatch(/read_only:\s*true/);
      expect(block).toMatch(/limits:/);
    }
  });

  it('images are digest-pinned', () => {
    const images = [...compose().matchAll(/image:\s*(\S+)/g)].map((m) => m[1]);
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) expect(img).toMatch(DIGEST_RE);
  });
});

describe('S-10 Trivy CI', () => {
  it('workflow exists and scans both images on push/PR/schedule', () => {
    const wf = '.github/workflows/trivy.yml';
    expect(existsSync(path.join(repo, wf))).toBe(true);
    const yml = read(wf);
    expect(yml).toMatch(/trivy-action/);
    expect(yml).toMatch(/schedule/);
    expect(yml).toMatch(/pull_request/);
    expect(yml).toContain('backend');
    expect(yml).toContain('frontend');
  });
});
