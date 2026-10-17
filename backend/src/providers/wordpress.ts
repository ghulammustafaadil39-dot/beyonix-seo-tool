/**
 * WordPress REST API client for Autopilot (v2.0).
 *
 * Connects via Application Passwords (WP 5.6+): no plugin install needed.
 * The user creates an application password in WP Admin → Users → Profile,
 * and pastes it here. Stored encrypted via the existing encryption service.
 *
 * Safety (per Technical SEO Lead spec):
 * - Only touches `post` and `page` post types by default
 * - Additive in auto mode (fills missing fields, never rewrites existing)
 * - Never touches: theme files, .htaccess, wp-config, users, URLs/slugs
 */
import { decrypt } from '../crypto.js';

export interface WpConnection {
  siteUrl: string; // e.g. https://example.com
  username: string;
  appPasswordEnc: string; // encrypted application password
}

export interface WpPost {
  id: number;
  type: 'post' | 'page';
  slug: string;
  link: string;
  title: string;
  content: string;
  excerpt: string;
  status: string;
  meta: Record<string, unknown>;
  yoastTitle?: string;
  yoastDesc?: string;
  rankMathTitle?: string;
  rankMathDesc?: string;
  usesPageBuilder?: boolean;
}

function apiBase(conn: WpConnection): string {
  return conn.siteUrl.replace(/\/$/, '') + '/wp-json/wp/v2';
}

function authHeader(conn: WpConnection): string {
  const pw = decrypt(conn.appPasswordEnc);
  return 'Basic ' + Buffer.from(`${conn.username}:${pw}`).toString('base64');
}

async function wpFetch(
  conn: WpConnection,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(apiBase(conn) + path, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: authHeader(conn),
      'Content-Type': 'application/json',
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  return { ok: res.ok, status: res.status, data };
}

/** Verify the connection works and return the WP version + site info. */
export async function verifyConnection(
  conn: WpConnection,
): Promise<{ ok: boolean; wpVersion?: string; siteName?: string; error?: string }> {
  try {
    const r = await wpFetch(conn, '');
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}: ${r.data?.message ?? 'unreachable'}` };
    // Verify credentials actually work — /users/me requires authentication.
    // Without this, invalid passwords pass verification but all writes fail silently.
    const me = await wpFetch(conn, '/wp/v2/users/me');
    if (!me.ok) {
      return {
        ok: false,
        error: 'Site reached but login failed. Use a WordPress Application Password (Users → Profile → Application Passwords), not your regular password.',
      };
    }
    return { ok: true, wpVersion: r.data?.namespaces ? 'ok' : undefined, siteName: r.data?.name };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'connection failed' };
  }
}

/**
 * Detect which SEO plugin is active by probing known REST fields.
 * Returns 'yoast' | 'rankmath' | 'both' | 'none'.
 */
export async function detectSeoPlugin(conn: WpConnection): Promise<string> {
  const r = await wpFetch(conn, '/posts?per_page=1&_fields=id,meta');
  if (!r.ok || !r.data?.[0]) return 'none';
  const meta = r.data[0].meta ?? {};
  const hasYoast = '_yoast_wpseo_metadesc' in meta || '_yoast_wpseo_title' in meta;
  const hasRankMath = 'rank_math_description' in meta || 'rank_math_title' in meta;
  if (hasYoast && hasRankMath) return 'both';
  if (hasYoast) return 'yoast';
  if (hasRankMath) return 'rankmath';
  return 'none';
}

/** List posts/pages for audit + fixing. */
export async function listContent(
  conn: WpConnection,
  type: 'posts' | 'pages' = 'posts',
  perPage = 20,
  page = 1,
): Promise<WpPost[]> {
  const r = await wpFetch(
    conn,
    `/${type}?per_page=${perPage}&page=${page}&status=publish&_fields=id,type,slug,link,title,content,excerpt,meta`,
  );
  if (!r.ok) throw new Error(`WP list failed: HTTP ${r.status}`);
  return (r.data as any[]).map((p) => normalizePost(p));
}

function normalizePost(p: any): WpPost {
  const meta = p.meta ?? {};
  const content: string = p.content?.rendered ?? '';
  return {
    id: p.id,
    type: p.type,
    slug: p.slug,
    link: p.link,
    title: p.title?.rendered ?? '',
    content,
    excerpt: p.excerpt?.rendered ?? '',
    status: p.status ?? 'publish',
    meta,
    yoastTitle: meta._yoast_wpseo_title,
    yoastDesc: meta._yoast_wpseo_metadesc,
    rankMathTitle: meta.rank_math_title,
    rankMathDesc: meta.rank_math_description,
    // Page-builder detection: Elementor/Divi store content in their own meta
    usesPageBuilder:
      '_elementor_data' in meta || '_et_pb_use_builder' in meta || '_fl_builder_data' in meta,
  };
}

/**
 * Write a meta field on a post. Returns the previous value for the change log.
 * SAFETY: only whitelisted meta keys may be written (see META_ALLOWLIST).
 */
const META_ALLOWLIST = new Set([
  '_yoast_wpseo_metadesc',
  '_yoast_wpseo_title',
  'rank_math_description',
  'rank_math_title',
  '_wp_attachment_image_alt',
]);

export async function writePostMeta(
  conn: WpConnection,
  postId: number,
  key: string,
  value: string,
): Promise<{ previous: unknown }> {
  if (!META_ALLOWLIST.has(key)) {
    throw new Error(`Refusing to write non-whitelisted meta key: ${key}`);
  }
  // Read current value first (idempotency + change log)
  const cur = await wpFetch(conn, `/posts/${postId}?_fields=meta`);
  const prev = cur.ok ? cur.data?.meta?.[key] : undefined;
  // WordPress REST: meta is written via POST /posts/:id { meta: { key: value } }
  // (requires the meta key to be registered with show_in_rest — Yoast/RankMath do this)
  const w = await wpFetch(conn, `/posts/${postId}`, {
    method: 'POST',
    body: { meta: { [key]: value } },
  });
  if (!w.ok) throw new Error(`WP meta write failed: HTTP ${w.status} ${w.data?.message ?? ''}`);
  return { previous: prev };
}

/** Update the post title (post_title). Used only in co-pilot mode with approval. */
export async function writePostTitle(
  conn: WpConnection,
  postId: number,
  title: string,
): Promise<{ previous: string }> {
  const cur = await wpFetch(conn, `/posts/${postId}?_fields=title`);
  const prev = cur.ok ? cur.data?.title?.rendered ?? '' : '';
  const w = await wpFetch(conn, `/posts/${postId}`, {
    method: 'POST',
    body: { title },
  });
  if (!w.ok) throw new Error(`WP title write failed: HTTP ${w.status}`);
  return { previous: prev };
}

/** Create a post. Status is 'draft' by default (autopilot promotes after cooling window). */
export async function createPost(
  conn: WpConnection,
  opts: {
    title: string;
    content: string;
    excerpt?: string;
    slug?: string;
    categories?: number[];
    tags?: number[];
    meta?: Record<string, string>;
    status?: 'draft' | 'publish';
  },
): Promise<{ id: number; link: string }> {
  const w = await wpFetch(conn, '/posts', {
    method: 'POST',
    body: {
      title: opts.title,
      content: opts.content,
      excerpt: opts.excerpt,
      slug: opts.slug,
      categories: opts.categories,
      tags: opts.tags,
      meta: opts.meta,
      status: opts.status ?? 'draft',
    },
  });
  if (!w.ok) throw new Error(`WP post create failed: HTTP ${w.status} ${w.data?.message ?? ''}`);
  return { id: w.data.id, link: w.data.link };
}

/** Update media alt text. */
export async function writeMediaAlt(
  conn: WpConnection,
  mediaId: number,
  alt: string,
): Promise<{ previous: string }> {
  const cur = await wpFetch(conn, `/media/${mediaId}?_fields=alt_text`);
  const prev = cur.ok ? cur.data?.alt_text ?? '' : '';
  const w = await wpFetch(conn, `/media/${mediaId}`, {
    method: 'POST',
    body: { alt_text: alt },
  });
  if (!w.ok) throw new Error(`WP alt write failed: HTTP ${w.status}`);
  return { previous: prev };
}
