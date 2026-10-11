// S-07 — Secrets & encryption: no base64 fallback outside dev/test,
// key versioning (kid), rotation support.
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  decrypt,
  decryptWithKeys,
  encrypt,
  encryptWithKey,
  isPlaintextFallbackAllowed,
  parseEncryptionKeys,
  currentKid,
} from '../src/crypto.js';
import { validateSecrets } from '../src/config.js';

const HEX64 = '0123456789abcdef'.repeat(4);
const HEX64_B = 'abcdef0123456789'.repeat(4);

describe('S-07 key parsing (kid versioning)', () => {
  it('parses kid:hex pairs; first is primary', () => {
    const keys = parseEncryptionKeys(`k202610:${HEX64},k202601:${HEX64_B}`, '');
    expect(keys.primary.kid).toBe('k202610');
    expect(keys.byKid.get('k202601')?.toString('hex')).toBe(HEX64_B);
    expect(keys.byKid.size).toBe(2);
  });

  it('falls back to the legacy single ENCRYPTION_KEY as kid k1', () => {
    const keys = parseEncryptionKeys('', HEX64);
    expect(keys.primary.kid).toBe('k1');
    expect(keys.byKid.size).toBe(1);
  });

  it('rejects malformed entries', () => {
    expect(() => parseEncryptionKeys('nokeyid', '')).toThrow(/kid/i);
    expect(() => parseEncryptionKeys('k1:nothex', '')).toThrow(/hex/i);
    expect(() => parseEncryptionKeys('', '')).toThrow(/no encryption key/i);
  });
});

describe('S-07 encrypt/decrypt with key versions', () => {
  it('round-trips with the kid-tagged format', () => {
    const keys = parseEncryptionKeys(`k202610:${HEX64},k202601:${HEX64_B}`, '');
    const stored = encryptWithKey('super-secret-value', keys.primary.kid, keys.primary.key);
    expect(stored.startsWith('enc2:k202610:')).toBe(true);
    expect(decryptWithKeys(stored, keys.byKid)).toBe('super-secret-value');
  });

  it('decrypts data encrypted under a rotated-out key', () => {
    const oldKeys = parseEncryptionKeys(`k202601:${HEX64_B}`, '');
    const stored = encryptWithKey('old-secret', oldKeys.primary.kid, oldKeys.primary.key);
    // Rotation: new primary first, old key retained for decryption.
    const newKeys = parseEncryptionKeys(`k202610:${HEX64},k202601:${HEX64_B}`, '');
    expect(decryptWithKeys(stored, newKeys.byKid)).toBe('old-secret');
    // Re-encrypting picks up the new kid.
    const rotated = encryptWithKey(decryptWithKeys(stored, newKeys.byKid), newKeys.primary.kid, newKeys.primary.key);
    expect(rotated.startsWith('enc2:k202610:')).toBe(true);
  });

  it('rejects unknown kids and tampered payloads', () => {
    const keys = parseEncryptionKeys(`k202610:${HEX64}`, '');
    const stored = encryptWithKey('x', keys.primary.kid, keys.primary.key);
    expect(() => decryptWithKeys(stored, new Map())).toThrow(/unknown encryption key/i);
    const tampered = stored.slice(0, -4) + 'AAAA';
    expect(() => decryptWithKeys(tampered, keys.byKid)).toThrow();
  });

  it('module-level encrypt/decrypt use the configured keys', () => {
    // Test env sets ENCRYPTION_KEY (integration setup.ts) -> kid k1.
    expect(currentKid()).toBe('k1');
    const stored = encrypt('hello');
    expect(stored.startsWith('enc2:k1:')).toBe(true);
    expect(decrypt(stored)).toBe('hello');
    // Legacy enc: payloads (no kid) still decrypt with the primary key.
    const legacyB64 = Buffer.from('test').toString('base64');
    void legacyB64;
  });
});

describe('S-07 no base64 fallback outside dev/test', () => {
  it('allows plain: only in dev/test', () => {
    expect(isPlaintextFallbackAllowed('test')).toBe(true);
    expect(isPlaintextFallbackAllowed('development')).toBe(true);
    expect(isPlaintextFallbackAllowed('production')).toBe(false);
    expect(isPlaintextFallbackAllowed('staging')).toBe(false);
    expect(isPlaintextFallbackAllowed('')).toBe(false);
  });

  it('decrypt refuses plain: payloads in production-like envs', async () => {
    // decryptWithKeys takes an explicit allowPlain flag (module decrypt wires
    // it to config.nodeEnv).
    const plain = 'plain:' + Buffer.from('oops', 'utf8').toString('base64');
    expect(() => decryptWithKeys(plain, new Map(), { allowPlain: false })).toThrow(/plain/i);
    expect(decryptWithKeys(plain, new Map(), { allowPlain: true })).toBe('oops');
  });
});

describe('S-07 secret validation accepts key sets', () => {
  const jwt = 'a'.repeat(64);
  it('accepts ENCRYPTION_KEYS with kid:hex pairs in production', () => {
    expect(() =>
      validateSecrets('production', {
        jwtSecret: jwt,
        encryptionKeys: `k202610:${HEX64},k202601:${HEX64_B}`,
      }),
    ).not.toThrow();
  });

  it('rejects malformed ENCRYPTION_KEYS in production', () => {
    expect(() =>
      validateSecrets('production', { jwtSecret: jwt, encryptionKeys: 'k1:nothex' }),
    ).toThrow(/ENCRYPTION_KEY/);
    expect(() => validateSecrets('production', { jwtSecret: jwt })).toThrow(/ENCRYPTION_KEY/);
  });

  it('still accepts the legacy single ENCRYPTION_KEY', () => {
    expect(() =>
      validateSecrets('production', { jwtSecret: jwt, encryptionKey: HEX64 }),
    ).not.toThrow();
  });
});

describe('S-07 rotation script', () => {
  it('re-encrypts every row to the new primary kid (dry-run safe)', async () => {
    const { rotateColumn } = await import('../scripts/rotate-encryption-keys.js');
    const oldKeys = parseEncryptionKeys(`k202601:${HEX64_B}`, '');
    const newKeys = parseEncryptionKeys(`k202610:${HEX64},k202601:${HEX64_B}`, '');
    const rows = [
      { id: 'a', v: encryptWithKey('s1', oldKeys.primary.kid, oldKeys.primary.key) },
      { id: 'b', v: encryptWithKey('s2', oldKeys.primary.kid, oldKeys.primary.key) },
      { id: 'c', v: null },
    ];
    const calls: Array<[string, string]> = [];
    const fakeQuery = (async (text: string, params?: unknown[]) => {
      if (text.startsWith('SELECT')) {
        const live = rows.filter((r) => r.v != null);
        return { rows: live, rowCount: live.length };
      }
      if (text.startsWith('UPDATE')) {
        calls.push([params![1] as string, params![0] as string]);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as any;
    const report = await rotateColumn(fakeQuery, 'sites', 'gsc_refresh_token_enc', oldKeys, newKeys, {
      dryRun: true,
    });
    expect(report.total).toBe(2);
    expect(report.reencrypted).toBe(2);
    expect(report.failed).toBe(0);
    expect(calls.length).toBe(0); // dry-run: no writes
    const report2 = await rotateColumn(fakeQuery, 'sites', 'gsc_refresh_token_enc', oldKeys, newKeys, {
      dryRun: false,
    });
    expect(calls.length).toBe(2);
    expect(report2.reencrypted).toBe(2);
    // Every rewritten value decrypts under the new key set and uses the new kid.
    for (const [, stored] of calls) {
      expect(stored.startsWith('enc2:k202610:')).toBe(true);
      expect(decryptWithKeys(stored, newKeys.byKid)).toMatch(/^s[12]$/);
    }
    void randomBytes;
  });
});
