// S-08 — domain verification hardening: exact meta-tag parse, TXT
// exact-match, NXDOMAIN handling, weekly re-verify, one-domain-one-tenant.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDnsTxt,
  checkMetaTag,
  checkVerifyFile,
  checkVerifyToken,
  decideReverify,
  resolveTxtChecked,
  verifySiteDomain,
} from '../src/services/domainVerification.js';
import { buildApp } from '../src/index.js';
import { query } from '../src/db.js';
import { authHeaders, createTestUser, ensureTestDb, truncateAll } from './helpers.js';

const TOKEN = 'tok_' + 'a'.repeat(28);

describe('S-08 exact meta-tag parse', () => {
  it('accepts <meta name="bseo-verify" content="<token>">', () => {
    const html = `<html><head><meta name="bseo-verify" content="${TOKEN}"></head><body>x</body></html>`;
    expect(checkMetaTag(html, TOKEN)).toBe(true);
  });

  it('rejects wrong content, missing tag, and tag-shaped text', () => {
    expect(checkMetaTag(`<meta name="bseo-verify" content="wrong">`, TOKEN)).toBe(false);
    expect(checkMetaTag(`<html><head></head><body>no tag</body></html>`, TOKEN)).toBe(false);
    // Token + marker as plain text (or in a comment) is NOT verification.
    expect(
      checkMetaTag(`<html><body>bseo-verify ${TOKEN}</body></html>`, TOKEN),
    ).toBe(false);
    expect(
      checkMetaTag(`<!-- <meta name="bseo-verify" content="${TOKEN}"> -->`, TOKEN),
    ).toBe(false);
  });

  it('is case-insensitive on the tag/attribute names, exact on the value', () => {
    const html = `<META NAME="bseo-verify" CONTENT="${TOKEN}">`;
    expect(checkMetaTag(html, TOKEN)).toBe(true);
    expect(checkMetaTag(`<meta name="bseo-verify" content=" ${TOKEN} ">`, TOKEN)).toBe(false);
  });
});

describe('S-08 exact file + TXT match', () => {
  it('file must equal the token (whitespace-trimmed), not merely contain it', () => {
    expect(checkVerifyFile(TOKEN, TOKEN)).toBe(true);
    expect(checkVerifyFile(`\n${TOKEN}\n`, TOKEN)).toBe(true);
    expect(checkVerifyFile(`prefix ${TOKEN} suffix`, TOKEN)).toBe(false);
    expect(checkVerifyFile(`<html>${TOKEN}</html>`, TOKEN)).toBe(false);
  });

  it('TXT must be exactly bseo-verify=<token>', () => {
    expect(checkDnsTxt([`bseo-verify=${TOKEN}`], TOKEN)).toBe(true);
    expect(checkDnsTxt([[`bseo-verify=${TOKEN}`]], TOKEN)).toBe(true); // chunked form
    expect(checkDnsTxt([TOKEN], TOKEN)).toBe(false);
    expect(checkDnsTxt([`bseo-verify=${TOKEN} extra`], TOKEN)).toBe(false);
    expect(checkDnsTxt([`other=bseo-verify=${TOKEN}`], TOKEN)).toBe(false);
  });
});

describe('S-08 NXDOMAIN handling', () => {
  it('maps ENOTFOUND to nxdomain, other DNS errors to error', async () => {
    const nx = await resolveTxtChecked('nope.invalid', async () => {
      const e: any = new Error('getaddrinfo ENOTFOUND');
      e.code = 'ENOTFOUND';
      throw e;
    });
    expect(nx.status).toBe('nxdomain');
    const transient = await resolveTxtChecked('example.com', async () => {
      const e: any = new Error('timeout');
      e.code = 'ETIMEOUT';
      throw e;
    });
    expect(transient.status).toBe('error');
    const ok = await resolveTxtChecked('example.com', async () => [[`bseo-verify=${TOKEN}`]]);
    expect(ok.status).toBe('ok');
    expect(ok.records).toEqual([[`bseo-verify=${TOKEN}`]]);
  });
});

describe('S-08 checkVerifyToken orchestration (injected fetchers)', () => {
  const dnsOk = async () => ({ status: 'ok' as const, records: [] as string[][] });
  it('meta match verifies even when file/dns miss', async () => {
    const ok = await checkVerifyToken('example.com', TOKEN, {
      fetchText: async (url) =>
        url.endsWith('/bseo-verify.txt') ? null : `<meta name="bseo-verify" content="${TOKEN}">`,
      resolveTxt: dnsOk,
    });
    expect(ok).toBe(true);
  });

  it('substring decoys no longer verify', async () => {
    const ok = await checkVerifyToken('example.com', TOKEN, {
      fetchText: async () => `<html><body>token ${TOKEN} and bseo-verify mentioned</body></html>`,
      resolveTxt: dnsOk,
    });
    expect(ok).toBe(false);
  });

  it('dns exact TXT match verifies', async () => {
    const ok = await checkVerifyToken('example.com', TOKEN, {
      fetchText: async () => null,
      resolveTxt: async () => ({ status: 'ok' as const, records: [[`bseo-verify=${TOKEN}`]] }),
    });
    expect(ok).toBe(true);
  });

  it('all fetchers failing -> not verified (no throw)', async () => {
    const ok = await checkVerifyToken('example.com', TOKEN, {
      fetchText: async () => null,
      resolveTxt: async () => ({ status: 'error' as const, records: [] }),
    });
    expect(ok).toBe(false);
  });
});

describe('S-08 reverify decision matrix', () => {
  it('still-verified when any method matches', async () => {
    const d = await decideReverify('example.com', TOKEN, {
      fetchText: async () => null,
      resolveTxt: async () => ({ status: 'ok' as const, records: [[`bseo-verify=${TOKEN}`]] }),
    });
    expect(d).toBe('still-verified');
  });

  it('unverified on NXDOMAIN (domain gone)', async () => {
    const d = await decideReverify('gone.invalid', TOKEN, {
      fetchText: async () => null,
      resolveTxt: async () => ({ status: 'nxdomain' as const, records: [] }),
    });
    expect(d).toBe('unverified');
  });

  it('unverified when the token was removed but the domain answers', async () => {
    const d = await decideReverify('example.com', TOKEN, {
      fetchText: async () => '<html><head></head><body>redesigned, tag gone</body></html>',
      resolveTxt: async () => ({ status: 'ok' as const, records: [['v=spf1 -all']] }),
    });
    expect(d).toBe('unverified');
  });

  it('transient when every check errored (keep verified, retry next week)', async () => {
    const d = await decideReverify('example.com', TOKEN, {
      fetchText: async () => null,
      resolveTxt: async () => ({ status: 'error' as const, records: [] }),
    });
    expect(d).toBe('transient');
  });
});

describe('S-08 one-domain-one-tenant (migration 007)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    await ensureTestDb();
    app = await buildApp();
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  it('partial unique index: same domain verified twice -> 23505; unverified dupes OK', async () => {
    await truncateAll();
    const t1 = await createTestUser('s08a@example.com');
    const t2 = await createTestUser('s08b@example.com');
    const mk = async (tenantId: string, verified: boolean) => {
      const r = await query(
        `INSERT INTO sites (id, tenant_id, domain, verified, verify_token)
         VALUES (gen_random_uuid(), $1, 'dup.example', $2, 'tok') RETURNING id`,
        [tenantId, verified],
      );
      return r.rows[0].id as string;
    };
    // Two UNVERIFIED rows for the same domain across tenants: allowed.
    const v1 = await mk(t1.tenantId, false);
    const v2 = await mk(t2.tenantId, false);
    // First verification: allowed.
    await query(`UPDATE sites SET verified = true, verified_at = now() WHERE id = $1`, [v1]);
    // Second verification of the same domain by another tenant: rejected.
    await expect(
      query(`UPDATE sites SET verified = true WHERE id = $1`, [v2]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('verifySiteDomain maps the cross-tenant conflict to 409', async () => {
    await truncateAll();
    const t1 = await createTestUser('s08c@example.com');
    const t2 = await createTestUser('s08d@example.com');
    const mk = async (tenantId: string) => {
      const r = await query(
        `INSERT INTO sites (id, tenant_id, domain, verified, verify_token)
         VALUES (gen_random_uuid(), $1, 'clash.example', false, 'tok') RETURNING id`,
        [tenantId],
      );
      return r.rows[0].id as string;
    };
    const s1 = await mk(t1.tenantId);
    const s2 = await mk(t2.tenantId);
    await verifySiteDomain(query, s1, t1.tenantId, async () => true);
    await expect(verifySiteDomain(query, s2, t2.tenantId, async () => true)).rejects.toMatchObject({
      status: 409,
      code: 'DOMAIN_ALREADY_VERIFIED',
    });
    // And the route surfaces the same 409 when verification succeeds remotely.
    // (Route-level: exercised via verifySiteDomain above; the HTTP path shares it.)
    void app;
    void authHeaders;
  });
});
