import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30000,
    // Per-worktree test database default (LA directive): runs before any src
    // import so config/db pick it up. Overridable via env; QA's integration
    // setup.ts takes precedence for the integration projects.
    setupFiles: ['./tests/setup.ts'],
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/*.test.ts'],
          // NOTE: root test options are not inherited by projects in this
          // setup — declare explicitly so unit tests get the per-worktree
          // test env and the intended 30s timeout (bcrypt-heavy tests).
          setupFiles: ['./tests/setup.ts'],
          testTimeout: 30000,
          // LA decision: several unit files truncate shared tables in
          // beforeEach (s-01/s-03/s-04/s-05/s-08). Parallel workers race on
          // the shared test DB → flaky failures. Serialize unit files.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        test: {
          name: 'integration',
          // Wave-2 QA tests (tests/wave2/) run in this project too: real
          // Postgres + Redis via the integration setup files. Single worker
          // keeps files sequential on the shared test DB.
          include: ['tests/integration/**/*.test.ts', 'tests/wave2/**/*.test.ts', 'tests/wave3/**/*.test.ts'],
          exclude: ['tests/integration/stripe/**'],
          setupFiles: ['./tests/integration/setup.ts'],
          // Integration tests share one Postgres DB + one Redis DB; keep a
          // single worker per project so files run sequentially.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        test: {
          name: 'integration-stripe',
          include: ['tests/integration/stripe/**/*.test.ts'],
          setupFiles: ['./tests/integration/setup.stripe.ts'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
    ],
  },
});
