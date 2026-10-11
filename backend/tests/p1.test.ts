import { describe, expect, it } from 'vitest';
import { encrypt, decrypt } from '../src/crypto.js';
import { hashPassword, verifyPassword } from '../src/middleware/auth.js';
import { normalizeDomain } from '../src/routes/sites.js';
import { ApiError, errorEnvelope } from '../src/errors.js';
import { assertLimit, checkLimit, type LimitCheck } from '../src/metering.js';
import { applyPaymentEvent } from '../src/providers/stripe.js';
import type { QueryFn } from '../src/db.js';

describe('crypto encrypt/decrypt', () => {
  it('round-trips a value', () => {
    const enc = encrypt('refresh-token-123');
    expect(enc).not.toBe('refresh-token-123');
    expect(decrypt(enc)).toBe('refresh-token-123');
  });

  it('round-trips unicode', () => {
    const v = 'päßwörd-✓-token';
    expect(decrypt(encrypt(v))).toBe(v);
  });
});

describe('password hashing', () => {
  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('supersecret1');
    expect(hash).not.toBe('supersecret1');
    expect(await verifyPassword('supersecret1', hash)).toBe(true);
    expect(await verifyPassword('wrongpass', hash)).toBe(false);
  });
});

describe('normalizeDomain', () => {
  it.each([
    ['https://Example.com/blog', 'example.com'],
    ['HTTP://WWW.Example.com:8080/path?q=1#frag', 'www.example.com'],
    ['example.com.', 'example.com'],
    ['  Example.COM/ ', 'example.com'],
    ['sub.domain.co.uk', 'sub.domain.co.uk'],
    ['www.example.com', 'www.example.com'], // www kept as typed
    ['http://example.com/bseo-verify.txt', 'example.com'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each(['', 'not a domain', 'http://', 'foo_bar.com', 'a'.repeat(260) + '.com', 'localhost'])(
    'throws INVALID_DOMAIN for %s',
    (input) => {
      try {
        normalizeDomain(input);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(400);
        expect((err as ApiError).code).toBe('INVALID_DOMAIN');
      }
    },
  );
});

describe('metering limits', () => {
  it('checkLimit reports usage against the plan limit with a fake query', async () => {
    const fake: QueryFn = async (text) => {
      if (text.includes('FROM sites')) return { rows: [{ c: 1 }], rowCount: 1 };
      throw new Error('unexpected query: ' + text);
    };
    const check = await checkLimit('tenant-1', 'starter', 'sites', fake);
    expect(check.used).toBe(1);
    expect(check.limit).toBe(1); // starter max_sites
    expect(check.ok).toBe(false); // 1 used of 1 allowed -> full
  });

  it('checkLimit ok when under the limit', async () => {
    const fake: QueryFn = async (text) => {
      if (text.includes('FROM sites')) return { rows: [{ c: 0 }], rowCount: 1 };
      throw new Error('unexpected query: ' + text);
    };
    const check = await checkLimit('tenant-1', 'growth', 'sites', fake);
    expect(check.ok).toBe(true);
    expect(check.limit).toBe(3); // growth max_sites
  });

  it('assertLimit throws 402 LIMIT_EXCEEDED with upgrade:true', () => {
    const check: LimitCheck = { ok: false, used: 1, limit: 1, kind: 'sites' };
    try {
      assertLimit(check);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const api = err as ApiError;
      expect(api.status).toBe(402);
      expect(api.code).toBe('LIMIT_EXCEEDED');
      expect(api.extra.upgrade).toBe(true);
      expect(api.extra.used).toBe(1);
      expect(api.extra.limit).toBe(1);
    }
  });

  it('assertLimit does not throw when ok', () => {
    expect(() => assertLimit({ ok: true, used: 0, limit: 1, kind: 'sites' })).not.toThrow();
  });
});

describe('applyPaymentEvent', () => {
  it('checkout.session.completed runs only tenant-scoped SQL (metadata path)', async () => {
    const seen: string[] = [];
    const fake: QueryFn = async (text) => {
      seen.push(text);
      return { rows: [], rowCount: 1 };
    };
    await applyPaymentEvent(
      {
        type: 'checkout.session.completed',
        data: { metadata: { tenantId: 'tenant-abc', planId: 'growth' }, customer: 'cus_1', subscription: 'sub_1' },
      },
      fake,
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const sql of seen) {
      // every statement references the tenant (tenant_id column or tenants table)
      expect(sql.toLowerCase()).toMatch(/tenant/);
    }
  });

  it('checkout.session.completed resolves tenant via customer lookup (lookup path)', async () => {
    const seen: string[] = [];
    const fake: QueryFn = async (text) => {
      seen.push(text);
      if (text.includes('FROM tenants')) return { rows: [{ id: 'tenant-xyz' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    await applyPaymentEvent(
      {
        type: 'checkout.session.completed',
        data: { customer: 'cus_mock_1', subscription: 'sub_mock_9' },
      },
      fake,
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const sql of seen) {
      expect(sql.toLowerCase()).toMatch(/tenant/);
    }
  });

  it('ignores unknown event types without touching the DB', async () => {
    const seen: string[] = [];
    const fake: QueryFn = async (text) => {
      seen.push(text);
      return { rows: [], rowCount: 1 };
    };
    await applyPaymentEvent({ type: 'invoice.paid', data: {} }, fake);
    expect(seen).toEqual([]);
  });
});

describe('ApiError envelope', () => {
  it('shapes the error envelope with code, message and extras', () => {
    const { status, body } = errorEnvelope(new ApiError(400, 'EMAIL_EXISTS', 'Email already registered', { a: 1 }));
    expect(status).toBe(400);
    expect(body).toEqual({ ok: false, error: { code: 'EMAIL_EXISTS', message: 'Email already registered', a: 1 } });
  });

  it('maps unknown errors to 500 INTERNAL', () => {
    const { status, body } = errorEnvelope(new Error('boom'));
    expect(status).toBe(500);
    expect(body).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'boom' } });
  });
});
