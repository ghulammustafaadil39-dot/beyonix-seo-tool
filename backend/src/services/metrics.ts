/**
 * Q-03: minimal Prometheus metrics registry (additive, no new dependency).
 *
 * In-memory counters/histogram for HTTP traffic + job outcomes. Queue depth
 * and provider spend are NOT kept here — the /metrics route reads them live
 * from BullMQ / Postgres so the numbers can never drift from reality.
 *
 * Env-gated hooks (documented in docs/observability.md):
 *  - SENTRY_DSN: when set, a host application may initialise Sentry; this
 *    module never imports Sentry (no hard dependency).
 *  - OTEL_EXPORTER_OTLP_ENDPOINT: same pattern for OpenTelemetry.
 * This file only exposes `observabilityHooksEnabled()` so /status can
 * report whether those hooks are configured.
 */

export interface HttpObservation {
  method: string;
  route: string;
  status: number;
  durationMs: number;
}

const HISTOGRAM_BUCKETS_MS = [5, 10, 25, 50, 100, 200, 500, 1000, 2500, 5000];

interface MetricsState {
  httpTotal: Map<string, number>;
  httpDurationCount: Map<string, number>;
  httpDurationSum: Map<string, number>;
  httpBuckets: Map<string, number[]>;
  jobOutcomes: Map<string, number>;
  startedAt: number;
}

const state: MetricsState = {
  httpTotal: new Map(),
  httpDurationCount: new Map(),
  httpDurationSum: new Map(),
  httpBuckets: new Map(),
  jobOutcomes: new Map(),
  startedAt: Date.now(),
};

function keyOf(o: { method: string; route: string; status: number }): string {
  return `${o.method} ${o.route} ${o.status}`;
}

function labelEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Record one completed HTTP request. Called from an onResponse hook. */
export function recordHttp(o: HttpObservation): void {
  const k = keyOf(o);
  state.httpTotal.set(k, (state.httpTotal.get(k) ?? 0) + 1);
  state.httpDurationCount.set(k, (state.httpDurationCount.get(k) ?? 0) + 1);
  state.httpDurationSum.set(k, (state.httpDurationSum.get(k) ?? 0) + o.durationMs);
  const buckets = state.httpBuckets.get(k) ?? new Array(HISTOGRAM_BUCKETS_MS.length).fill(0);
  HISTOGRAM_BUCKETS_MS.forEach((b, i) => {
    if (o.durationMs <= b) buckets[i] += 1;
  });
  state.httpBuckets.set(k, buckets);
}

/** Record a finished worker job (`completed` | `failed` | `dead_letter`). */
export function recordJobOutcome(queue: string, outcome: string): void {
  const k = `${queue} ${outcome}`;
  state.jobOutcomes.set(k, (state.jobOutcomes.get(k) ?? 0) + 1);
}

export function observabilityHooksEnabled(): { sentry: boolean; otel: boolean } {
  // Read live (not the config snapshot) so operator/test changes take
  // effect without a reboot; config.ts is the canonical declaration site.
  return {
    sentry: Boolean(process.env.SENTRY_DSN),
    otel: Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT),
  };
}

export function metricsStartedAt(): number {
  return state.startedAt;
}

/** Test helper: reset all in-memory series. */
export function resetMetricsForTests(): void {
  state.httpTotal.clear();
  state.httpDurationCount.clear();
  state.httpDurationSum.clear();
  state.httpBuckets.clear();
  state.jobOutcomes.clear();
}

export interface LiveMetrics {
  queueDepth: Record<string, { waiting: number; active: number; delayed: number; failed: number }>;
  providerSpendCents30d: Record<string, number>;
  deadLettersPending: number;
}

/** Render the Prometheus text exposition format (version 0.0.4). */
export function renderPrometheus(live: LiveMetrics): string {
  const lines: string[] = [];
  lines.push('# HELP bseo_http_requests_total HTTP requests by method, route and status.');
  lines.push('# TYPE bseo_http_requests_total counter');
  for (const [k, v] of state.httpTotal) {
    const [method, route, status] = k.split(' ');
    lines.push(
      `bseo_http_requests_total{method="${labelEscape(method)}",route="${labelEscape(route)}",status="${labelEscape(status)}"} ${v}`,
    );
  }
  lines.push('# HELP bseo_http_request_duration_ms HTTP request duration histogram (ms).');
  lines.push('# TYPE bseo_http_request_duration_ms histogram');
  for (const [k, count] of state.httpDurationCount) {
    const [method, route, status] = k.split(' ');
    const labels = `method="${labelEscape(method)}",route="${labelEscape(route)}",status="${labelEscape(status)}"`;
    const buckets = state.httpBuckets.get(k) ?? [];
    HISTOGRAM_BUCKETS_MS.forEach((b, i) => {
      lines.push(`bseo_http_request_duration_ms_bucket{${labels},le="${b}"} ${buckets[i] ?? 0}`);
    });
    lines.push(`bseo_http_request_duration_ms_bucket{${labels},le="+Inf"} ${count}`);
    lines.push(`bseo_http_request_duration_ms_sum{${labels}} ${Math.round(state.httpDurationSum.get(k) ?? 0)}`);
    lines.push(`bseo_http_request_duration_ms_count{${labels}} ${count}`);
  }
  lines.push('# HELP bseo_job_outcomes_total Worker job outcomes by queue and outcome.');
  lines.push('# TYPE bseo_job_outcomes_total counter');
  for (const [k, v] of state.jobOutcomes) {
    const [queue, outcome] = k.split(' ');
    lines.push(
      `bseo_job_outcomes_total{queue="${labelEscape(queue)}",outcome="${labelEscape(outcome)}"} ${v}`,
    );
  }
  lines.push('# HELP bseo_queue_jobs Jobs currently in a BullMQ queue state.');
  lines.push('# TYPE bseo_queue_jobs gauge');
  for (const [queue, counts] of Object.entries(live.queueDepth)) {
    for (const [st, v] of Object.entries(counts)) {
      lines.push(`bseo_queue_jobs{queue="${labelEscape(queue)}",state="${labelEscape(st)}"} ${v}`);
    }
  }
  lines.push('# HELP bseo_provider_spend_cents_30d Provider spend (cents, trailing 30d) from provider_spend.');
  lines.push('# TYPE bseo_provider_spend_cents_30d gauge');
  for (const [provider, cents] of Object.entries(live.providerSpendCents30d)) {
    lines.push(`bseo_provider_spend_cents_30d{provider="${labelEscape(provider)}"} ${cents}`);
  }
  lines.push('# HELP bseo_dead_letters_pending Dead-letter jobs awaiting replay/discard.');
  lines.push('# TYPE bseo_dead_letters_pending gauge');
  lines.push(`bseo_dead_letters_pending ${live.deadLettersPending}`);
  lines.push('# HELP bseo_uptime_seconds Process uptime of the metrics registry.');
  lines.push('# TYPE bseo_uptime_seconds gauge');
  lines.push(`bseo_uptime_seconds ${Math.floor((Date.now() - state.startedAt) / 1000)}`);
  return lines.join('\n') + '\n';
}
