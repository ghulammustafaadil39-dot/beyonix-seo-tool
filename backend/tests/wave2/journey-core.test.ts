/**
 * Wave-2 PHASE GATE — E2E user journey (core).
 *
 * One continuous journey over real HTTP (app.inject) against real
 * Postgres (bseo_test_qa) + real Redis, with mock providers (no Stripe /
 * DataForSEO / LLM keys in this env — /settings/providers proves it):
 *
 *   signup → email verify → login → create site → domain verification →
 *   onboarding reflects progress → audit run completes with issues →
 *   keyword research + tracking → rank check recorded → content
 *   brief→outline→draft→optimize → GEO run-set (simulated labeling) →
 *   white-label report build → share link create → public resolve →
 *   revoke → resolve 404.
 *
 * (Team invite + API keys live in journey-team-api.test.ts; billing in
 * journey-billing.test.ts.)
 *
 * Two seams are used DELIBERATELY and documented here (not hidden):
 *  1. Domain verification: the HTTP endpoint correctly returns
 *     verified:false for example.com (it carries no bseo meta tag — the
 *     journey asserts exactly that). Completing verification for a
 *     non-public test domain over plain HTTP is impossible by design
 *     (checkVerifyToken fetches https://<domain> via safeFetch; IP /
 *     localhost site domains are rejected by normalizeDomain in
 *     routes/sites.ts). The journey therefore completes the step through
 *     the service's documented injection seam (VerifyDeps.fetchText —
 *     the same seam tests/s-08.test.ts uses), feeding the REAL
 *     checkVerifyToken parser a fixture page whose <meta
 *     name="bseo-verify"> matches the token the API issued.
 *  2. Background jobs: no worker process runs in the integration harness,
 *     so enqueued jobs are driven by invoking the REAL BullMQ processors
 *     (crawlProcessor / rankCheckProcessor) in-process with the same job
 *     payload the API enqueued. The enqueue itself is asserted against
 *     the real Redis queue.
 *
 * Audit target: example.com — the audit pipeline crawls https://<domain>
 * via safeFetch, so the local http fixture site (tests/fixtures/
 * malicious-site) cannot be a site domain. Crawler-vs-fixture coverage
 * already exists in tests/bb-c04-crawl.test.ts. NOTE: an uncached crawl
 * pays the PageSpeed fetch timeout (90s, services/pagespeed.ts) when the
 * Google API is unreachable — hence the long timeout on the audit step.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp } from '../integration/helpers/app.js';
import { query, resetDb, uniqueEmail } from '../integration/helpers/db.js';
import { resetRedis } from '../integration/helpers/redis.js';
import { sessionTokenFromResponse } from '../helpers.js';
import { checkVerifyToken, verifySiteDomain } from '../../src/services/domainVerification.js';
import { isoWeekKey } from '../../src/routes/audit.js';
import { getQueue, QUEUES, Jobs } from '../../src/queues.js';
import { crawlProcessor } from '../../src/services/crawlJobs.js';
import { rankCheckProcessor } from '../../src/services/rankJobs.js';

let app: FastifyInstance;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

interface JourneyUser {
  email: string;
  password: string;
  token: string;
  tenantId: string;
  userId: string;
  verifyToken: string;
}

async function signupRaw(email: string): Promise<JourneyUser> {
  // Unique password per signup: the S-05 breach check consults the HIBP
  // corpus, so fixed test passwords can be rejected (see tests/c-01).
  const password = `Gate!${Date.now()}${Math.floor(Math.random() * 1e9)}xQ9#Zz`;
  const s = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, password, name: 'Gate Journey' },
  });
  expect(s.statusCode).toBe(201);
  const body = s.json() as any;
  return {
    email,
    password,
    token: sessionTokenFromResponse(s),
    tenantId: body.tenant.id as string,
    userId: body.user.id as string,
    verifyToken: body.verifyToken as string,
  };
}

async function verifyEmail(u: JourneyUser): Promise<void> {
  const v = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/email/verify',
    payload: { token: u.verifyToken },
  });
  expect(v.statusCode).toBe(200);
}

// ---- shared journey state (the its below are one continuous story) ----
let owner: JourneyUser;
let siteId: string;
let auditId: string;
let keywordId: string;
let keywordText: string;
let pieceId: string;
let reportId: string;
let shareToken: string;
let shareId: string;

beforeAll(async () => {
  await resetDb();
  await resetRedis();
  app = await buildTestApp();
}, 60000);

afterAll(async () => {
  await app?.close();
});

describe('Wave-2 gate: core user journey', () => {
  it('signup → email verify → login → /auth/me bound to the same tenant', async () => {
    owner = await signupRaw(uniqueEmail('gatecore'));
    expect(owner.verifyToken).toMatch(/^[0-9a-f]{64}$/);

    await verifyEmail(owner);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: owner.email, password: owner.password },
    });
    expect(login.statusCode).toBe(200);
    // JWT-in-body fix: session token arrives ONLY via the httpOnly cookie.
    expect((login.json() as any).token).toBeUndefined();
    const loginToken = sessionTokenFromResponse(login);
    owner = { ...owner, token: loginToken };

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: auth(owner.token) });
    expect(me.statusCode).toBe(200);
    expect((me.json() as any).tenant.id).toBe(owner.tenantId);
    expect((me.json() as any).user.email).toBe(owner.email);
  }, 60000);

  it('create site → verify endpoint issues token (honest verified:false) → verification completes via the S-08 seam', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sites',
      headers: auth(owner.token),
      payload: { domain: 'example.com' },
    });
    expect(created.statusCode).toBe(201);
    siteId = (created.json() as any).id as string;
    expect((created.json() as any).verified).toBe(false);

    const attempt = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/verify`,
      headers: auth(owner.token),
      payload: { method: 'meta' },
    });
    expect(attempt.statusCode).toBe(200);
    const attemptBody = attempt.json() as any;
    expect(typeof attemptBody.token).toBe('string');
    expect(attemptBody.instructions).toContain(attemptBody.token);
    // example.com carries no bseo-verify tag: the endpoint must NOT claim success.
    expect(attemptBody.verified).toBe(false);

    // Complete the step through the documented VerifyDeps seam: the real
    // exact-match parser sees a fixture page carrying the issued token.
    const token = attemptBody.token as string;
    const ok = await verifySiteDomain(query, siteId, owner.tenantId, () =>
      checkVerifyToken('example.com', token, {
        fetchText: async (url) =>
          url.endsWith('/bseo-verify.txt')
            ? null
            : `<html><head><meta name="bseo-verify" content="${token}"></head><body>fixture</body></html>`,
        resolveTxt: async () => ({ status: 'ok' as const, records: [] as string[][] }),
      }),
    );
    expect(ok).toBe(true);

    const site = await app.inject({ method: 'GET', url: `/api/v1/sites/${siteId}`, headers: auth(owner.token) });
    expect((site.json() as any).verified).toBe(true);
  }, 60000);

  it('onboarding reflects progress (verify_site step)', async () => {
    const before = await app.inject({
      method: 'GET',
      url: `/api/v1/account/sites/${siteId}/onboarding`,
      headers: auth(owner.token),
    });
    expect(before.statusCode).toBe(200);
    const stepsBefore = (before.json() as any).steps as Array<{ step: string; completed: boolean }>;
    expect(stepsBefore.map((s) => s.step)).toEqual([
      'verify_site',
      'connect_gsc',
      'first_crawl',
      'add_keywords',
      'first_report',
    ]);
    expect(stepsBefore.every((s) => s.completed === false)).toBe(true);

    const put = await app.inject({
      method: 'PUT',
      url: `/api/v1/account/sites/${siteId}/onboarding`,
      headers: auth(owner.token),
      payload: { step: 'verify_site', completed: true },
    });
    expect(put.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/account/sites/${siteId}/onboarding`,
      headers: auth(owner.token),
    });
    const stepsAfter = (after.json() as any).steps as Array<{ step: string; completed: boolean }>;
    expect(stepsAfter.find((s) => s.step === 'verify_site')?.completed).toBe(true);
    expect(stepsAfter.find((s) => s.step === 'first_crawl')?.completed).toBe(false);
  }, 60000);

  it('audit run: POST enqueues a real crawl job → processor completes it with issues', async () => {
    const post = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/audits`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(post.statusCode).toBe(201);
    auditId = (post.json() as any).audit.id as string;
    expect((post.json() as any).audit.status).toBe('queued');

    // The job really landed on the BullMQ crawl queue in Redis.
    // SEC-REVIEW (Wave-4): jobId is unique per audit row
    // (crawl:<auditId>:<week> — BullMQ needs the 3-part shape; a
    // site+week-scoped key would let BullMQ dedupe silently orphan a
    // second same-week audit).
    const job = await getQueue(QUEUES.crawl).getJob(`crawl:${auditId}:${isoWeekKey()}`);
    expect(job).toBeTruthy();
    expect(job?.name).toBe(Jobs.CRAWL_SITE);

    // Drive the real worker processor with the enqueued payload.
    const result = (await crawlProcessor({
      name: Jobs.CRAWL_SITE,
      data: { siteId, tenantId: owner.tenantId, auditId },
    } as any)) as any;
    expect(result.auditId).toBe(auditId);
    expect(result.pagesCrawled).toBeGreaterThanOrEqual(1);
    expect(result.issuesCount).toBeGreaterThanOrEqual(1);

    const got = await app.inject({ method: 'GET', url: `/api/v1/audits/${auditId}`, headers: auth(owner.token) });
    expect(got.statusCode).toBe(200);
    expect((got.json() as any).audit.status).toBe('done');
    expect((got.json() as any).audit.issues_count).toBeGreaterThanOrEqual(1);
    expect((got.json() as any).audit.score).not.toBeNull();

    const issues = await app.inject({
      method: 'GET',
      url: `/api/v1/audits/${auditId}/issues`,
      headers: auth(owner.token),
    });
    expect(issues.statusCode).toBe(200);
    expect((issues.json() as any).data.length).toBeGreaterThanOrEqual(1);

    await app.inject({
      method: 'PUT',
      url: `/api/v1/account/sites/${siteId}/onboarding`,
      headers: auth(owner.token),
      payload: { step: 'first_crawl', completed: true },
    });
  }, 300000);

  it('keyword research (mock provider) → add tracking → usage metered', async () => {
    const research = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/keywords/research`,
      headers: auth(owner.token),
      payload: { seeds: ['seo audit'] },
    });
    expect(research.statusCode).toBe(200);
    const rows = (research.json() as any).data as any[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    keywordId = rows[0].id as string;
    keywordText = rows[0].keyword as string;
    expect(typeof rows[0].volume).toBe('number');

    const track = await app.inject({
      method: 'POST',
      url: `/api/v1/keywords/${keywordId}/track`,
      headers: auth(owner.token),
    });
    expect(track.statusCode).toBe(200);
    expect((track.json() as any).keyword.tracked).toBe(true);

    const tracked = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${siteId}/keywords?tracked=true`,
      headers: auth(owner.token),
    });
    expect((tracked.json() as any).data.some((k: any) => k.id === keywordId)).toBe(true);

    // Research is metered as keyword_metric usage.
    const usage = await query(
      `SELECT COALESCE(SUM(units),0)::int AS u FROM usage_events WHERE tenant_id = $1 AND event_type = 'keyword_metric'`,
      [owner.tenantId],
    );
    expect(Number(usage.rows[0].u)).toBeGreaterThanOrEqual(1);

    await app.inject({
      method: 'PUT',
      url: `/api/v1/account/sites/${siteId}/onboarding`,
      headers: auth(owner.token),
      payload: { step: 'add_keywords', completed: true },
    });
  }, 60000);

  it('rank check: refresh enqueues → processor records a rank_checks row', async () => {
    const refresh = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/ranks/refresh`,
      headers: auth(owner.token),
    });
    expect(refresh.statusCode).toBe(200);
    expect((refresh.json() as any).queued).toBe(true);

    const res = (await rankCheckProcessor({
      name: Jobs.RANK_CHECK,
      data: { siteId, tenantId: owner.tenantId },
    } as any)) as any;
    expect(res.checked).toBeGreaterThanOrEqual(1);

    const dbRows = await query(`SELECT position, checked_at FROM rank_checks WHERE keyword_id = $1 AND tenant_id = $2`, [
      keywordId,
      owner.tenantId,
    ]);
    expect(dbRows.rows.length).toBeGreaterThanOrEqual(1);
    expect(dbRows.rows[0].checked_at).not.toBeNull();

    const ranks = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${siteId}/ranks`,
      headers: auth(owner.token),
    });
    expect(ranks.statusCode).toBe(200);
    const row = (ranks.json() as any).data.find((r: any) => r.keyword_id === keywordId);
    expect(row).toBeTruthy();
    expect(row.checked_at).not.toBeNull();
    // Position is a number when ranked, null when "not in top 100" — both
    // are honest outcomes of the mock SERP; the check itself is the proof.
    expect(row.position === null || typeof row.position === 'number').toBe(true);
  }, 120000);

  it('content piece: brief → outline → draft → optimize', async () => {
    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/content`,
      headers: auth(owner.token),
      payload: {
        title: 'SEO Audit Guide',
        keywordId,
        brief: 'A practical guide for small businesses covering the basics of SEO audits and fixes.',
      },
    });
    expect(created.statusCode).toBe(201);
    pieceId = (created.json() as any).id as string;
    expect((created.json() as any).status).toBe('brief');

    const outline = await app.inject({
      method: 'POST',
      url: `/api/v1/content/${pieceId}/outline`,
      headers: auth(owner.token),
    });
    expect(outline.statusCode).toBe(200);
    expect((outline.json() as any).status).toBe('outline');
    expect(((outline.json() as any).outline as string).length).toBeGreaterThan(50);

    const toDraft = await app.inject({
      method: 'PATCH',
      url: `/api/v1/content/${pieceId}/status`,
      headers: auth(owner.token),
      payload: { status: 'draft' },
    });
    expect(toDraft.statusCode).toBe(200);
    expect((toDraft.json() as any).status).toBe('draft');

    const draftText =
      'An SEO audit checks titles, meta descriptions, headings, internal links and site speed. ' +
      'Start with a crawl, fix missing titles and broken links, then re-check rankings every week.';
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/content/${pieceId}`,
      headers: auth(owner.token),
      payload: { draft: draftText },
    });
    expect(patch.statusCode).toBe(200);

    const optimize = await app.inject({
      method: 'POST',
      url: `/api/v1/content/${pieceId}/optimize`,
      headers: auth(owner.token),
    });
    expect(optimize.statusCode).toBe(200);
    expect((optimize.json() as any).keyword).toBe(keywordText);
    expect(typeof (optimize.json() as any).coveragePct).toBe('number');
  }, 180000);

  it('GEO run-set: simulated labeling is present in the API response', async () => {
    const prompt = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/geo/prompts`,
      headers: auth(owner.token),
      payload: { prompt: 'best seo audit tools for small business' },
    });
    expect(prompt.statusCode).toBe(200);

    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/geo/run-set`,
      headers: auth(owner.token),
      payload: { engines: ['chatgpt', 'perplexity'] },
    });
    expect(run.statusCode).toBe(200);
    const body = run.json() as any;
    // Honesty contract (F-05): simulated data must be labeled as such.
    expect(body.simulated).toBe(true);
    expect(body.disclaimer).toMatch(/simulat/i);
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    for (const check of body.results[0].checks as any[]) {
      expect(check.simulated).toBe(true);
    }

    const geo = await app.inject({ method: 'GET', url: `/api/v1/sites/${siteId}/geo`, headers: auth(owner.token) });
    expect(geo.statusCode).toBe(200);
    expect((geo.json() as any).simulated).toBe(true);
    expect((geo.json() as any).checks.length).toBeGreaterThanOrEqual(2);
    expect((geo.json() as any).checks.every((c: any) => c.simulated === true)).toBe(true);
  }, 120000);

  it('white-label report build → share link → public resolve → revoke → resolve 404', async () => {
    const branding = await app.inject({
      method: 'PUT',
      url: '/api/v1/branding',
      headers: auth(owner.token),
      payload: { company_name: 'Gate Client Co', primary_color: '#123456' },
    });
    expect(branding.statusCode).toBe(200);
    expect((branding.json() as any).company_name).toBe('Gate Client Co');

    const build = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/reports/build`,
      headers: auth(owner.token),
      payload: { sections: ['executive', 'audit', 'geo'], periodDays: 7 },
    });
    expect(build.statusCode).toBe(200);
    reportId = (build.json() as any).id as string;
    // White-label: the tenant branding is baked into the built report.
    expect((build.json() as any).branding.company_name).toBe('Gate Client Co');

    await app.inject({
      method: 'PUT',
      url: `/api/v1/account/sites/${siteId}/onboarding`,
      headers: auth(owner.token),
      payload: { step: 'first_report', completed: true },
    });
    const onboarding = await app.inject({
      method: 'GET',
      url: `/api/v1/account/sites/${siteId}/onboarding`,
      headers: auth(owner.token),
    });
    const steps = (onboarding.json() as any).steps as Array<{ step: string; completed: boolean }>;
    for (const s of ['verify_site', 'first_crawl', 'add_keywords', 'first_report']) {
      expect(steps.find((x) => x.step === s)?.completed).toBe(true);
    }

    const share = await app.inject({
      method: 'POST',
      url: `/api/v1/reports/${reportId}/share`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(share.statusCode).toBe(201);
    shareToken = (share.json() as any).token as string;
    expect(shareToken).toBeTruthy();
    expect((share.json() as any).url).toContain(`/shared/reports/${shareToken}`);

    // Public resolve: NO auth — the token is the credential. The shared
    // report is rendered as white-label HTML (by design, cf. bb-f08):
    // the client's company name replaces Beyonix branding in the page.
    const pub = await app.inject({ method: 'GET', url: `/api/v1/shared/reports/${shareToken}` });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['content-type']).toContain('text/html');
    expect(pub.body).toContain('Gate Client Co');
    expect(pub.body).toContain('example.com');

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/reports/${reportId}/shares`,
      headers: auth(owner.token),
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as any).data as any[];
    expect(items.length).toBeGreaterThanOrEqual(1);
    shareId = items[0].id as string;
    // The management list must never leak the token or its hash.
    expect(items[0]).not.toHaveProperty('token');
    expect(items[0]).not.toHaveProperty('token_hash');

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/reports/${reportId}/shares/${shareId}`,
      headers: auth(owner.token),
    });
    expect(revoke.statusCode).toBe(204);

    const gone = await app.inject({ method: 'GET', url: `/api/v1/shared/reports/${shareToken}` });
    expect(gone.statusCode).toBe(404);
  }, 120000);

  it('honesty: CMS publish is labeled mock (nothing published) + backlink toxic flags are labeled heuristic', async () => {
    const publish = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/publish`,
      headers: auth(owner.token),
      payload: { pieceId, target: 'wordpress', siteUrl: 'https://example.com', username: 'gate', appPassword: 'gate' },
    });
    expect(publish.statusCode).toBe(200);
    // CMS_PUBLISH_ENABLED is off in this env: the API must say mock and
    // must not pretend the piece went live.
    expect((publish.json() as any).mock).toBe(true);
    expect((publish.json() as any).message).toMatch(/mock/i);

    const csv = [
      'source_url,target_url',
      'https://goodblog.example/post,https://example.com/',
      'https://cheap-backlinks.xyz/buy,https://example.com/pricing',
    ].join('\n');
    const upload = await app.inject({
      method: 'POST',
      url: `/api/v1/sites/${siteId}/backlinks/upload`,
      headers: auth(owner.token),
      payload: { csv },
    });
    expect(upload.statusCode).toBe(200);
    expect((upload.json() as any).imported).toBe(2);
    expect((upload.json() as any).toxic_heuristic).toBe(true);

    const toxic = await app.inject({
      method: 'GET',
      url: `/api/v1/sites/${siteId}/backlinks/toxic`,
      headers: auth(owner.token),
    });
    expect(toxic.statusCode).toBe(200);
    expect((toxic.json() as any).heuristic).toBe(true);
    expect((toxic.json() as any).note).toMatch(/heuristic/i);
  }, 60000);

  it('honesty: /settings/providers labels every provider mock/real in this env', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/settings/providers', headers: auth(owner.token) });
    expect(res.statusCode).toBe(200);
    const providers = (res.json() as any).providers as Array<{ name: string; impl: string; mode: string }>;
    const byName = new Map(providers.map((p) => [p.name, p]));
    // No provider keys are configured in the gate env: these MUST say mock.
    expect(byName.get('payments')?.mode).toBe('mock');
    expect(byName.get('keyword_serp')?.mode).toBe('mock');
    expect(byName.get('llm')?.mode).toBe('mock');
    expect(byName.get('google')?.mode).toBe('mock');
    for (const p of providers) {
      expect(['mock', 'real']).toContain(p.mode);
      expect(typeof p.impl).toBe('string');
    }
  }, 60000);
});
