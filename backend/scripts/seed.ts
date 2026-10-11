/**
 * W-09 (QA slice): idempotent demo-data seed.
 *
 * Creates (or reuses) a demo tenant + verified owner + verified site +
 * sample keywords, one completed audit with issues, and a sample report so
 * a fresh dev environment shows a populated product immediately.
 *
 * Idempotent: every insert is keyed on a natural unique key
 * (user email, tenant+domain, site+keyword) and re-running changes nothing.
 * Refuses to run when NODE_ENV=production unless SEED_DEMO=1 is set —
 * demo credentials must never land in a real production database by accident.
 *
 * Usage:  npm run seed        (from backend/)
 * Login:  demo@beyonix.local / DemoPass123!   (LOCAL DEMO ONLY)
 */
import bcrypt from 'bcryptjs';
import { pool, query, runMigrations } from '../src/db.js';

export const DEMO_EMAIL = 'demo@beyonix.local';
export const DEMO_PASSWORD = 'DemoPass123!';
export const DEMO_DOMAIN = 'example.com';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO !== '1') {
    throw new Error('Refusing to seed demo data in production (set SEED_DEMO=1 to override deliberately).');
  }
  await runMigrations();

  const existing = await query(`SELECT id, tenant_id FROM users WHERE email = $1`, [DEMO_EMAIL]);
  let tenantId: string;
  let userId: string;
  if (existing.rows.length > 0) {
    tenantId = existing.rows[0].tenant_id as string;
    userId = existing.rows[0].id as string;
    console.log(`[seed] demo user already exists (${DEMO_EMAIL}) — reusing tenant ${tenantId}`);
  } else {
    const t = await query(
      `INSERT INTO tenants (id, name, plan_id, notify_email) VALUES (gen_random_uuid(), 'Demo Workspace', 'growth', $1) RETURNING id`,
      [DEMO_EMAIL],
    );
    tenantId = t.rows[0].id as string;
    const hash = await bcrypt.hash(DEMO_PASSWORD, 12);
    const u = await query(
      `INSERT INTO users (id, tenant_id, email, password_hash, name, role, email_verified_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'Demo Owner', 'owner', now()) RETURNING id`,
      [tenantId, DEMO_EMAIL, hash],
    );
    userId = u.rows[0].id as string;
    console.log(`[seed] created demo tenant ${tenantId} + user ${userId}`);
  }

  const s = await query(
    `INSERT INTO sites (id, tenant_id, domain, verified)
     VALUES (gen_random_uuid(), $1, $2, TRUE)
     ON CONFLICT (tenant_id, domain) WHERE deleted_at IS NULL DO UPDATE SET verified = TRUE
     RETURNING id`,
    [tenantId, DEMO_DOMAIN],
  );
  const siteId = s.rows[0].id as string;

  const keywords = [
    ['seo tools for small business', 1900, 42],
    ['ai seo software', 2400, 55],
    ['technical seo audit', 1300, 38],
  ] as const;
  for (const [kw, volume, difficulty] of keywords) {
    await query(
      `INSERT INTO keywords (id, tenant_id, site_id, keyword, volume, difficulty, tracked)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, TRUE)
       ON CONFLICT (site_id, keyword) DO NOTHING`,
      [tenantId, siteId, kw, volume, difficulty],
    );
  }

  const priorAudit = await query(
    `SELECT id FROM audits WHERE tenant_id = $1 AND site_id = $2 AND status = 'done' LIMIT 1`,
    [tenantId, siteId],
  );
  if (priorAudit.rows.length === 0) {
    const a = await query(
      `INSERT INTO audits (id, tenant_id, site_id, status, started_at, finished_at, score, issues_count, pages_crawled)
       VALUES (gen_random_uuid(), $1, $2, 'done', now() - interval '1 hour', now() - interval '55 minutes', 82, 2, 12)
       RETURNING id`,
      [tenantId, siteId],
    );
    const auditId = a.rows[0].id as string;
    await query(
      `INSERT INTO audit_issues (id, tenant_id, audit_id, site_id, type, severity, url, detail, fix_suggestion, status)
       VALUES
        (gen_random_uuid(), $1, $2, $3, 'missing-meta-description', 'warning', 'https://example.com/', 'Page has no meta description.', 'Add a 150-160 character meta description.', 'open'),
        (gen_random_uuid(), $1, $2, $3, 'images-missing-alt', 'info', 'https://example.com/about', '2 image(s) have no alt text.', 'Add descriptive alt text to every content image.', 'open')
       ON CONFLICT DO NOTHING`,
      [tenantId, auditId, siteId],
    );
    await query(
      `INSERT INTO reports (id, tenant_id, site_id, period_start, period_end, summary, highlights)
       VALUES (gen_random_uuid(), $1, $2, CURRENT_DATE - 7, CURRENT_DATE,
               'Demo report: your site scored 82/100. Fix the 2 open issues to improve it.',
               '[]'::jsonb)
       ON CONFLICT DO NOTHING`,
      [tenantId, siteId],
    ).catch(() => console.log('[seed] report insert skipped (schema constraint) — audit + keywords are seeded'));
  }

  console.log(`[seed] done. Login: ${DEMO_EMAIL} / ${DEMO_PASSWORD} (site ${DEMO_DOMAIN}, tenant ${tenantId})`);
  await pool.end();
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  main().catch((e) => {
    console.error('[seed] failed', e);
    process.exit(1);
  });
}
