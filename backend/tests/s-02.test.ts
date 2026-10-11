// S-02 — SSRF hardening: DNS-rebinding pinning, IPv6 transition blocks,
// response size + content-type caps, test-only loopback bypass (fail-closed).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  assertUrlSafe,
  isBlockedIp,
  isLoopbackBypassActive,
  safeFetch,
} from '../src/services/safeFetch.js';

// Local fixture servers (loopback bypass is active in NODE_ENV=test).
let serverA: http.Server;
let portA = 0;

beforeAll(async () => {
  serverA = http.createServer((req, res) => {
    if (req.url === '/big') {
      res.setHeader('Content-Type', 'text/html');
      res.end('x'.repeat(6_000_000)); // 6 MB — gzip-bomb stand-in
      return;
    }
    if (req.url === '/binary') {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end('not-html');
      return;
    }
    if (req.url === '/redirect-blocked') {
      res.writeHead(302, { Location: 'http://10.0.0.1/' });
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><body>server-A</body></html>');
  });
  await new Promise<void>((r) => serverA.listen(0, '127.0.0.1', () => r()));
  portA = (serverA.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => serverA.close(() => r(undefined)));
});

const stubLookup = (addrs: Array<{ address: string; family: number }>) => {
  let calls = 0;
  const fn = async (_hostname: string) => {
    calls++;
    return addrs;
  };
  return { fn, calls: () => calls };
};

describe('S-02 DNS-rebinding: single-resolve IP pinning', () => {
  it('pins the connection to the validated IP even when DNS rebinds', async () => {
    // First resolution -> 127.0.0.1 (our server); every later resolution ->
    // 127.0.0.2 (attacker rebinds). With pinning, the fetch MUST still hit A.
    let n = 0;
    const dnsLookup = async (_h: string) => {
      n++;
      return n === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '127.0.0.2', family: 4 }];
    };
    const res = await safeFetch(
      `http://rebind-test.invalid:${portA}/`,
      undefined,
      8000,
      5,
      { dnsLookup },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('server-A');
    expect(n).toBe(1); // validated once; the connection never re-resolved
  });

  it('re-validates every redirect hop', async () => {
    const { fn } = stubLookup([{ address: '127.0.0.1', family: 4 }]);
    await expect(
      safeFetch(`http://redir-test.invalid:${portA}/redirect-blocked`, undefined, 8000, 5, { dnsLookup: fn }),
    ).rejects.toThrow(/SSRF blocked/);
  });
});

describe('S-02 IPv6 transition + mapped range blocks', () => {
  it.each([
    ['64:ff9b::808:808', 'NAT64'],
    ['64:ff9b::c000:201', 'NAT64'],
    ['2002:7f00:1::1', '6to4'],
    ['::ffff:127.0.0.1', 'ipv4-mapped dotted'],
    ['::ffff:7f00:1', 'ipv4-mapped hex'],
    ['::ffff:0a00:1', 'ipv4-mapped hex private'],
    ['169.254.169.254', 'cloud metadata'],
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'rfc1918'],
  ])('blocks %s (%s)', (ip) => {
    expect(isBlockedIp(ip, { allowLoopback: false })).toBe(true);
  });

  it.each([['93.184.216.34'], ['2606:4700:4700::1111'], ['2001:db8::1']])(
    'allows public %s',
    (ip) => {
      expect(isBlockedIp(ip, { allowLoopback: false })).toBe(false);
    },
  );

  it('blocks bracketed IPv6 literals in URLs', async () => {
    const { fn } = stubLookup([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertUrlSafe('http://[::ffff:7f00:1]/', { dnsLookup: fn })).rejects.toThrow(/SSRF blocked/);
  });
});

describe('S-02 response size + content-type caps (gzip-bomb defense)', () => {
  it('aborts responses larger than maxBytes', async () => {
    const { fn } = stubLookup([{ address: '127.0.0.1', family: 4 }]);
    await expect(
      safeFetch(`http://big-test.invalid:${portA}/big`, undefined, 8000, 5, {
        dnsLookup: fn,
        maxBytes: 1_000_000,
      }),
    ).rejects.toThrow(/size/i);
  });

  it('rejects disallowed content types', async () => {
    const { fn } = stubLookup([{ address: '127.0.0.1', family: 4 }]);
    await expect(
      safeFetch(`http://bin-test.invalid:${portA}/binary`, undefined, 8000, 5, { dnsLookup: fn }),
    ).rejects.toThrow(/content-type/i);
  });

  it('accepts normal HTML under the cap', async () => {
    const { fn } = stubLookup([{ address: '127.0.0.1', family: 4 }]);
    const res = await safeFetch(`http://ok-test.invalid:${portA}/`, undefined, 8000, 5, { dnsLookup: fn });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('server-A');
  });

  it('honors an absolute total deadline', async () => {
    const { fn } = stubLookup([{ address: '127.0.0.1', family: 4 }]);
    await expect(
      safeFetch(`http://dl-test.invalid:${portA}/`, undefined, 8000, 5, {
        dnsLookup: fn,
        deadlineMs: Date.now() - 1,
      }),
    ).rejects.toThrow(/deadline|budget/i);
  });
});

describe('S-02 test-only loopback bypass (fail-closed)', () => {
  it('is active only when NODE_ENV=test', () => {
    expect(isLoopbackBypassActive('test')).toBe(true);
    expect(isLoopbackBypassActive('production')).toBe(false);
    expect(isLoopbackBypassActive('development')).toBe(false);
    expect(isLoopbackBypassActive('')).toBe(false);
  });

  it('bypass allows loopback but NOT other private ranges', () => {
    expect(isBlockedIp('127.0.0.1', { allowLoopback: true })).toBe(false);
    expect(isBlockedIp('::1', { allowLoopback: true })).toBe(false);
    expect(isBlockedIp('10.0.0.1', { allowLoopback: true })).toBe(true);
    expect(isBlockedIp('192.168.1.1', { allowLoopback: true })).toBe(true);
    expect(isBlockedIp('169.254.169.254', { allowLoopback: true })).toBe(true);
  });

  it('without the bypass flag loopback stays blocked (production behavior)', () => {
    expect(isBlockedIp('127.0.0.1', { allowLoopback: false })).toBe(true);
    expect(isBlockedIp('127.0.0.1')).toBe(true); // default: no bypass
  });
});
