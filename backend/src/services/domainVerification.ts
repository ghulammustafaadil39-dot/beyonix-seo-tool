// S-08: hardened domain verification.
//
// Every method requires an EXACT match — the old substring checks
// (html.includes(token)) could be satisfied by page text mentioning the
// token, e.g. a blog post about the verification process.
//
// Methods:
//   meta: <meta name="bseo-verify" content="<token>"> parsed with cheerio,
//         content must equal the token exactly.
//   file: https://<domain>/bseo-verify.txt must equal the token exactly
//         (surrounding whitespace trimmed).
//   dns:  a TXT record must equal exactly `bseo-verify=<token>`.
//
// NXDOMAIN (ENOTFOUND) is distinguished from transient DNS errors so the
// weekly re-verify job can unverify dead domains without dropping sites on
// a network blip.
import * as cheerio from 'cheerio';
import dns from 'node:dns';
import { safeFetch } from './safeFetch.js';
import { conflict } from '../errors.js';
import type { QueryFn } from '../db.js';

/** Exact meta-tag check: any <meta name="bseo-verify"> whose content === token. */
export function checkMetaTag(html: string, token: string): boolean {
  const $ = cheerio.load(html);
  let found = false;
  $('meta[name="bseo-verify"]').each((_, el) => {
    if ($(el).attr('content') === token) found = true;
  });
  return found;
}

/** Exact file check: the served text must BE the token (trimmed). */
export function checkVerifyFile(text: string, token: string): boolean {
  return text.trim() === token;
}

/** Exact DNS TXT check: a record must equal `bseo-verify=<token>`. */
export function checkDnsTxt(records: string[][] | string[], token: string): boolean {
  const want = `bseo-verify=${token}`;
  const flat = (records as Array<string[] | string>).map((r) => (Array.isArray(r) ? r.join('') : r));
  return flat.some((r) => r === want);
}

export type TxtStatus = 'ok' | 'nxdomain' | 'error';
export interface TxtResult {
  status: TxtStatus;
  records: string[][];
}

/**
 * Resolves TXT records, mapping DNS outcomes:
 *  - ok: records returned (possibly empty)
 *  - nxdomain: the domain does not exist (ENOTFOUND)
 *  - error: transient failure (timeout, SERVFAIL, ...) — retry later
 */
export async function resolveTxtChecked(
  domain: string,
  resolve: (domain: string) => Promise<string[][]> = (d) => dns.promises.resolveTxt(d),
): Promise<TxtResult> {
  try {
    const records = await resolve(domain);
    return { status: 'ok', records };
  } catch (err: any) {
    if (err?.code === 'ENOTFOUND') return { status: 'nxdomain', records: [] };
    return { status: 'error', records: [] };
  }
}

export interface VerifyDeps {
  /** Returns body text or null on any fetch failure. SSRF-protected. */
  fetchText?: (url: string) => Promise<string | null>;
  resolveTxt?: (domain: string) => Promise<TxtResult>;
}

async function defaultFetchText(url: string): Promise<string | null> {
  try {
    const res = await safeFetch(url, undefined, 8000);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * True when ANY method verifies the domain for the token.
 * Never throws — every failure mode is a "not verified".
 */
export async function checkVerifyToken(
  domain: string,
  token: string,
  deps: VerifyDeps = {},
): Promise<boolean> {
  const fetchText = deps.fetchText ?? defaultFetchText;
  const resolveTxt = deps.resolveTxt ?? ((d: string) => resolveTxtChecked(d));

  const [html, file, txt] = await Promise.all([
    fetchText(`https://${domain}`),
    fetchText(`https://${domain}/bseo-verify.txt`),
    resolveTxt(domain).catch((): TxtResult => ({ status: 'error', records: [] })),
  ]);

  if (html !== null && checkMetaTag(html, token)) return true;
  if (file !== null && checkVerifyFile(file, token)) return true;
  if (txt.status === 'ok' && checkDnsTxt(txt.records, token)) return true;
  return false;
}

export type ReverifyDecision = 'still-verified' | 'unverified' | 'transient';

/**
 * Weekly re-verify decision for an already-verified site:
 *  - still-verified: at least one method still matches.
 *  - unverified: the domain is gone (NXDOMAIN) OR at least one method gave a
 *    definitive "checked, token absent" answer (page/TXT fetched, no match).
 *  - transient: every check errored — keep the site verified, retry next week.
 */
export async function decideReverify(
  domain: string,
  token: string,
  deps: VerifyDeps = {},
): Promise<ReverifyDecision> {
  const fetchText = deps.fetchText ?? defaultFetchText;
  const resolveTxt = deps.resolveTxt ?? ((d: string) => resolveTxtChecked(d));

  const [html, file, txt] = await Promise.all([
    fetchText(`https://${domain}`),
    fetchText(`https://${domain}/bseo-verify.txt`),
    resolveTxt(domain).catch((): TxtResult => ({ status: 'error', records: [] })),
  ]);

  if (html !== null && checkMetaTag(html, token)) return 'still-verified';
  if (file !== null && checkVerifyFile(file, token)) return 'still-verified';
  if (txt.status === 'ok' && checkDnsTxt(txt.records, token)) return 'still-verified';

  // Definitive negative signals: the domain answers but the token is gone.
  if (txt.status === 'nxdomain') return 'unverified';
  const answered =
    html !== null || file !== null || txt.status === 'ok';
  if (answered) return 'unverified';

  return 'transient';
}

/**
 * Marks a site verified after a successful check. The partial unique index
 * (migration 007) guarantees one-domain-one-tenant: if another tenant
 * verified the same domain first, the UPDATE raises 23505, mapped to 409.
 */
export async function verifySiteDomain(
  q: QueryFn,
  siteId: string,
  tenantId: string,
  check: () => Promise<boolean>,
): Promise<boolean> {
  const ok = await check();
  if (!ok) return false;
  try {
    await q(
      `UPDATE sites SET verified = true, verified_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [siteId, tenantId],
    );
  } catch (err: any) {
    if (err?.code === '23505') {
      throw conflict(
        'DOMAIN_ALREADY_VERIFIED',
        'This domain is already verified by another workspace',
      );
    }
    throw err;
  }
  return true;
}
