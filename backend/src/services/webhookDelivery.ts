import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { decrypt, encrypt } from '../crypto.js';
import { query as defaultQuery, type QueryFn } from '../db.js';
import { isBlockedIp, isLoopbackBypassActive, safeFetch } from './safeFetch.js';
import { CircuitBreaker } from './circuitBreaker.js';

// ---------------------------------------------------------------------------
// F-10: outbound webhooks — SIGNED delivery with retries and replay.
// ---------------------------------------------------------------------------

/** Retry schedule after each failed attempt (C-03/F-10). */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/**
 * NEW-5: overall deadline for ONE delivery attempt, across ALL redirect
 * hops. The per-hop timeout is 15s and safeFetch follows up to 5
 * redirects, so without an overall cap a single attempt could take
 * ~90s. safeFetch already supports an absolute deadline
 * (SafeFetchOpts.deadlineMs, epoch ms) — we pass `now + this` on every
 * attempt, capping the whole attempt at ~30s.
 */
export const WEBHOOK_OVERALL_DEADLINE_MS = 30_000;

const breakers = new Map<string, CircuitBreaker>();
function breakerFor(host: string): CircuitBreaker {
  let b = breakers.get(host);
  if (!b) {
    b = new CircuitBreaker(`webhook:${host}`, { failureThreshold: 5, resetTimeoutMs: 60_000 });
    breakers.set(host, b);
  }
  return b;
}

/**
 * SSRF validation for customer-supplied webhook URLs (F-10, SECURITY-
 * SENSITIVE — Security Lead review required). Rejects non-http(s)
 * schemes, embedded credentials, and any hostname that resolves to a
 * blocked IP (private/loopback/link-local/etc. via safeFetch's
 * isBlockedIp). Re-validated at delivery time (per-attempt), not just at
 * registration, to blunt DNS-rebinding.
 */
export async function validateWebhookUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid webhook URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Webhook URL must use http(s)');
  }
  if (url.username || url.password) {
    throw new Error('Webhook URL must not embed credentials');
  }
  let records: Array<{ address: string }>;
  try {
    records = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new Error('Webhook URL hostname does not resolve');
  }
  const allowLoopback = isLoopbackBypassActive(process.env.NODE_ENV ?? '');
  for (const r of records) {
    if (isBlockedIp(r.address, { allowLoopback })) {
      throw new Error(`SSRF blocked: webhook host resolves to a private address (${r.address})`);
    }
  }
  return url;
}

/** Signs a delivery: `X-BSEO-Signature: sha256=<hmac(secret, ts.body)>`. */
export function signWebhookDelivery(secret: string, timestamp: number, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Verifies a delivery signature (used by tests + receiver docs). */
export function verifyWebhookSignature(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
): boolean {
  const expected = signWebhookDelivery(secret, timestamp, body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface WebhookEndpoint {
  id: string;
  tenant_id: string;
  url: string;
  secret_enc: string;
  events: string[];
  enabled: boolean;
}

/**
 * Emits an event to every enabled endpoint of the tenant subscribed to it.
 * Creates 'pending' delivery rows; processWebhookRetries() (scheduler, every
 * 5 min) performs the actual HTTP delivery with retries.
 */
export async function emitWebhookEvent(
  tenantId: string,
  event: string,
  payload: Record<string, unknown>,
  q: QueryFn = defaultQuery,
): Promise<number> {
  const eps = await q(
    `SELECT id FROM webhook_endpoints
     WHERE tenant_id = $1 AND enabled = TRUE AND $2 = ANY(events)`,
    [tenantId, event],
  );
  let n = 0;
  for (const ep of eps.rows) {
    await q(
      `INSERT INTO webhook_deliveries (id, endpoint_id, tenant_id, event, payload, status, attempts, next_retry_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'pending', 0, now())`,
      [ep.id, tenantId, event, JSON.stringify({ event, ...payload })],
    );
    n += 1;
  }
  return n;
}

async function deliverOne(
  q: QueryFn,
  delivery: { id: string; event: string; payload: any },
  endpoint: WebhookEndpoint,
  /** Absolute epoch-ms deadline for the whole attempt (all hops). */
  deadlineAt: number = Date.now() + WEBHOOK_OVERALL_DEADLINE_MS,
): Promise<void> {
  // SSRF re-validation at delivery time (DNS may have changed since
  // registration).
  const url = await validateWebhookUrl(endpoint.url);
  const secret = decrypt(endpoint.secret_enc);
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookDelivery(secret, timestamp, body);

  await breakerFor(url.host).exec(async () => {
    // SECURITY (F-10 fix): delivery MUST go through safeFetch — the raw
    // global fetch followed redirects blindly (an endpoint could 302/307
    // the signed POST to an internal host) and re-resolved DNS after
    // validation (rebinding TOCTOU). safeFetch re-validates EVERY redirect
    // hop and pins the connection to the validated IP. Webhook receivers
    // may acknowledge with almost any content type, so the type allow-list
    // is widened to all top-level types (the SSRF/size protections are
    // what matter here; the body is discarded beyond error text).
    const res = await safeFetch(
      url.toString(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BSEO-Event': delivery.event,
          'X-BSEO-Delivery': delivery.id,
          'X-BSEO-Timestamp': String(timestamp),
          'X-BSEO-Signature': signature,
          'User-Agent': 'Beyonix-SEO-Webhooks/1.0',
        },
        body,
      },
      15_000,
      5,
      {
        // NEW-5: overall deadline across every redirect hop (~30s),
        // on top of the 15s per-hop timeout above.
        deadlineMs: deadlineAt,
        allowedContentTypes: [
          'text/',
          'application/',
          'image/',
          'audio/',
          'video/',
          'font/',
          'multipart/',
          'message/',
          'model/',
        ],
      },
    );
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      throw new Error(`webhook HTTP ${res.status}: ${text}`);
    }
  });

  await q(
    `UPDATE webhook_deliveries SET status = 'delivered', delivered_at = now(), last_error = NULL
     WHERE id = $1`,
    [delivery.id],
  );
}

/**
 * Delivers due webhook retries (called from the scheduler every 5 min, and
 * directly by tests). Returns the number of deliveries attempted.
 *
 * A2-M4: claim-then-work. The leader lock can expire mid-tick, letting a
 * second worker run this schedule concurrently — each delivery is claimed
 * with an atomic conditional UPDATE (pending -> in_progress), so a webhook
 * is delivered at most once even then. Stale 'in_progress' rows (worker
 * died mid-flight, claimed >10 min ago) are reclaimable.
 */
export async function processWebhookRetries(
  q: QueryFn = defaultQuery,
  /** Overall per-attempt deadline (duration, ms). Tests override it to
   * prove the deadline plumbing without waiting the full 30s. */
  overallDeadlineMs: number = WEBHOOK_OVERALL_DEADLINE_MS,
): Promise<number> {
  const due = await q(
    `SELECT d.id, d.event, d.payload, d.attempts, d.endpoint_id,
            e.url, e.secret_enc, e.tenant_id
     FROM webhook_deliveries d
     JOIN webhook_endpoints e ON e.id = d.endpoint_id
     WHERE (d.status = 'pending'
            OR (d.status = 'in_progress' AND d.claimed_at < now() - interval '10 minutes'))
       AND d.next_retry_at <= now()
     ORDER BY d.next_retry_at ASC
     LIMIT 100`,
  );
  let attempted = 0;
  for (const row of due.rows) {
    // Atomic claim: only the winner of this conditional UPDATE delivers.
    const claimed = await q(
      `UPDATE webhook_deliveries SET status = 'in_progress', claimed_at = now()
       WHERE id = $1
         AND ((status = 'pending')
              OR (status = 'in_progress' AND claimed_at < now() - interval '10 minutes'))
         AND next_retry_at <= now()`,
      [row.id],
    );
    if ((claimed.rowCount ?? 0) === 0) continue; // another worker claimed it
    attempted += 1;
    const attempts = Number(row.attempts) + 1;
    try {
      await deliverOne(
        q,
        { id: row.id, event: row.event, payload: row.payload },
        {
          id: row.endpoint_id,
          tenant_id: row.tenant_id,
          url: row.url,
          secret_enc: row.secret_enc,
          events: [],
          enabled: true,
        },
        Date.now() + overallDeadlineMs,
      );
    } catch (err) {
      const message = (err as Error)?.message?.slice(0, 1000) ?? String(err);
      if (attempts >= MAX_ATTEMPTS) {
        await q(
          `UPDATE webhook_deliveries SET status = 'failed', attempts = $2, last_error = $3 WHERE id = $1`,
          [row.id, attempts, message],
        );
      } else {
        const nextRetry = new Date(Date.now() + RETRY_DELAYS_MS[attempts - 1]);
        await q(
          `UPDATE webhook_deliveries SET status = 'pending', attempts = $2, next_retry_at = $3, last_error = $4 WHERE id = $1`,
          [row.id, attempts, nextRetry.toISOString(), message],
        );
      }
    }
  }
  return attempted;
}

/** Replays a delivery (admin/owner): resets it to pending for redelivery. */
export async function replayDelivery(
  tenantId: string,
  deliveryId: string,
  q: QueryFn = defaultQuery,
): Promise<boolean> {
  const r = await q(
    `UPDATE webhook_deliveries SET status = 'pending', attempts = 0,
       next_retry_at = now(), last_error = NULL, claimed_at = NULL
     WHERE id = $1 AND tenant_id = $2 AND status IN ('failed', 'delivered')`,
    [deliveryId, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Registers a tenant webhook endpoint (URL SSRF-validated). Returns the id + raw secret (shown once). */
export async function registerWebhookEndpoint(
  tenantId: string,
  url: string,
  events: string[],
  q: QueryFn = defaultQuery,
): Promise<{ id: string; secret: string }> {
  await validateWebhookUrl(url);
  const secret = crypto.randomBytes(32).toString('hex');
  const r = await q(
    `INSERT INTO webhook_endpoints (id, tenant_id, url, secret_enc, events, enabled)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, TRUE) RETURNING id`,
    [tenantId, url, encrypt(secret), events],
  );
  return { id: r.rows[0].id as string, secret };
}
