// SSRF-safe fetch for the crawler, on-page analyzer, and domain verification.
// Any server-side fetch of a user-influenced URL MUST go through safeFetch.
//
// S-02 hardening:
//  - only http/https protocols
//  - IP literals in private/loopback/link-local/reserved ranges are blocked,
//    INCLUDING IPv6 transition ranges (NAT64 64:ff9b::/96, 6to4 2002::/16,
//    IPv4-mapped ::ffff:0:0/96 in dotted AND hex forms)
//  - hostnames are DNS-resolved ONCE; the TCP/TLS connection is PINNED to a
//    validated IP via a custom undici lookup (no re-resolution at connect
//    time) — this closes the DNS-rebinding hole (validate-then-fetch)
//  - redirects are followed manually, each hop re-resolved + re-validated;
//    Authorization/Cookie headers are dropped on cross-origin redirects
//    (host change or https→http downgrade)
//  - response size is capped (streaming abort) and content-type allow-listed
//    (gzip-bomb / huge-file OOM defense)
//  - absolute total deadline supported for crawl time budgets
//  - test-only loopback bypass: 127.0.0.0/8 and ::1 are fetchable ONLY when
//    NODE_ENV=test (lets QA run the crawler against a local fixture site);
//    fail-closed everywhere else.

import dns from 'node:dns/promises';
import net from 'node:net';
import {
  Agent,
  Headers as UndiciHeaders,
  fetch as undiciFetch,
  type RequestInit as UndiciRequestInit,
} from 'undici';
import { config } from '../config.js';

export interface DnsRecord {
  address: string;
  family: number;
}

export interface SafeFetchOpts {
  /** Per-hop timeout ms (default 8000). */
  timeoutMs?: number;
  /** Max redirects followed (default 5). */
  maxRedirects?: number;
  /** Max response body bytes (default 5_000_000). */
  maxBytes?: number;
  /** Allowed response content-type prefixes (default: html/json/text/xml + images). */
  allowedContentTypes?: string[];
  /** Absolute epoch-ms deadline for the whole fetch incl. redirects. */
  deadlineMs?: number;
  /** DNS resolver override (tests). Defaults to dns.lookup all:true. */
  dnsLookup?: (hostname: string) => Promise<DnsRecord[]>;
}

const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_ALLOWED_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'application/json',
  'text/plain',
  'application/xml',
  'text/xml',
  'application/rss+xml',
  'application/atom+xml',
  'image/',
];

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

function ipv4Bytes(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => {
    if (!/^\d+$/.test(p)) return -1;
    const n = parseInt(p, 10);
    return n >= 0 && n <= 255 ? n : -1;
  });
  return nums.some((n) => n < 0) ? null : nums;
}

/** Parses an IPv6 literal (no brackets, no zone id) into 16 bytes. Null when invalid. */
function ipv6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]; // strip zone id
  if (s.includes('.')) {
    // Embedded IPv4 (dotted or hex tail, e.g. ::ffff:7f00:1)
    const lastColon = s.lastIndexOf(':');
    const head = s.slice(0, lastColon);
    const tail = s.slice(lastColon + 1);
    let v4: number[];
    if (tail.includes('.')) {
      const b = ipv4Bytes(tail);
      if (!b) return null;
      v4 = b;
    } else {
      if (!/^[0-9a-f]{1,8}$/.test(tail)) return null;
      const n = parseInt(tail, 16);
      v4 = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    }
    const hb = parseHead(head);
    if (!hb || hb.length > 12) return null;
    const out = [...hb];
    while (out.length < 12) out.push(0);
    return [...out, ...v4];
  }
  return parseHead(s);
}

function parseHead(s: string): number[] | null {
  if (s === '') return [];
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parseGroup = (g: string): number[] | null => {
    if (g === '') return [];
    const parts = g.split(':');
    const out: number[] = [];
    for (const p of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
      const n = parseInt(p, 16);
      out.push((n >>> 8) & 0xff, n & 0xff);
    }
    return out;
  };
  if (halves.length === 1) {
    const g = parseGroup(s);
    return g && g.length === 16 ? g : null;
  }
  const left = parseGroup(halves[0]);
  const right = parseGroup(halves[1]);
  if (!left || !right || left.length + right.length > 16) return null;
  const out = [...left];
  while (out.length + right.length < 16) out.push(0);
  return [...out, ...right];
}

function hasPrefix(bytes: number[], prefix: number[], bits: number): boolean {
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) if (bytes[i] !== prefix[i]) return false;
  const rest = bits % 8;
  if (rest > 0) {
    const mask = 0xff & (0xff << (8 - rest));
    if ((bytes[full] & mask) !== (prefix[full] & mask)) return false;
  }
  return true;
}

function ipv4BlockedBytes(b: number[]): boolean {
  const [a, c] = [b[0], b[1]];
  if (a === 10) return true;
  if (a === 172 && c >= 16 && c <= 31) return true;
  if (a === 192 && c === 168) return true;
  if (a === 127) return true; // loopback (bypassable in test env only)
  if (a === 169 && c === 254) return true; // link-local (cloud metadata!)
  if (a === 0) return true;
  if (a === 100 && c >= 64 && c <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function ipv6BlockedBytes(b: number[]): boolean {
  const isZero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // ::1 loopback, :: unspecified
  if (isZero(0, 15) && (b[15] === 1 || b[15] === 0)) return true;
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  // S-02: IPv6 transition ranges that tunnel to IPv4
  if (hasPrefix(b, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) return true; // 64:ff9b::/96 NAT64
  if (hasPrefix(b, [0x20, 0x02], 16)) return true; // 2002::/16 6to4
  // ::ffff:0:0/96 IPv4-mapped -> check the embedded IPv4 with v4 rules
  if (isZero(0, 10) && b[10] === 0xff && b[11] === 0xff) return ipv4BlockedBytes(b.slice(12));
  return false;
}

function isLoopbackIp(ip: string): boolean {
  if (net.isIP(ip) === 4) return ipv4Bytes(ip)?.[0] === 127;
  if (net.isIP(ip) === 6) {
    const b = ipv6Bytes(ip);
    return !!b && b.slice(0, 15).every((x) => x === 0) && b[15] === 1;
  }
  return false;
}

/**
 * The test-only loopback bypass is active ONLY when NODE_ENV=test, so QA can
 * run the crawler against a local fixture site. Fail-closed everywhere else.
 * Exported (pure) so tests can prove it is unreachable in production config.
 */
export function isLoopbackBypassActive(nodeEnv: string): boolean {
  return nodeEnv === 'test';
}

export interface BlockOpts {
  /** Allow 127.0.0.0/8 and ::1 (test fixture bypass). Default false. */
  allowLoopback?: boolean;
}

/** True when the literal IP address must never be fetched by our servers. */
export function isBlockedIp(ip: string, opts: BlockOpts = {}): boolean {
  const clean = ip.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  const v = net.isIP(clean);
  if (v === 4) {
    const b = ipv4Bytes(clean)!;
    if (opts.allowLoopback && b[0] === 127) return false;
    return ipv4BlockedBytes(b);
  }
  if (v === 6) {
    const b = ipv6Bytes(clean);
    if (!b) return true;
    if (opts.allowLoopback && isLoopbackIp(clean)) return false;
    return ipv6BlockedBytes(b);
  }
  return true;
}

// ---------------------------------------------------------------------------
// DNS validation (single resolve; the connection is pinned to the result)
// ---------------------------------------------------------------------------

const resolveCache = new Map<string, { addresses: string[]; expiresAt: number }>();
const RESOLVE_TTL_MS = 60_000;

function defaultLookup(hostname: string): Promise<DnsRecord[]> {
  return dns.lookup(hostname, { all: true }).then((rs) =>
    rs.map((r) => ({ address: r.address, family: r.family })),
  );
}

/** Resolves once and validates EVERY address. Returns the validated addresses. */
async function resolveValidated(
  hostname: string,
  opts: SafeFetchOpts,
  allowLoopback: boolean,
): Promise<string[]> {
  const now = Date.now();
  const cached = resolveCache.get(hostname);
  if (cached && cached.expiresAt > now) {
    for (const ip of cached.addresses) {
      if (isBlockedIp(ip, { allowLoopback })) throw new Error(`SSRF blocked: ${hostname} resolves to ${ip}`);
    }
    return cached.addresses;
  }
  const lookup = opts.dnsLookup ?? defaultLookup;
  let records: DnsRecord[];
  try {
    records = await lookup(hostname);
  } catch {
    throw new Error(`SSRF blocked: DNS resolution failed for ${hostname}`);
  }
  const addresses = records.map((r) => r.address);
  if (addresses.length === 0) throw new Error(`SSRF blocked: no DNS records for ${hostname}`);
  for (const ip of addresses) {
    if (isBlockedIp(ip, { allowLoopback })) throw new Error(`SSRF blocked: ${hostname} resolves to ${ip}`);
  }
  resolveCache.set(hostname, { addresses, expiresAt: now + RESOLVE_TTL_MS });
  return addresses;
}

/** Pinned dispatcher: the TCP/TLS connection goes to ONE validated IP; the
 * hostname is never re-resolved (DNS-rebinding defense). Host header and TLS
 * SNI still use the original hostname (the URL is unchanged). */
function pinnedDispatcher(addresses: string[]): Agent {
  const ip = addresses[0];
  const family = net.isIP(ip);
  return new Agent({
    connect: {
      lookup: (_hostname: string, lookupOpts: any, cb: any) => {
        // Node >= 22 calls lookup with { all: true }.
        if (lookupOpts?.all) cb(null, [{ address: ip, family }]);
        else cb(null, ip, family);
      },
    },
  });
}

export interface ValidatedTarget {
  url: URL;
  addresses: string[];
}

/** Validates a URL for server-side fetching. Returns the URL + validated IPs. Throws when unsafe. */
export async function assertUrlSafe(rawUrl: string, opts: SafeFetchOpts = {}): Promise<ValidatedTarget> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`SSRF blocked: invalid URL`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`SSRF blocked: protocol ${u.protocol} not allowed`);
  }
  const allowLoopback = isLoopbackBypassActive(config.nodeEnv);
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1'); // strip IPv6 brackets
  if (net.isIP(host)) {
    if (isBlockedIp(host, { allowLoopback })) throw new Error(`SSRF blocked: IP ${host} not allowed`);
    return { url: u, addresses: [host] };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('SSRF blocked: localhost not allowed');
  }
  const addresses = await resolveValidated(host, opts, allowLoopback);
  return { url: u, addresses };
}

// ---------------------------------------------------------------------------
// Body + content-type caps
// ---------------------------------------------------------------------------

function checkContentType(res: Response, allowed: string[]): void {
  const ct = res.headers.get('content-type');
  if (!ct) return; // absent header: cannot verify, body cap still applies
  const base = ct.split(';')[0].trim().toLowerCase();
  if (!allowed.some((a) => base === a || base.startsWith(a))) {
    throw new Error(`SSRF blocked: content-type ${base} not allowed`);
  }
}

/** Reads the body with a hard byte cap (streaming abort). Returns the bytes. */
async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const lenHeader = res.headers.get('content-length');
  if (lenHeader && /^\d+$/.test(lenHeader.trim()) && parseInt(lenHeader.trim(), 10) > maxBytes) {
    throw new Error(`SSRF blocked: response size ${lenHeader.trim()} exceeds cap of ${maxBytes} bytes`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new Error(`SSRF blocked: response size exceeds cap of ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Returns a copy of the headers with credential headers removed. Used when a
 * redirect crosses to a different host: native fetch strips `Authorization`
 * cross-origin, and manually re-issuing the original init per hop must do the
 * same (plus `Cookie`, same reasoning) or credentials leak to the new host.
 */
function withoutCredentialHeaders(
  headers: UndiciRequestInit['headers'],
): UndiciRequestInit['headers'] {
  const h = new UndiciHeaders(headers as ConstructorParameters<typeof UndiciHeaders>[0]);
  h.delete('authorization');
  h.delete('cookie');
  return h;
}

/**
 * Whether a redirect from `current` to `target` crosses an origin boundary
 * for credential purposes: a different host, or an https→http downgrade on
 * the same host (credentials must never travel over plaintext). Exported for
 * unit tests.
 */
export function shouldStripCredentials(current: URL, target: URL): boolean {
  if (target.host !== current.host) return true;
  return current.protocol === 'https:' && target.protocol === 'http:';
}

// ---------------------------------------------------------------------------
// safeFetch
// ---------------------------------------------------------------------------

/**
 * fetch() with SSRF protection, per-hop redirect validation, IP pinning,
 * response size + content-type caps, and an optional absolute deadline.
 * The returned Response is buffered (body already capped); Response.url is
 * the final validated URL (redirects followed manually).
 */
export async function safeFetch(
  rawUrl: string,
  init?: UndiciRequestInit,
  timeoutMs = 8000,
  maxRedirects = 5,
  opts: SafeFetchOpts = {},
): Promise<Response> {
  const perHopTimeout = opts.timeoutMs ?? timeoutMs;
  const maxHops = opts.maxRedirects ?? maxRedirects;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const allowedTypes = opts.allowedContentTypes ?? DEFAULT_ALLOWED_TYPES;

  const budgetLeft = (): number => {
    if (opts.deadlineMs === undefined) return perHopTimeout;
    const left = opts.deadlineMs - Date.now();
    if (left <= 0) throw new Error('SSRF blocked: total fetch deadline exceeded');
    return Math.min(perHopTimeout, left);
  };

  let current = await assertUrlSafe(rawUrl, opts);
  // Per-hop init: credential headers are dropped when a redirect crosses host.
  let currentInit = init;
  for (let hop = 0; hop <= maxHops; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), budgetLeft());
    // One pinned dispatcher per hop (redirects may change host); closed before
    // the next hop / return so keep-alive sockets don't leak.
    const dispatcher = pinnedDispatcher(current.addresses);
    let res: Response;
    try {
      // redirect:'manual' so every hop is re-validated; the pinned dispatcher
      // guarantees the connection uses the validated IP (no re-resolution).
      res = await undiciFetch(current.url.toString(), {
        ...currentInit,
        signal: ctrl.signal,
        redirect: 'manual',
        dispatcher,
      });
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
      await dispatcher.close().catch(() => undefined);
      if (!loc) return res;
      const target = new URL(loc, current.url.toString());
      // Cross-origin redirect: never forward credentials (native fetch
      // strips Authorization on any origin change; Cookie likewise).
      // Origin change = different host OR https→http scheme downgrade.
      // Same-origin redirects keep the original headers.
      if (shouldStripCredentials(current.url, target) && currentInit?.headers) {
        currentInit = { ...currentInit, headers: withoutCredentialHeaders(currentInit.headers) };
      }
      current = await assertUrlSafe(target.toString(), opts);
      continue;
    }
    try {
      checkContentType(res, allowedTypes);
      const bytes = await readCapped(res, maxBytes);
      return new Response(bytes, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      });
    } finally {
      // Destroy any unconsumed body first: dispatcher.close() would otherwise
      // hang waiting on the in-flight stream (e.g. after an early
      // content-length rejection of a huge body).
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      await dispatcher.close().catch(() => undefined);
    }
  }
  throw new Error('SSRF blocked: too many redirects');
}
