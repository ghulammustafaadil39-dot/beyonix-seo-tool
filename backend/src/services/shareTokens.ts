// Signed share tokens (F-02 audit links, F-08 report links).
// SECURITY-SENSITIVE. Opaque-token pattern (like Notion/Docs share links):
//   token = "bseo1.<22-char random id>.<43-char HMAC-SHA256(secret, id)>"
//
// The random id is 128 bits (unguessable); the HMAC binds the token to our
// secret so tokens cannot be minted without it. NOTE on what the HMAC does
// and does NOT cover: the signature is over `bseo1.<id>` ONLY — it does not
// cover the resource, tenant, or expiry. That binding lives in the
// share_tokens DB row (resource_type, resource_id, tenant_id, expires_at),
// looked up by token_hash at resolution time — which is also what makes
// revocation a row delete. The DB row, not the signature, is authoritative
// for what a token points at and when it dies. This keeps the URL short
// (Fastify caps route params at 100 chars by default).
// KEY SEPARATION (Security fix, Wave-2 rebase): call sites must NEVER pass
// the raw JWT secret. They pass deriveShareTokenKey(config.jwtSecret) —
// an HMAC-derived, domain-separated key — so a share-token signature can
// never be confused with / forged from JWT material and vice versa.
// Pure w.r.t. the key passed in — no config import, fully testable.

import crypto from 'node:crypto';

/**
 * Domain-separated share-token HMAC key derived from the JWT secret:
 * HMAC-SHA256(jwtSecret, 'bseo:share-tokens:v1') as raw bytes.
 * Tokens minted before this derivation (raw jwtSecret as key) no longer
 * verify — acceptable pre-launch (share links are re-mintable).
 */
export function deriveShareTokenKey(jwtSecret: string): Buffer {
  return crypto.createHmac('sha256', jwtSecret).update('bseo:share-tokens:v1').digest();
}

const VERSION = 'bseo1';
const ID_BYTES = 16; // 128-bit random id

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** Create a new signed share token. Returns { token, tokenHash }. */
export function createShareToken(secret: string | Buffer): { token: string; tokenHash: string } {
  const id = b64urlEncode(crypto.randomBytes(ID_BYTES));
  const sig = b64urlEncode(crypto.createHmac('sha256', secret).update(`${VERSION}.${id}`).digest());
  const token = `${VERSION}.${id}.${sig}`;
  return { token, tokenHash: hashShareToken(token) };
}

/** Hash stored in share_tokens for lookup (never the token itself). */
export function hashShareToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Verify a token's FORMAT and signature. Returns the token id when valid,
 * null otherwise (bad format, bad signature). Expiry/resource checks are
 * done against the share_tokens row by the caller.
 */
export function verifyShareTokenFormat(secret: string | Buffer, token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== VERSION) return null;
    const [, id, sigB64] = parts;
    if (!/^[A-Za-z0-9_-]{16,32}$/.test(id)) return null;
    const expected = crypto.createHmac('sha256', secret).update(`${VERSION}.${id}`).digest();
    const actual = b64urlDecode(sigB64);
    if (actual.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(actual, expected)) return null;
    return id;
  } catch {
    return null;
  }
}

/** Default share-link lifetime: 30 days. */
export const DEFAULT_SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
