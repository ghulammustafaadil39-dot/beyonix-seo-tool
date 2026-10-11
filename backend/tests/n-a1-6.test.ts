// N-A1-6 — Mock Google OAuth must be gated behind explicit NODE_ENV=test|development.
// In any other environment without Google credentials, getGoogle() must fail
// closed (throw) instead of handing out the fixed mock profile.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const savedEnv: Record<string, string | undefined> = {};

function saveEnv(...keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}
function restoreEnv() {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
}

beforeEach(() => {
  vi.resetModules();
  saveEnv('NODE_ENV', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'JWT_SECRET');
});

afterEach(() => {
  restoreEnv();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('N-A1-6 mock Google OAuth gating', () => {
  it('mock provider is unreachable when NODE_ENV=production (fail closed)', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    // validateSecrets() runs at config import in production; give it a real secret.
    process.env.JWT_SECRET = '9f'.repeat(32);
    const { getGoogle, isMockGoogleAllowed } = await import('../src/providers/google.js');
    expect(isMockGoogleAllowed()).toBe(false);
    expect(() => getGoogle()).toThrow(/mock/i);
  });

  it('mock provider is unreachable in other non-dev environments (e.g. staging)', async () => {
    process.env.NODE_ENV = 'staging';
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    process.env.JWT_SECRET = '9f'.repeat(32);
    const { getGoogle, isMockGoogleAllowed } = await import('../src/providers/google.js');
    expect(isMockGoogleAllowed()).toBe(false);
    expect(() => getGoogle()).toThrow();
  });

  it('mock provider is allowed in test env, with a console warning', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getGoogle, isMockGoogleAllowed } = await import('../src/providers/google.js');
    expect(isMockGoogleAllowed()).toBe(true);
    const provider = getGoogle();
    expect(provider.isMock).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('mock provider is allowed in development env', async () => {
    process.env.NODE_ENV = 'development';
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getGoogle } = await import('../src/providers/google.js');
    expect(getGoogle().isMock).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('real provider is selected when Google credentials are configured', async () => {
    process.env.NODE_ENV = 'production';
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.JWT_SECRET = '9f'.repeat(32);
    const { getGoogle, isMockGoogleAllowed } = await import('../src/providers/google.js');
    expect(isMockGoogleAllowed()).toBe(false);
    expect(getGoogle().isMock).toBe(false);
  });
});
