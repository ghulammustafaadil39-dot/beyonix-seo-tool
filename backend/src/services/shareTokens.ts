// Signed share tokens (F-02 audit links, F-08 report links).
// SECURITY-SENSITIVE: token = versioned HMAC-SHA256 over a JSON payload.
// Verification is stateless (no DB read); revocation/expiry listing uses the
// share_tokens table (token_hash). Uses the JWT secret as the HMAC key —
// flagged for Security Lead review (see report to LA).
// Pure w.r.t. the secret passed in — no config import, fully testable.

import crypto from 'node:crypto';

const VERSION = 'bseo1';

export interface SharePayload {
  /** 'audit' | 'report' */
  resourceType: string;
  resourceId: string;
  tenantId: string;
  /** epoch ms */
  expiresAt: number;
  /** epoch ms */
  issuedAt: number;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** Create a signed share token for a resource. */
export function signShareToken(secret: string, payload: SharePayload): string {
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.createHmac('sha256', secret).update(`${VERSION}.${body}`).digest();
  return `${VERSION}.${body}.${b64urlEncode(sig)}`;
}

/** Hash stored in share_tokens for revocation/listing (never the token). */
export function hashShareToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Verify a share token. Returns the payload when the signature is valid and
 * the token has not expired; null otherwise (bad format, bad signature,
 * expired, or wrong resource type when `expectedType` is given).
 */
export function verifyShareToken(
  secret: string,
  token: string,
  expectedType?: string,
): SharePayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== VERSION) return null;
    const [, body, sigB64] = parts;
    const expected = crypto.createHmac('sha256', secret).update(`${VERSION}.${body}`).digest();
    const actual = b64urlDecode(sigB64);
    if (actual.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(b64urlDecode(body).toString('utf8')) as SharePayload;
    if (
      typeof payload.resourceType !== 'string' ||
      typeof payload.resourceId !== 'string' ||
      typeof payload.tenantId !== 'string' ||
      typeof payload.expiresAt !== 'number' ||
      typeof payload.issuedAt !== 'number'
    ) {
      return null;
    }
    if (expectedType && payload.resourceType !== expectedType) return null;
    if (Date.now() > payload.expiresAt) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Default share-link lifetime: 30 days. */
export const DEFAULT_SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
