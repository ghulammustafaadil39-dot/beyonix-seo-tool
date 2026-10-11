// S-07: AES-256-GCM for stored OAuth/API keys, with key versioning (kid).
//
// Key sources (first wins):
//   ENCRYPTION_KEYS="kid:hex,kid:hex,..." — first entry is the PRIMARY key
//     used for encryption; the rest are retained previous keys so data
//     encrypted before a rotation still decrypts.
//   ENCRYPTION_KEY="hex" (legacy single key) — used as kid "k1".
//
// Stored formats:
//   enc2:<kid>:<base64(iv|tag|ct)>  — current, kid-tagged
//   enc:<base64(iv|tag|ct)>          — legacy (no kid); B2-M6: decryption
//     tries every known key, primary first (AES-GCM auth rejects wrong
//     keys), so legacy rows survive a rotation that changed the primary.
//   plain:<base64>                   — DEV/TEST ONLY. Refused outside
//                                      development/test (fail fast, S-07).
import crypto from 'node:crypto';
import { config } from './config.js';

export interface ParsedKeys {
  primary: { kid: string; key: Buffer };
  byKid: Map<string, Buffer>;
}

const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const KID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Parses key configuration. Pure and unit-testable.
 * @param keysEnv  raw ENCRYPTION_KEYS ("kid:hex,kid:hex")
 * @param legacyEnv raw ENCRYPTION_KEY ("hex")
 */
export function parseEncryptionKeys(keysEnv: string, legacyEnv: string): ParsedKeys {
  const byKid = new Map<string, Buffer>();
  const add = (kid: string, hex: string) => {
    if (!KID_RE.test(kid)) throw new Error(`FATAL: bad key id in ENCRYPTION_KEYS: ${kid}`);
    if (!HEX64_RE.test(hex)) throw new Error(`FATAL: key ${kid} in ENCRYPTION_KEYS is not a 32-byte hex string`);
    if (byKid.has(kid)) throw new Error(`FATAL: duplicate key id in ENCRYPTION_KEYS: ${kid}`);
    byKid.set(kid, Buffer.from(hex, 'hex'));
  };
  const raw = (keysEnv ?? '').trim();
  if (raw) {
    for (const part of raw.split(',')) {
      const idx = part.indexOf(':');
      if (idx === -1) throw new Error('FATAL: ENCRYPTION_KEYS entries must be "kid:hex"');
      add(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
    }
  } else if ((legacyEnv ?? '').trim()) {
    add('k1', legacyEnv.trim());
  } else {
    throw new Error('FATAL: no encryption key configured (ENCRYPTION_KEYS or ENCRYPTION_KEY)');
  }
  const firstKid = [...byKid.keys()][0]!;
  return { primary: { kid: firstKid, key: byKid.get(firstKid)! }, byKid };
}

/** Module keys from config; null in dev/test when no key is configured. */
let KEYS: ParsedKeys | null | undefined;
function keys(): ParsedKeys | null {
  if (KEYS === undefined) {
    if (isPlaintextFallbackAllowed(config.nodeEnv)) {
      try {
        KEYS = parseEncryptionKeys(config.encryptionKeys, config.encryptionKey);
      } catch {
        // Dev/test without any key: keep the historical base64 fallback so
        // local development works with zero config.
        KEYS = null;
      }
    } else {
      // Production can never reach the fallback — validateSecrets() refuses
      // to boot without a real key — so misconfiguration throws here.
      KEYS = parseEncryptionKeys(config.encryptionKeys, config.encryptionKey);
    }
  }
  return KEYS;
}

/** True only in development/test — the ONLY envs where plain: is tolerated. */
export function isPlaintextFallbackAllowed(nodeEnv: string): boolean {
  return nodeEnv === 'development' || nodeEnv === 'test';
}

/**
 * The kid new encryptions use. Throws when no key is configured.
 * AUDIT (A2-L3): kept as public API — exercised by tests/s-07.test.ts
 * (key-rotation coverage); not dead.
 */
export function currentKid(): string {
  const k = keys();
  if (!k) throw new Error('No encryption key configured');
  return k.primary.kid;
}

/** Encrypt with an explicit key (pure w.r.t. keys — used by tests + rotation). */
export function encryptWithKey(plain: string, kid: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc2:${kid}:` + Buffer.concat([iv, tag, enc]).toString('base64');
}

export interface DecryptOpts {
  /** Allow plain: payloads (module decrypt wires this to the node env). */
  allowPlain?: boolean;
}

/** AES-256-GCM decrypt of an iv|tag|ct base64 payload; throws on wrong key. */
function decryptPayload(key: Buffer, b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** Decrypt with an explicit key map (pure w.r.t. keys — used by tests + rotation). */
export function decryptWithKeys(stored: string, byKid: Map<string, Buffer>, opts: DecryptOpts = {}): string {
  if (stored.startsWith('plain:')) {
    if (!opts.allowPlain) {
      throw new Error('Refusing to decrypt plain: payload outside development/test');
    }
    return Buffer.from(stored.slice(6), 'base64').toString('utf8');
  }
  let kid: string | null = null;
  let b64: string;
  if (stored.startsWith('enc2:')) {
    const rest = stored.slice(5);
    const idx = rest.indexOf(':');
    if (idx === -1) throw new Error('Malformed enc2 payload');
    kid = rest.slice(0, idx);
    b64 = rest.slice(idx + 1);
  } else if (stored.startsWith('enc:')) {
    b64 = stored.slice(4);
  } else {
    throw new Error('Unknown encrypted format');
  }
  let candidates: Buffer[];
  if (kid !== null) {
    const key = byKid.get(kid);
    if (!key) throw new Error(`Unknown encryption key id: ${kid}`);
    candidates = [key];
  } else {
    // B2-M6: legacy kid-less `enc:` rows are tried against EVERY known key
    // (primary first), not just the primary. The old code resolved them
    // with `[...byKid.values()][0]` — after a rotation that is the NEW key,
    // so any remaining `enc:` rows encrypted under the old key became
    // undecryptable (the rotation script counted them `failed` and exited
    // 1). Trying each key is safe: AES-GCM authentication rejects wrong
    // keys, so only the true key succeeds; payloads that decrypted before
    // (under the primary) still decrypt first-try.
    candidates = [...byKid.values()];
    if (candidates.length === 0) throw new Error('Unknown encryption key id: null');
  }
  let lastErr: unknown = new Error('decryption failed');
  for (const key of candidates) {
    try {
      return decryptPayload(key, b64);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Encrypt with the primary key (dev/test without a key: base64 fallback). */
export function encrypt(plain: string): string {
  const k = keys();
  if (!k) return 'plain:' + Buffer.from(plain, 'utf8').toString('base64');
  return encryptWithKey(plain, k.primary.kid, k.primary.key);
}

/** Decrypt, resolving the kid (or primary for legacy enc:). */
export function decrypt(stored: string): string {
  const k = keys();
  if (!k) {
    // Dev/test without a key: only plain: payloads can exist.
    return decryptWithKeys(stored, new Map(), { allowPlain: true });
  }
  return decryptWithKeys(stored, k.byKid, { allowPlain: isPlaintextFallbackAllowed(config.nodeEnv) });
}
