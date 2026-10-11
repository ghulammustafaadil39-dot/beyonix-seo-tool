// S-05: password policy + breached-password check.
//
// Policy: min 12 chars, max 200, not on the common-password list.
// Breach check: HaveIBeenPwned k-anonymity API (only the first 5 hex chars of
// the SHA-1 ever leave the server). Fail-open on network errors so a down
// API can never block signups — the local policy still applies.
import { createHash } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

/** Curated list of the worst offenders (exact, case-insensitive match). */
export const COMMON_PASSWORDS = new Set(
  [
    'password',
    'password1',
    'password12',
    'password123',
    '123456',
    '12345678',
    '123456789',
    '1234567890',
    'qwerty',
    'qwerty123',
    'qwerty123456',
    'abc123',
    'abc123456',
    'letmein',
    'letmein123',
    'welcome',
    'welcome123',
    'admin',
    'admin123',
    'monkey',
    'dragon',
    'master',
    'sunshine',
    'princess',
    'football',
    'iloveyou',
    'trustno1',
    'superman',
    'michael',
    'shadow',
    'jesus',
    'ninja',
    'mustang',
    '123123',
    '654321',
    '111111',
    '000000',
    'passw0rd',
    'p@ssw0rd',
    'changeme',
    'changeme123',
    'test123',
    'test1234',
    'demo123',
    'demo1234',
    'beyonix',
    'beyonix123',
    'seo123',
    'seo12345',
  ].map((s) => s.toLowerCase()),
);

/** Synchronous policy checks. Returns a list of human-readable problems (empty = OK). */
export function validatePasswordPolicy(password: string): string[] {
  const problems: string[] = [];
  const pw = password ?? '';
  if (pw.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (pw.length > MAX_PASSWORD_LENGTH) {
    problems.push(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) {
    problems.push('This password is too common — choose something less guessable');
  }
  return problems;
}

type FetchFn = (url: string, init?: unknown) => Promise<{ ok: boolean; text(): Promise<string> }>;

/**
 * True when the password appears in a public breach corpus. Uses the
 * k-anonymity range API: only SHA1(password)[0:5] is sent.
 * Fail-open (false) on any network/parse error.
 */
export async function checkPasswordBreach(
  password: string,
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<boolean> {
  try {
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    const res = await fetchFn(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'user-agent': 'beyonix-seo-tool password-policy' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return false;
    const body = await res.text();
    return body.split('\n').some((line) => line.split(':')[0]?.trim().toUpperCase() === suffix);
  } catch {
    return false; // fail open: never block signup on an API outage
  }
}

/** Full async policy: local rules + breach corpus. Returns problems (empty = OK). */
export async function validatePassword(password: string): Promise<string[]> {
  const problems = validatePasswordPolicy(password);
  if (problems.length > 0) return problems;
  if (await checkPasswordBreach(password)) {
    problems.push('This password has appeared in a data breach — please choose a different one');
  }
  return problems;
}
