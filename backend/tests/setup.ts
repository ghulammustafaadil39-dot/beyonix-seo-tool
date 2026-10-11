// Vitest setup: per-worktree test database (LA directive — do NOT use shared bseo_test).
// Runs before test files, so src/config.ts and src/db.ts pick these up at import.
// (Local dev credentials only — same values as .env.example / docker-compose.yml.)
process.env.DATABASE_URL ??= 'postgres://bseo:bseo@localhost:5432/bseo_test_security';
process.env.REDIS_URL ??= 'redis://localhost:6379';
// S-07: unit tests exercise the real AES path (not the dev-only plain:
// fallback). Same throwaway test key as tests/integration/setup.ts.
process.env.ENCRYPTION_KEY ??= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
