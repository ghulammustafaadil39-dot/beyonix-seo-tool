// W-08: repeatable local benchmark for hot read endpoints.
// Boots the real app (inject, no network), seeds one tenant/site with
// keywords + rank history, then measures latency for:
//   GET /api/v1/sites, GET /api/v1/sites/:id/ranks, GET /api/v1/sites/:id/overview
// Usage: DATABASE_URL=... npx tsx scripts/bench-hot.ts [iterations]
import { buildApp } from '../src/index.js';
import { pool, query, runMigrations } from '../src/db.js';
import { hashPassword } from '../src/middleware/auth.js';

const ITER = Number(process.argv[2] ?? 60);

function p95(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))];
}
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  await runMigrations();
  await query(`TRUNCATE tenants CASCADE`);
  const email = `bench-${Date.now()}@example.com`;
  const pw = 'J7#kP9!mV2@qX5$zR8&';
  const t = await query(`INSERT INTO tenants (id,name,plan_id) VALUES (gen_random_uuid(),'Bench','pro') RETURNING id`);
  const tenantId = t.rows[0].id as string;
  await query(
    `INSERT INTO users (id,tenant_id,email,password_hash,name,role,email_verified_at) VALUES (gen_random_uuid(),$1,$2,$3,'Bench','owner',now())`,
    [tenantId, email, await hashPassword(pw)],
  );
  const app = await buildApp();
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: pw } });
  if (login.statusCode !== 200) throw new Error(`seed login failed: ${login.statusCode} ${login.body.slice(0, 200)}`);
  // Bearer <redacted> (cookie mutations would need the CSRF dance; bearer is exempt).
  const raw = login.headers['set-cookie'] as string[];
  const token = raw.find((c) => c.startsWith('bseo_token='))!.split(';')[0].slice('bseo_token='.length);
  const hdr = { authorization: `Bearer ${token}` };
  const siteRes = await app.inject({ method: 'POST', url: '/api/v1/sites', headers: hdr, payload: { domain: 'bench.example.com' } });
  if (siteRes.statusCode !== 201) throw new Error(`seed site failed: ${siteRes.statusCode} ${siteRes.body.slice(0, 300)}`);
  const siteId = (siteRes.json() as any).id as string;
  // Seed 50 tracked keywords x 30 rank checks + an audit with issues.
  for (let k = 0; k < 50; k++) {
    const kw = await query(
      `INSERT INTO keywords (id,tenant_id,site_id,keyword,tracked) VALUES (gen_random_uuid(),$1,$2,$3,TRUE) RETURNING id`,
      [tenantId, siteId, `bench keyword ${k}`],
    );
    for (let d = 0; d < 30; d++) {
      await query(
        `INSERT INTO rank_checks (id,tenant_id,keyword_id,position,checked_at) VALUES (gen_random_uuid(),$1,$2,$3, now() - ($4 || ' days')::interval)`,
        [tenantId, kw.rows[0].id, 5 + ((k + d) % 40), String(d)],
      );
    }
  }
  const audit = await query(
    `INSERT INTO audits (id,tenant_id,site_id,status,score,issues_count,finished_at) VALUES (gen_random_uuid(),$1,$2,'done',72,3,now()) RETURNING id`,
    [tenantId, siteId],
  );
  for (let i = 0; i < 30; i++) {
    await query(
      `INSERT INTO audit_issues (id,tenant_id,audit_id,site_id,type,severity,url,detail,fix_suggestion,status) VALUES (gen_random_uuid(),$1,$2,$3,'missing_title','error','https://bench.example.com/','d','f','open')`,
      [tenantId, audit.rows[0].id, siteId],
    );
  }

  const targets: Array<[string, string]> = [
    ['GET /sites', '/api/v1/sites'],
    ['GET /sites/:id/ranks', `/api/v1/sites/${siteId}/ranks`],
    ['GET /sites/:id/overview', `/api/v1/sites/${siteId}/overview`],
  ];
  const out: Record<string, { medianMs: number; p95Ms: number; n: number }> = {};
  for (const [label, url] of targets) {
    // warmup
    await app.inject({ method: 'GET', url, headers: hdr });
    const times: number[] = [];
    for (let i = 0; i < ITER; i++) {
      const start = performance.now();
      const res = await app.inject({ method: 'GET', url, headers: hdr });
      times.push(performance.now() - start);
      if (res.statusCode !== 200) throw new Error(`${label} -> ${res.statusCode} ${res.body}`);
    }
    out[label] = { medianMs: Number(median(times).toFixed(2)), p95Ms: Number(p95(times).toFixed(2)), n: ITER };
    console.log(`${label}: median=${out[label].medianMs}ms p95=${out[label].p95Ms}ms n=${ITER}`);
  }
  console.log(JSON.stringify({ bench: out }, null, 2));
  await app.close();
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
