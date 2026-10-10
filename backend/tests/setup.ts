// Vitest setup: per-worktree test database (LA directive — do NOT use shared bseo_test).
// Runs before test files, so src/config.ts and src/db.ts pick these up at import.
// (Local dev credentials only — same values as .env.example / docker-compose.yml.)
process.env.DATABASE_URL ??= 'postgres://bseo:bseo@localhost:5432/bseo_test_security';
process.env.REDIS_URL ??= 'redis://localhost:6379';
