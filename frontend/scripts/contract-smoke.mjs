#!/usr/bin/env node
// Contract smoke: executes the REAL frontend normalizers against fixtures
// copied from the backend emit code (lib/wireContracts.ts) and asserts the
// documented wire→UI mapping.
//
//   npm run smoke
//
// Compiles lib/{api,useJobStream,wireContracts}.ts with the workspace tsc
// into a temp dir (CommonJS) and requires the real normalizer functions —
// no reimplementation, no mocks. Fails non-zero on any mismatch.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, '..');
const tsc = path.join(frontend, 'node_modules', '.bin', 'tsc');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-smoke-'));
// Let the compiled modules resolve 'react' via normal node lookup.
fs.symlinkSync(path.join(frontend, 'node_modules'), path.join(tmp, 'node_modules'));

execFileSync(
  tsc,
  [
    'lib/api.ts',
    'lib/useJobStream.ts',
    'lib/wireContracts.ts',
    '--outDir', tmp,
    '--module', 'commonjs',
    '--target', 'es2020',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--skipLibCheck',
  ],
  { cwd: frontend, stdio: 'inherit' },
);

const require = createRequire(path.join(tmp, 'run.cjs'));
const api = require(path.join(tmp, 'api.js'));
const stream = require(path.join(tmp, 'useJobStream.js'));
const wire = require(path.join(tmp, 'wireContracts.js'));
const SITE = wire.__wireSiteId;

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra !== undefined ? ` — got: ${JSON.stringify(extra)}` : ''}`);
  }
}

console.log('SSE snapshot → aggregate view');
{
  const p = stream.normalizeJobProgress(wire.SNAPSHOT_RUNNING, { eventName: 'snapshot' });
  check('running audit: status', p?.status === 'running', p?.status);
  check('running audit: progress 50', p?.progress === 50, p?.progress);
  check('running audit: jobId/jobType', p?.jobId === 'audit-1' && p?.jobType === 'audit', p);
  check('running audit: not terminal', p?.terminal === false, p?.terminal);
  check('running audit: step has pages', typeof p?.step === 'string' && p.step.includes('41'), p?.step);
  check('running audit: rankRun informational message', typeof p?.message === 'string' && p.message.includes('informational'), p?.message);
}
{
  const p = stream.normalizeJobProgress(wire.SNAPSHOT_SETTLED_DONE, { eventName: 'snapshot' });
  check('settled done audit: terminal', p?.terminal === true, p?.terminal);
  check('settled done audit: status/progress', p?.status === 'done' && p?.progress === 100, p);
  check('settled done audit: step has score', typeof p?.step === 'string' && p.step.includes('87'), p?.step);
}
{
  const p = stream.normalizeJobProgress(wire.SNAPSHOT_EMPTY_SETTLED, { eventName: 'snapshot' });
  check('empty settled: terminal idle', p?.terminal === true && p?.step === 'No jobs running', p);
}

console.log('done / error events');
{
  const p = stream.normalizeJobProgress(wire.DONE_WIRE, { eventName: 'done' });
  check('done wire: terminal instant completion', p?.terminal === true && p?.status === 'done' && p?.progress === 100, p);
}
{
  const p = stream.normalizeJobProgress(wire.DONE_WIRE, { eventName: 'done', watchKind: 'report' });
  check('done wire: not terminal for report watchers', p === null, p);
}
{
  const p = stream.normalizeJobProgress(wire.ERROR_WIRE, { eventName: 'error' });
  check('error wire: terminal failed', p?.terminal === true && p?.status === 'failed', p);
  check('error wire: generic message surfaced', p?.error === 'internal error', p?.error);
}
{
  // A bare { message } on any other event keeps legacy free-text semantics.
  const p = stream.normalizeJobProgress({ message: 'still working' });
  check('bare message w/o eventName: not terminal', p?.terminal === false && p?.message === 'still working', p);
}

console.log('legacy fallback (jobPoll adapters)');
{
  const p = stream.normalizeJobProgress({ jobId: 'x', type: 'audit', status: 'running', progress: 0.5 });
  check('legacy fraction scaled 0.5→50', p?.progress === 50 && p?.status === 'running' && p?.terminal === false, p);
}
{
  const p = stream.normalizeJobProgress({ type: 'report', status: 'done', progress: 100, step: 'Report ready' });
  check('legacy report terminal shape', p?.terminal === true && p?.jobType === 'report', p);
}
{
  check('null/garbage → null', stream.normalizeJobProgress(null) === null && stream.normalizeJobProgress('nope') === null);
}

console.log('report watcher snapshots');
{
  const p = stream.normalizeJobProgress(wire.SNAPSHOT_REPORTS, { eventName: 'snapshot', watchKind: 'report', reportBaseline: 1 });
  check('new report: terminal ready', p?.terminal === true && p?.step === 'Report ready' && p?.jobId === 'rep-2', p);
}
{
  const p = stream.normalizeJobProgress(wire.SNAPSHOT_REPORTS, { eventName: 'snapshot', watchKind: 'report', reportBaseline: 2 });
  check('no new report: non-terminal', p?.terminal === false && p?.status === 'running', p);
}

console.log('insights envelope');
{
  const list = api.normalizeInsightList(wire.INSIGHTS_ENVELOPE);
  check('real envelope: 2 actions', list.length === 2, list.length);
  check('sorted by priority desc', list[0]?.title.includes('missing_title') && list[1]?.title.includes('rank drop'), list.map((i) => i.title));
}
{
  const f = api.normalizeForecast(wire.INSIGHTS_ENVELOPE.forecast);
  check('forecast: projection kind', f?.kind === 'projection', f?.kind);
  check('forecast: values', f?.visibilityIndexNow === 42.5 && f?.horizonDays === 28 && f?.basedOnDays === 21, f);
  check('forecast: non-projection rejected', api.normalizeForecast({ kind: 'measured' }) === null);
}
{
  const h1 = api.resolveInsightHref(SITE, wire.INSIGHTS_ENVELOPE.actions[0].target, 'rank_drop');
  check('target href ?tab=rankings → /rankings', h1 === `/dashboard/sites/${SITE}/rankings`, h1);
  const h2 = api.resolveInsightHref(SITE, wire.INSIGHTS_ENVELOPE.actions[1].target, 'critical_audit_issue');
  check('target href ?tab=audit → /audit', h2 === `/dashboard/sites/${SITE}/audit`, h2);
  const h3 = api.resolveInsightHref(SITE, { kind: 'audit' }, 'critical_audit_issue');
  check('kind-only fallback → /audit', h3 === `/dashboard/sites/${SITE}/audit`, h3);
  const h4 = api.resolveInsightHref(SITE, { kind: 'keyword', href: '//evil.example/x' }, 'rank_drop');
  check('protocol-relative href never external', h4.startsWith(`/dashboard/sites/${SITE}`) && !h4.startsWith('//'), h4);
}
{
  const legacy = api.normalizeInsightList({ data: [{ type: 'x', priority: 'high', title: 'T' }] });
  check('legacy {data} envelope', legacy.length === 1 && legacy[0]?.priority === 'high', legacy);
  const legacy2 = api.normalizeInsightList({ insights: [{ type: 'y', priority: 10, title: 'U' }] });
  check('legacy {insights} envelope', legacy2.length === 1 && legacy2[0]?.type === 'y', legacy2);
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
