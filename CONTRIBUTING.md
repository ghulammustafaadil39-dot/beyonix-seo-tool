# Contributing — Beyonix SEO Tool

## Branches & worktrees

- One branch per agent/role: `agent/<role>/<topic>` (e.g. `agent/qa/wave3`).
- Use a git worktree per branch: `git worktree add .worktrees/<name> -b agent/<role>/<topic> main`.
- **Never** run `git stash`, `git reset --hard` or `git checkout` in the main
  worktree — a Wave-2 incident wiped uncommitted board edits this way. All
  three commands are only safe inside your own `.worktrees/<name>`.
- Small, frequent commits; rebase on `main` before merge. Only the
  Integrator merges to `main`, and only after: tests green, `tsc` clean,
  reviewer approval.

## Test rules (frozen contract)

- `npm test` in `backend/` runs all 3 vitest projects: `unit`
  (no DB/Redis), `integration` (real Postgres+Redis), `integration-stripe`
  (real Stripe SDK signature verification, fake test-mode keys).
- Backend tests must use `bseo_test_qa` (QA role) or your role's DB —
  never the dev `bseo` database. On this VM source
  `~/workspace/.local/qa-env.sh` first (snapshot reverts break the role password).
- Never weaken or delete a test to make it pass. `describe.runIf(HAS_*)`
  self-skip gates are the accepted pattern when a dependency is absent.
- New product code needs a test in the same commit.

## Code rules

- Strict TypeScript (no `any` in new code), `tsc --noEmit` clean.
- Every tenant-owned query carries `AND tenant_id = $n` — test via query-spy
  or integration assertion.
- Every provider call goes through `providers/` interfaces with a mock
  fallback; never throw when keys are missing (use mock).
- Every expensive action is metered; every limit enforced with a 402
  (`LIMIT_EXCEEDED`) payload.
- No secrets in logs. No hardcoded credentials.
- New env vars: declare in `backend/src/config.ts`, document in
  `.env.example`, reference in `RUNBOOK.md`.

## Docs honesty rule

Every claim in docs must match the code (the LA spot-checks). Mock-vs-real
boundaries must be stated plainly. Unrun = unclaimed — record exact blockers
instead of claiming.
