import crypto from 'node:crypto';
import { config } from './config.js';

// AES-256-GCM for stored OAuth/API keys. In dev/test without a key,
// falls back to base64 (NOT secure — only for local dev).
const keyHex = config.encryptionKey;
const key = keyHex && /^[0-9a-fA-F]{64}$/.test(keyHex) ? Buffer.from(keyHex, 'hex') : null;

export function encrypt(plain: string): string {
  if (!key) return 'plain:' + Buffer.from(plain, 'utf8').toString('base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(stored: string): string {
  if (stored.startsWith('plain:')) return Buffer.from(stored.slice(6), 'base64').toString('utf8');
  if (!stored.startsWith('enc:')) throw new Error('Unknown encrypted format');
  if (!key) throw new Error('ENCRYPTION_KEY not configured');
  const buf = Buffer.from(stored.slice(4), 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
