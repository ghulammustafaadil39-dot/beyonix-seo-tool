import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';
import { pool, runMigrations } from '../src/db.js';

/**
 * P0-01 regression: password login broke permanently after the first logout.
 * /auth/login signed the JWT with the default tv=0 without reading
 * users.token_version, while /auth/logout bumps token_version. The first
 * logout permanently revoked every future password-login token.
 *
 * Requires a real database: run with DATABASE_URL pointing at bseo_test_backend.
 */
describe('P0-01 token_version regression', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const email = `p001_${Date.now()}@example.com`;
  const password = 'correct-horse-9';

  beforeAll(async () => {
    await runMigrations();
    app = await buildApp();
    await app.ready();
  }, 60000);

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE id IN (SELECT tenant_id FROM users WHERE email = $1)', [email]);
    await app.close();
    await pool.end();
  });

  it('signup → logout → login → /auth/me succeeds, and the pre-logout token stays revoked', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email, password },
    });
    expect(signup.statusCode).toBe(201);
    const token1: string = signup.json().token;
    expect(token1).toBeTruthy();

    const me1 = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(me1.statusCode).toBe(200);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(logout.statusCode).toBe(200);

    // This is the P0-01 assertion: a fresh password login must work after logout.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
    expect(login.statusCode).toBe(200);
    const token2: string = login.json().token;
    expect(token2).toBeTruthy();

    const me2 = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(me2.statusCode).toBe(200);

    // The token issued before the logout must remain revoked.
    const meOld = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(meOld.statusCode).toBe(401);
  });
});
