// SSRF-safe fetch for the crawler, on-page analyzer, and domain verification.
// Any server-side fetch of a user-influenced URL MUST go through safeFetch.
// Protections:
//  - only http/https protocols
//  - IP literals in private/loopback/link-local/reserved ranges are blocked
//  - hostnames are DNS-resolved and EVERY resolved address is checked
//    (mitigates naive DNS-rebinding; resolutions cached 60s)
//  - redirects are followed manually, each hop re-validated (max 5)

import dns from 'node:dns/promises';
import net from 'node:net';

function ipv4Blocked(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata!)
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function ipv6Blocked(ip: string): boolean {
  const l = ip.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (l === '::1' || l === '::') return true;
  if (l.startsWith('fe80:') || l.startsWith('fec0:')) return true; // link-local / site-local
  if (l.startsWith('fc') || l.startsWith('fd')) return true; // unique local
  if (l.startsWith('ff')) return true; // multicast
  const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]);
  return false;
}

/** True when the literal IP address must never be fetched by our servers. */
export function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return ipv4Blocked(ip);
  if (v === 6) return ipv6Blocked(ip);
  return true;
}

// hostname -> { addresses, expiresAt }; short TTL keeps rebinding window small
const resolveCache = new Map<string, { addresses: string[]; expiresAt: number }>();
const RESOLVE_TTL_MS = 60_000;

async function resolveChecked(hostname: string): Promise<void> {
  const now = Date.now();
  const cached = resolveCache.get(hostname);
  if (cached && cached.expiresAt > now) {
    for (const ip of cached.addresses) {
      if (isBlockedIp(ip)) throw new Error(`SSRF blocked: ${hostname} resolves to ${ip}`);
    }
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error(`SSRF blocked: DNS resolution failed for ${hostname}`);
  }
  const addresses = records.map((r) => r.address);
  if (addresses.length === 0) throw new Error(`SSRF blocked: no DNS records for ${hostname}`);
  for (const ip of addresses) {
    if (isBlockedIp(ip)) throw new Error(`SSRF blocked: ${hostname} resolves to ${ip}`);
  }
  resolveCache.set(hostname, { addresses, expiresAt: now + RESOLVE_TTL_MS });
}

/** Validates a URL for server-side fetching. Returns the normalized URL. Throws when unsafe. */
export async function assertUrlSafe(rawUrl: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`SSRF blocked: invalid URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`SSRF blocked: protocol ${u.protocol} not allowed`);
  }
  const host = u.hostname;
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`SSRF blocked: IP ${host} not allowed`);
    return u;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('SSRF blocked: localhost not allowed');
  }
  await resolveChecked(host);
  return u;
}

/**
 * fetch() with SSRF protection and per-hop redirect validation.
 * Response.url is the final validated URL (redirects followed manually).
 */
export async function safeFetch(
  rawUrl: string,
  init?: RequestInit,
  timeoutMs = 8000,
  maxRedirects = 5,
): Promise<Response> {
  let current = await assertUrlSafe(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      // redirect:'manual' so every hop is re-validated by assertUrlSafe
      res = await fetch(current.toString(), { ...init, signal: ctrl.signal, redirect: 'manual' });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      if (!loc) return res;
      current = await assertUrlSafe(new URL(loc, current.toString()).toString());
      continue;
    }
    return res;
  }
  throw new Error('SSRF blocked: too many redirects');
}
