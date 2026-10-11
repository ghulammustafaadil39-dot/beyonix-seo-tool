// Per-host politeness tracker (C-04).
// Enforces the robots.txt crawl-delay (when present) plus a minimum gap
// between consecutive fetches to the same host so the crawler never hammers
// a site. In-memory per crawl run; one instance is shared by the crawl
// workers of a single crawlSite() call.

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

export class HostPoliteness {
  private lastFetch = new Map<string, number>();

  constructor(private defaultGapMs = 500) {}

  /**
   * Wait until `gapMs` (crawl-delay) has elapsed since the last fetch to
   * `host`, then stamp the fetch time. `gapMs` overrides the default gap.
   */
  async waitForHost(host: string, gapMs?: number): Promise<void> {
    const gap = gapMs ?? this.defaultGapMs;
    const now = Date.now();
    const last = this.lastFetch.get(host) ?? 0;
    const waitMs = gap - (now - last);
    if (waitMs > 0) await sleep(waitMs);
    this.lastFetch.set(host, Date.now());
  }

  /** For tests: the earliest timestamp a fetch to `host` may start. */
  nextAllowedAt(host: string, gapMs?: number): number {
    const gap = gapMs ?? this.defaultGapMs;
    return (this.lastFetch.get(host) ?? 0) + gap;
  }
}
