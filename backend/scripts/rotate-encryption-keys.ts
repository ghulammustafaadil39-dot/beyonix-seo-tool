// S-07: encryption key rotation.
//
// Re-encrypts every stored secret (GSC refresh tokens, LLM API keys, TOTP
// secrets) from whichever key version encrypted it to the CURRENT primary
// key.
//
// Usage:
//   ENCRYPTION_KEYS="k202611:<new-hex>,k202610:<old-hex>" \
//     npx tsx scripts/rotate-encryption-keys.ts [--dry-run]
//
// The new primary key comes FIRST; old keys are retained after it so existing
// ciphertext still decrypts. --dry-run reports without writing.
// Plaintext is NEVER logged — only ids, kids, and counts.
import { config } from '../src/config.js';
import { decryptWithKeys, encryptWithKey, parseEncryptionKeys, type ParsedKeys } from '../src/crypto.js';
import { pool } from '../src/db.js';
import type { QueryFn } from '../src/db.js';

export interface RotateReport {
  table: string;
  column: string;
  total: number;
  reencrypted: number;
  alreadyCurrent: number;
  failed: number;
  failures: string[];
}

function kidOf(stored: string): string | null {
  if (stored.startsWith('enc2:')) {
    const rest = stored.slice(5);
    const idx = rest.indexOf(':');
    return idx === -1 ? null : rest.slice(0, idx);
  }
  return null; // enc:/plain: have no kid
}

/**
 * Re-encrypts one column to the new primary key. Testable with a fake QueryFn.
 */
export async function rotateColumn(
  q: QueryFn,
  table: string,
  column: string,
  _oldKeys: ParsedKeys,
  newKeys: ParsedKeys,
  opts: { dryRun?: boolean } = {},
): Promise<RotateReport> {
  const dryRun = opts.dryRun ?? false;
  const report: RotateReport = {
    table,
    column,
    total: 0,
    reencrypted: 0,
    alreadyCurrent: 0,
    failed: 0,
    failures: [],
  };
  const r = await q(`SELECT id, ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`);
  for (const row of r.rows as Array<{ id: string; v: string }>) {
    report.total += 1;
    try {
      const stored = row.v as string;
      if (kidOf(stored) === newKeys.primary.kid) {
        report.alreadyCurrent += 1;
        continue;
      }
      const plain = decryptWithKeys(stored, newKeys.byKid, { allowPlain: false });
      const reenc = encryptWithKey(plain, newKeys.primary.kid, newKeys.primary.key);
      if (!dryRun) {
        await q(`UPDATE ${table} SET ${column} = $1 WHERE id = $2`, [reenc, row.id]);
      }
      report.reencrypted += 1;
    } catch (err) {
      report.failed += 1;
      // Never log the value — only the row id and the error.
      report.failures.push(`${row.id}: ${(err as Error).message}`);
    }
  }
  return report;
}

const TARGETS: Array<[string, string]> = [
  ['sites', 'gsc_refresh_token_enc'],
  ['tenants', 'llm_api_key_enc'],
  ['users', 'totp_secret_enc'],
];

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const keys = parseEncryptionKeys(config.encryptionKeys, config.encryptionKey);
  console.log(
    `[rotate] primary kid=${keys.primary.kid}, known kids=[${[...keys.byKid.keys()].join(',')}], dryRun=${dryRun}`,
  );
  let failed = 0;
  for (const [table, column] of TARGETS) {
    const rep = await rotateColumn(pool.query.bind(pool) as QueryFn, table, column, keys, keys, { dryRun });
    console.log(
      `[rotate] ${rep.table}.${rep.column}: total=${rep.total} reencrypted=${rep.reencrypted} ` +
        `alreadyCurrent=${rep.alreadyCurrent} failed=${rep.failed}`,
    );
    for (const f of rep.failures) console.error(`[rotate] FAILED ${f}`);
    failed += rep.failed;
  }
  await pool.end();
  if (failed > 0) {
    console.error(`[rotate] ${failed} row(s) failed — investigate before removing old keys`);
    process.exit(1);
  }
  console.log('[rotate] done');
}

const isMain = process.argv[1]?.endsWith('rotate-encryption-keys.ts');
if (isMain) {
  main().catch((err) => {
    console.error('[rotate] fatal', err);
    process.exit(1);
  });
}
