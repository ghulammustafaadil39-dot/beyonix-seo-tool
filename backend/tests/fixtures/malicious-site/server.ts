/**
 * Malicious-site fixture for crawler/security tests (Q-01(e)).
 *
 * Serves the exact attack shapes the Wave 0 audit verified the crawler has
 * no defense against:
 *  - N-A2-5: gzip bomb + huge plain page (no response-size cap; `res.text()`)
 *  - S-02:   SSRF attempts via redirect hops (cloud metadata, loopback,
 *             private IP, file://)
 *  - Q-01(e): redirect loops
 *
 * TESTABILITY GAP (filed to LA): `safeFetch` blocks loopback/private IPs,
 * so `crawlSite`/`safeFetch` cannot fetch this loopback fixture as-is.
 * Live crawler-vs-fixture tests need an S-02-provided test hook (e.g. an
 * allow-list honored only under NODE_ENV=test). Until then, the raw HTML
 * fixtures below are exercised via `analyzePage` directly, and the HTTP
 * routes are ready for the day the hook exists.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';

export const FIXTURE_PORT = 4799;

/** ~256 MB of zeros; gzips to ~260 KB. Decompressing it OOMs an uncapped reader. */
function gzipBombBody(): Buffer {
  return gzipSync(Buffer.alloc(256 * 1024 * 1024, 0x30));
}

/** 32 MB of repetitive HTML — no compression involved. */
function hugePageBody(): string {
  const row = `<div class="filler"><p>${'lorem ipsum dolor sit amet '.repeat(40)}</p></div>\n`;
  const rows = row.repeat(30000); // ≈ 33 MB
  return `<!doctype html><html><head><title>Huge</title></head><body><h1>Huge page</h1>\n${rows}</body></html>`;
}

const INDEX = `<!doctype html><html><head><title>Fixture index</title></head><body>
<h1>Malicious-site fixture</h1>
<ul>
<li><a href="/gzip-bomb">gzip bomb</a></li>
<li><a href="/huge">huge page (32 MB)</a></li>
<li><a href="/redirect-loop/a">redirect loop</a></li>
<li><a href="/redirect-ssrf/metadata">redirect → cloud metadata</a></li>
<li><a href="/redirect-ssrf/loopback">redirect → loopback</a></li>
<li><a href="/redirect-ssrf/internal">redirect → private IP</a></li>
<li><a href="/redirect-ssrf/file">redirect → file://</a></li>
<li><a href="/ok">control page (small, valid)</a></li>
</ul>
</body></html>`;

const CONTROL = `<!doctype html><html><head><title>Control</title>
<meta name="description" content="A small valid page"></head>
<body><h1>Control page</h1><p>Nothing malicious here.</p>
<a href="/">home</a></body></html>`;

/** Raw HTML fixtures for direct `analyzePage` tests (no network needed). */
export const MALICIOUS_HTML = {
  /** Deeply nested DOM (parser/stack stress). */
  deepNest: (() => {
    let s = '<!doctype html><html><body>';
    for (let i = 0; i < 5000; i++) s += '<div>';
    s += 'deep';
    for (let i = 0; i < 5000; i++) s += '</div>';
    return s + '</body></html>';
  })(),
  /** Extremely wide DOM (many siblings). */
  wide: (() => {
    let s = '<!doctype html><html><body><div>';
    for (let i = 0; i < 200000; i++) s += '<span>x</span>';
    return s + '</div></body></html>';
  })(),
  /** Script-heavy page (XSS-shaped content the sanitizer must neutralize). */
  xssShaped:
    '<!doctype html><html><body><h1>t</h1>' +
    '<script>alert(document.cookie)</script>' +
    '<img src=x onerror=alert(1)>' +
    '<a href="javascript:alert(2)">click</a></body></html>',
};

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, 'Content-Type': 'text/plain' });
  res.end('redirecting');
}

export function startFixtureSite(port: number = FIXTURE_PORT): Promise<Server> {
  const bomb = gzipBombBody();
  const huge = hugePageBody();
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://fixture/');
      switch (url.pathname) {
        case '/':
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(INDEX);
          break;
        case '/ok':
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(CONTROL);
          break;
        case '/robots.txt':
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('User-agent: *\nAllow: /\n');
          break;
        case '/sitemap.xml':
          res.writeHead(200, { 'Content-Type': 'application/xml' });
          res.end('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
          break;
        case '/gzip-bomb':
          // ~260 KB on the wire, ~256 MB after inflate. No size cap today (N-A2-5).
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'Content-Encoding': 'gzip',
            'Content-Length': bomb.length,
          });
          res.end(bomb);
          break;
        case '/huge':
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(huge) });
          res.end(huge);
          break;
        case '/redirect-loop/a':
          redirect(res, '/redirect-loop/b');
          break;
        case '/redirect-loop/b':
          redirect(res, '/redirect-loop/a');
          break;
        case '/redirect-ssrf/metadata':
          redirect(res, 'http://169.254.169.254/latest/meta-data/iam/security-credentials/');
          break;
        case '/redirect-ssrf/loopback':
          redirect(res, 'http://127.0.0.1:9/admin');
          break;
        case '/redirect-ssrf/internal':
          redirect(res, 'http://192.168.1.1/');
          break;
        case '/redirect-ssrf/file':
          redirect(res, 'file:///etc/passwd');
          break;
        default:
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export function stopFixtureSite(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Route manifest: path → attack shape (used by Wave 3 tests). */
export const FIXTURE_ROUTES: Array<{ path: string; shape: string; expectAfterFix: string }> = [
  { path: '/gzip-bomb', shape: 'gzip bomb (~260 KB → ~256 MB)', expectAfterFix: 'fetch aborts with a size-cap error; worker stays alive' },
  { path: '/huge', shape: '32 MB plain HTML', expectAfterFix: 'fetch aborts with a size-cap error' },
  { path: '/redirect-loop/a', shape: 'A ↔ B redirect loop', expectAfterFix: 'stops after max redirects with an error, no hang' },
  { path: '/redirect-ssrf/metadata', shape: '302 → cloud metadata IP', expectAfterFix: 'safeFetch blocks the hop (SSRF blocked)' },
  { path: '/redirect-ssrf/loopback', shape: '302 → 127.0.0.1', expectAfterFix: 'safeFetch blocks the hop (SSRF blocked)' },
  { path: '/redirect-ssrf/internal', shape: '302 → 192.168.1.1', expectAfterFix: 'safeFetch blocks the hop (SSRF blocked)' },
  { path: '/redirect-ssrf/file', shape: '302 → file:///etc/passwd', expectAfterFix: 'safeFetch blocks the hop (protocol not allowed)' },
  { path: '/ok', shape: 'control page', expectAfterFix: 'crawls normally (200, analyzed)' },
];
