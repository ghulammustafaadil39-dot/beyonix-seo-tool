// S-03: CAPTCHA hook interface for signup abuse protection.
//
// Providers: 'none' (default, no CAPTCHA), 'hcaptcha' (real verification),
// 'test' (test-only knob: accepts exactly the token 'captcha-test-pass').
// Unknown values fall back to 'none' so a typo can never silently disable
// an intended CAPTCHA — the operator sees CAPTCHA_SITEKEY documented but no
// enforcement. Fail-closed: when a real provider is configured but the
// secret is missing or verification errors, verify() returns false.
import { config } from '../config.js';

export type CaptchaProviderName = 'none' | 'hcaptcha' | 'test';

export interface CaptchaProvider {
  name: CaptchaProviderName;
  verify(token: string, remoteIp?: string): Promise<boolean>;
}

class NoneCaptchaProvider implements CaptchaProvider {
  name = 'none' as const;
  async verify(): Promise<boolean> {
    return true;
  }
}

class HCaptchaProvider implements CaptchaProvider {
  name = 'hcaptcha' as const;
  async verify(token: string, remoteIp?: string): Promise<boolean> {
    const secret = (process.env.CAPTCHA_SECRET ?? config.captchaSecret ?? '').trim();
    if (!token || !secret) return false; // fail closed
    try {
      const body = new URLSearchParams({ secret, response: token });
      if (remoteIp) body.set('remoteip', remoteIp);
      const res = await fetch('https://hcaptcha.com/siteverify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { success?: boolean };
      return data.success === true;
    } catch {
      return false; // network/parse errors fail closed
    }
  }
}

/** Test-only provider: no network, deterministic. Never enable in production. */
class TestCaptchaProvider implements CaptchaProvider {
  name = 'test' as const;
  async verify(token: string): Promise<boolean> {
    return token === 'captcha-test-pass';
  }
}

/**
 * Resolves the configured CAPTCHA provider. Reads process.env live (in
 * addition to the frozen config) so integration tests can toggle it without
 * a reboot — same pattern as the MOCK_GOOGLE_* test knobs.
 *
 * B2-L2: the 'test' provider is refused outside test/development (same
 * pattern as isMockGoogleAllowed) — one misconfigured env var must not
 * disable signup CAPTCHA in production. Falls back to 'none' with a
 * loud warning so the misconfiguration is visible.
 */
export function getCaptcha(): CaptchaProvider {
  const name = (process.env.CAPTCHA_PROVIDER ?? config.captchaProvider ?? 'none').trim().toLowerCase();
  if (name === 'hcaptcha') return new HCaptchaProvider();
  if (name === 'test') {
    if (config.nodeEnv === 'test' || config.nodeEnv === 'development') return new TestCaptchaProvider();
    console.error("[captcha] refusing CAPTCHA_PROVIDER=test outside test/development — falling back to 'none'");
    return new NoneCaptchaProvider();
  }
  return new NoneCaptchaProvider();
}

/** True when signup must present a CAPTCHA token. */
export function isCaptchaRequired(): boolean {
  return getCaptcha().name !== 'none';
}
