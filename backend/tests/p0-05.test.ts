// P0-05 — production safety defaults.
// Failing-first tests: boot must refuse weak/placeholder secrets outside
// explicit dev/test, mock webhooks must require a local signing secret,
// mock-confirm must not exist in production builds.
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateSecrets,
  KNOWN_PLACEHOLDER_SECRETS,
  type SecretsEnv,
} from '../src/config.js';
import {
  signMockWebhookEvent,
  verifyMockWebhookEvent,
  mockBillingRoutesEnabled,
} from '../src/providers/stripe.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

const GOOD: SecretsEnv = {
  jwtSecret: 'a'.repeat(64),
  encryptionKey: 'b'.repeat(64),
};

describe('P0-05(a,b) secret validation', () => {
  it('rejects the dev-default JWT secret in production', () => {
    expect(() => validateSecrets('production', { jwtSecret: 'dev-only-jwt-secret-change-me', encryptionKey: GOOD.encryptionKey }))
      .toThrow(/JWT_SECRET/);
  });

  it('rejects the .env.example placeholder JWT secret in production', () => {
    // 38 chars: passes the length check, must still be rejected as a placeholder.
    const placeholder = 'change-me-to-a-random-32-char-string';
    expect(KNOWN_PLACEHOLDER_SECRETS.has(placeholder)).toBe(true);
    expect(() => validateSecrets('production', { jwtSecret: placeholder, encryptionKey: GOOD.encryptionKey }))
      .toThrow(/placeholder/i);
  });

  it('rejects short JWT secrets in production', () => {
    expect(() => validateSecrets('production', { jwtSecret: 'short-secret', encryptionKey: GOOD.encryptionKey }))
      .toThrow(/32/);
  });

  it('rejects a missing/non-hex ENCRYPTION_KEY in production', () => {
    expect(() => validateSecrets('production', { jwtSecret: GOOD.jwtSecret, encryptionKey: '' }))
      .toThrow(/ENCRYPTION_KEY/);
    expect(() => validateSecrets('production', { jwtSecret: GOOD.jwtSecret, encryptionKey: 'not-hex' }))
      .toThrow(/ENCRYPTION_KEY/);
  });

  it('rejects weak secrets in ANY non-dev/test env (e.g. staging)', () => {
    expect(() => validateSecrets('staging', { jwtSecret: 'dev-only-jwt-secret-change-me', encryptionKey: GOOD.encryptionKey }))
      .toThrow(/JWT_SECRET/);
  });

  it('accepts strong secrets in production', () => {
    expect(() => validateSecrets('production', GOOD)).not.toThrow();
  });

  it('allows dev defaults in development and test', () => {
    const weak: SecretsEnv = { jwtSecret: 'dev-only-jwt-secret-change-me', encryptionKey: '' };
    expect(() => validateSecrets('development', weak)).not.toThrow();
    expect(() => validateSecrets('test', weak)).not.toThrow();
  });
});

describe('P0-05(a) boot refuses to start with unsafe defaults', () => {
  const tsxEval = (env: Record<string, string>, code: string) =>
    execFileAsync('npx', ['tsx', '--eval', code], {
      cwd: path.join(here, '..'),
      env: { ...process.env, ...env },
      timeout: 60000,
    });
  // NOTE: tsx --eval runs as CJS, so no top-level await — use .then().
  const bootCode = `import('./src/config.ts').then(() => console.log('BOOTED'))`;

  it('FATALs when NODE_ENV=production without real secrets', async () => {
    const run = tsxEval({ NODE_ENV: 'production', JWT_SECRET: '', ENCRYPTION_KEY: '' }, bootCode);
    await expect(run).rejects.toThrow(/FATAL/);
  });

  it('boots when NODE_ENV=production with strong secrets', async () => {
    const { stdout } = await tsxEval(
      { NODE_ENV: 'production', JWT_SECRET: GOOD.jwtSecret, ENCRYPTION_KEY: GOOD.encryptionKey },
      bootCode,
    );
    expect(stdout).toContain('BOOTED');
  });
});

describe('P0-05(c) mock webhook signing', () => {
  const secret = 'local-mock-webhook-secret';
  const body = Buffer.from(JSON.stringify({ type: 'checkout.session.completed', data: {} }));

  it('accepts a correctly signed mock webhook event', () => {
    const sig = signMockWebhookEvent(body, secret);
    const evt = verifyMockWebhookEvent(body, sig, secret);
    expect(evt.type).toBe('checkout.session.completed');
  });

  it('rejects a tampered body', () => {
    const sig = signMockWebhookEvent(body, secret);
    const tampered = Buffer.from(JSON.stringify({ type: 'charge.refunded', data: {} }));
    expect(() => verifyMockWebhookEvent(tampered, sig, secret)).toThrow(/signature/i);
  });

  it('rejects a wrong secret and a missing signature', () => {
    const sig = signMockWebhookEvent(body, secret);
    expect(() => verifyMockWebhookEvent(body, sig, 'wrong-secret')).toThrow(/signature/i);
    expect(() => verifyMockWebhookEvent(body, '', secret)).toThrow(/signature/i);
  });

  it('rejects stale timestamps (replay protection)', () => {
    const old = `t=${Math.floor(Date.now() / 1000) - 3600},v1=deadbeef`;
    expect(() => verifyMockWebhookEvent(body, old, secret)).toThrow();
  });
});

describe('P0-05(c) mock-confirm removed in prod builds', () => {
  it('is disabled when NODE_ENV=production', () => {
    expect(mockBillingRoutesEnabled('production')).toBe(false);
  });
  it('is enabled in development and test', () => {
    expect(mockBillingRoutesEnabled('development')).toBe(true);
    expect(mockBillingRoutesEnabled('test')).toBe(true);
  });
});
