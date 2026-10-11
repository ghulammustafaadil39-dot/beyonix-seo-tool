// CMS publish connector (F-04) — WordPress + Webflow.
// OPTIONAL per spec: real publishing happens ONLY when CMS_PUBLISH_ENABLED=true.
// Otherwise the connector runs in an HONEST MOCK MODE (clearly labeled in the
// response: { mock: true }) and publishes nothing.

import { config } from '../config.js';

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

async function publishWordpress(input: PublishInput): Promise<PublishResult> {
  const base = (input.siteUrl ?? '').replace(/\/$/, '');
  if (!base || !input.username || !input.appPassword) {
    return { ok: false, mock: false, message: 'WordPress needs siteUrl, username and appPassword.' };
  }
  const auth = Buffer.from(`${input.username}:${input.appPassword}`).toString('base64');
  const res = await fetch(`${base}/wp-json/wp/v2/posts`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: input.title,
      content: input.html,
      status: input.status === 'publish' ? 'publish' : 'draft',
    }),
  });
  if (!res.ok) {
    return { ok: false, mock: false, message: `WordPress API error: ${res.status} ${(await res.text()).slice(0, 300)}` };
  }
  const data = (await res.json()) as { link?: string };
  return { ok: true, mock: false, message: 'Published to WordPress.', url: data.link };
}

async function publishWebflow(input: PublishInput): Promise<PublishResult> {
  if (!input.apiToken || !input.collectionId) {
    return { ok: false, mock: false, message: 'Webflow needs apiToken and collectionId.' };
  }
  const res = await fetch(`https://api.webflow.com/v2/collections/${input.collectionId}/items`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      items: [{ fieldData: { name: input.title, slug: input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60) } }],
    }),
  });
  if (!res.ok) {
    return { ok: false, mock: false, message: `Webflow API error: ${res.status} ${(await res.text()).slice(0, 300)}` };
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
