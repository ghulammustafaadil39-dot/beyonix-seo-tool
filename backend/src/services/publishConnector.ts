// CMS publish connector (F-04) — WordPress + Webflow.
// OPTIONAL per spec: real publishing happens ONLY when CMS_PUBLISH_ENABLED=true.
// Otherwise the connector runs in an HONEST MOCK MODE (clearly labeled in the
// response: { mock: true }) and publishes nothing.
//
// SECURITY (Wave-2 fix, F-04 HIGH — CMS publish SSRF): the WordPress siteUrl
// is fully tenant-supplied, so this connector is an SSRF surface. Rules:
//  - siteUrl MUST be https: (plain http refused before any network call) and
//    must not embed credentials.
//  - ALL delivery goes through safeFetch() — SSRF validation of the target
//    AND of every redirect hop, DNS pinning, timeout — never raw fetch().
//  - The upstream response body is NEVER reflected to the caller: errors
//    surface the upstream STATUS only (a hostile/compromised CMS could
//    otherwise smuggle internal-service response bodies back to a tenant).

import { config } from '../config.js';
import { safeFetch } from './safeFetch.js';

export type CmsTarget = 'wordpress' | 'webflow';

export interface PublishInput {
  target: CmsTarget;
  title: string;
  html: string;
  status?: 'draft' | 'publish';
  /** WordPress */
  siteUrl?: string;
  username?: string;
  appPassword?: string;
  /** Webflow */
  apiToken?: string;
  siteId?: string;
  collectionId?: string;
}

export interface PublishResult {
  ok: boolean;
  /** true when nothing was really published (flag off or dry run) */
  mock: boolean;
  message: string;
  url?: string;
}

export function publishEnabled(): boolean {
  return config.cmsPublishEnabled;
}

/** Hard cap for one CMS publish call (all redirect hops share safeFetch's per-hop timeout). */
export const PUBLISH_TIMEOUT_MS = 15_000;

// CMS endpoints answer with varying content types across hosts/proxies
// (JSON normally, HTML error pages behind some WAFs). The body is never
// trusted or reflected (see header), so — exactly like webhookDelivery —
// the content-type allow-list is widened to all top-level types and the
// SSRF / size / timeout protections of safeFetch do the real work.
const PUBLISH_ALLOWED_CONTENT_TYPES = [
  'text/',
  'application/',
  'image/',
  'audio/',
  'video/',
  'font/',
  'multipart/',
  'message/',
  'model/',
];

async function publishWordpress(input: PublishInput): Promise<PublishResult> {
  const base = (input.siteUrl ?? '').replace(/\/$/, '');
  if (!base || !input.username || !input.appPassword) {
    return { ok: false, mock: false, message: 'WordPress needs siteUrl, username and appPassword.' };
  }
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return { ok: false, mock: false, message: 'WordPress siteUrl is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, mock: false, message: 'WordPress siteUrl must use https:// — plain http is refused.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, mock: false, message: 'WordPress siteUrl must not embed credentials.' };
  }
  const auth = Buffer.from(`${input.username}:${input.appPassword}`).toString('base64');
  const res = await safeFetch(
    `${base}/wp-json/wp/v2/posts`,
    {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: input.title,
        content: input.html,
        status: input.status === 'publish' ? 'publish' : 'draft',
      }),
    },
    PUBLISH_TIMEOUT_MS,
    5,
    { allowedContentTypes: PUBLISH_ALLOWED_CONTENT_TYPES },
  );
  if (!res.ok) {
    // NEVER reflect the upstream body — status only.
    return { ok: false, mock: false, message: `WordPress API error: ${res.status}` };
  }
  let link: string | undefined;
  try {
    link = ((await res.json()) as { link?: string }).link;
  } catch {
    /* 2xx with a non-JSON body still counts as published; no link to report. */
  }
  return { ok: true, mock: false, message: 'Published to WordPress.', url: link };
}

async function publishWebflow(input: PublishInput): Promise<PublishResult> {
  if (!input.apiToken || !input.collectionId) {
    return { ok: false, mock: false, message: 'Webflow needs apiToken and collectionId.' };
  }
  const res = await safeFetch(
    `https://api.webflow.com/v2/collections/${encodeURIComponent(input.collectionId)}/items`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ fieldData: { name: input.title, slug: input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) } }],
      }),
    },
    PUBLISH_TIMEOUT_MS,
    5,
    { allowedContentTypes: PUBLISH_ALLOWED_CONTENT_TYPES },
  );
  if (!res.ok) {
    // NEVER reflect the upstream body — status only.
    return { ok: false, mock: false, message: `Webflow API error: ${res.status}` };
  }
  return { ok: true, mock: false, message: 'Created Webflow CMS item (draft).' };
}

/**
 * Publish a piece. When CMS_PUBLISH_ENABLED is not 'true', returns an honest
 * mock result and performs NO network call.
 */
export async function publishPiece(input: PublishInput): Promise<PublishResult> {
  if (!publishEnabled()) {
    return {
      ok: true,
      mock: true,
      message:
        'CMS publishing is disabled (CMS_PUBLISH_ENABLED is not "true"). ' +
        'Honest mock mode: nothing was published. Set CMS_PUBLISH_ENABLED=true and provide credentials to publish for real.',
    };
  }
  try {
    return input.target === 'wordpress' ? await publishWordpress(input) : await publishWebflow(input);
  } catch (err) {
    return { ok: false, mock: false, message: `Publish failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
