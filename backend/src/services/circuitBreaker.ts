import type { Redis } from 'ioredis';
import { getRedis, redisKeyPrefix } from '../redis.js';

export interface CircuitOpts {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before a half-open probe. */
  resetTimeoutMs: number;
  /** Successful half-open probes needed to close (default 1). */
  halfOpenSuccesses?: number;
}

export class CircuitOpenError extends Error {
  constructor(public readonly circuit: string) {
    super(`Circuit breaker open for ${circuit} — backing off`);
    this.name = 'CircuitOpenError';
  }
}

type State = 'closed' | 'open' | 'half-open';

/**
 * Redis-backed circuit breaker (C-03: backpressure on provider 429s/5xx).
 * State is shared across API/worker processes via Redis so one hot provider
 * trips the breaker for everyone, and `exec()` throws CircuitOpenError
 * instead of hammering the failing provider.
 */
export class CircuitBreaker {
  private redis: Redis;
  private key: string;
  private halfOpenSuccesses: number;

  constructor(
    private readonly name: string,
    private readonly opts: CircuitOpts,
    redis?: Redis,
  ) {
    this.redis = redis ?? getRedis();
    this.key = `${redisKeyPrefix()}circuit:${name}`;
    this.halfOpenSuccesses = opts.halfOpenSuccesses ?? 1;
  }

  private async read(): Promise<{ state: State; failures: number; openedAt: number; probes: number }> {
    const h = (await this.redis.hgetall(this.key)) as Record<string, string>;
    return {
      state: (h.state as State) || 'closed',
      failures: parseInt(h.failures || '0', 10),
      openedAt: parseInt(h.openedAt || '0', 10),
      probes: parseInt(h.probes || '0', 10),
    };
  }

  private async write(patch: Record<string, string | number>): Promise<void> {
    if (Object.keys(patch).length > 0) await this.redis.hset(this.key, patch as Record<string, string>);
  }

  async getState(): Promise<State> {
    const s = await this.read();
    if (s.state === 'open' && Date.now() - s.openedAt >= this.opts.resetTimeoutMs) {
      await this.write({ state: 'half-open', probes: 0 });
      return 'half-open';
    }
    return s.state;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const state = await this.getState();
    if (state === 'open') throw new CircuitOpenError(this.name);
    try {
      const result = await fn();
      if (state === 'half-open') {
        const s = await this.read();
        const probes = s.probes + 1;
        if (probes >= this.halfOpenSuccesses) {
          await this.redis.del(this.key); // closed — clean slate
        } else {
          await this.write({ probes });
        }
      } else {
        // Success resets the failure count (only when nonzero — avoids a
        // write on every healthy call).
        const s = await this.read();
        if (s.failures > 0) await this.write({ failures: 0 });
      }
      return result;
    } catch (err) {
      const s = await this.read();
      const failures = s.failures + 1;
      if (failures >= this.opts.failureThreshold) {
        await this.write({ state: 'open', failures, openedAt: Date.now(), probes: 0 });
      } else {
        await this.write({ failures });
      }
      throw err;
    }
  }

  /** Test/ops escape hatch. */
  async reset(): Promise<void> {
    await this.redis.del(this.key);
  }
}

/** Well-known breakers (C-03). Backend-B should wrap DataForSEO/Google/LLM
 * calls with these (or same-named ones) — flagged to LA as a cross-module
 * request; Backend-A wires them into notification + webhook delivery. */
export function providerCircuit(name: string): CircuitBreaker {
  return new CircuitBreaker(`provider:${name}`, { failureThreshold: 5, resetTimeoutMs: 60_000 });
}
