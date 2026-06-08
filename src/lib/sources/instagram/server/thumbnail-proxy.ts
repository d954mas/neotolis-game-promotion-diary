// GET /api/instagram/thumbnail/:postId — same-origin proxy for Instagram CDN
// thumbnails (#69 follow-up).
//
// Instagram's cdninstagram.com serves post thumbnails with
// `Cross-Origin-Resource-Policy: same-origin` — an anti-hotlink header that makes
// the browser BLOCK a cross-origin <img> (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin),
// so the raw CDN URL cannot be displayed directly from our origin (unlike the
// YouTube/Reddit/Google CDNs, which send CORP `cross-origin`). The SERVER can
// fetch the URL (CORP is a browser-side embedding rule, not enforced on a direct
// fetch), so we re-serve the bytes from our OWN origin, where CORP no longer
// applies because the image is now same-origin as the page.
//
// Security:
//   - Auth: the tenantScope chain gates all of /api/* (anonymous → 401); only a
//     signed-in user's same-origin <img> (which carries the session cookie)
//     reaches here.
//   - NOT an open proxy: the URL is NEVER taken from the request. We look up the
//     post's stored thumbnail_url by post_id and host-validate it against the
//     Instagram/Facebook CDN before fetching, so we only ever proxy URLs we
//     ourselves persisted from the provider (no SSRF).
//
// instagram_posts is PUBLIC-DATA (post-keyed, no user_id) — the tenant guarantee
// is the auth gate, not row ownership; the thumbnail is public IG content shared
// across every tenant referencing the post (mirrors feed-enrichment).

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { instagramPosts } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";

// The only hosts the provider ever returns for instagram_posts.thumbnail_url.
// Suffix-matched against the stored URL's host — defence-in-depth so a future
// provider change can never turn this into a general-purpose fetch.
const ALLOWED_HOST_SUFFIXES = [".cdninstagram.com", ".fbcdn.net"];

/**
 * Resolve a post's stored thumbnail URL, host-validated. Returns null when the
 * post is unknown, has no thumbnail, or the stored host is not an Instagram /
 * Facebook CDN. instagram_posts is public-data (allowlisted, no user_id scope).
 */
export async function resolveInstagramThumbnailUrl(postId: string): Promise<string | null> {
  const [row] = await db
    .select({ url: instagramPosts.thumbnailUrl })
    .from(instagramPosts)
    .where(eq(instagramPosts.postId, postId))
    .limit(1);
  const url = row?.url ?? null;
  if (url === null) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ? url : null;
}

export const instagramThumbnailRoutes = new Hono<{
  Variables: { userId: string; sessionId: string };
}>();

instagramThumbnailRoutes.get("/instagram/thumbnail/:postId", async (c) => {
  const url = await resolveInstagramThumbnailUrl(c.req.param("postId"));
  if (url === null) return c.body(null, 404);

  // No Referer to the CDN (the original <img> used referrerpolicy=no-referrer).
  // An expired/failed CDN URL → 502 → the <img> onerror falls back to the
  // KindIcon placeholder. The next account poll refreshes the stored URL.
  //
  // redirect:"manual" — the host allow-list validates only the INITIAL URL, so
  // FOLLOWING a redirect would re-open SSRF (a 3xx → internal host). IG/FB CDNs
  // serve image bytes directly and never legitimately redirect, so a 3xx comes
  // back as a non-ok opaque-redirect response and falls through to the 502
  // below — we never fetch the redirect target. The timeout bounds a slow/hung
  // CDN (the route is auth-gated, but cheap insurance against a held request).
  const upstream = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  }).catch((err: unknown) => {
    logger.warn(
      { err: String((err as Error)?.message ?? err) },
      "instagram thumbnail proxy: upstream fetch failed",
    );
    return null;
  });
  if (upstream === null || !upstream.ok || upstream.body === null) {
    return c.body(null, 502);
  }

  // Re-served same-origin → IG's CORP no longer blocks it. Cache 1h in the
  // browser: the cover image is effectively immutable, so the upper bound can be
  // long. Freshness does NOT rely on this expiring — the card versions the proxy
  // URL by the last poll timestamp (?v=), so a re-poll (incl. Refresh-Now) yields
  // a NEW URL that bypasses the cache immediately. `private` keeps it out of
  // shared caches (the route is auth-gated).
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
      "cache-control": "private, max-age=3600",
    },
  });
});
