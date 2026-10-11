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
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
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
