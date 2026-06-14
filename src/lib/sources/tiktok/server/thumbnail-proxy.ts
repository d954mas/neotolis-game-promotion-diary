// GET /api/tiktok/thumbnail/:postId — same-origin proxy for TikTok CDN cover
// thumbnails (10-SPIKE.md Q3 — RESOLVED at Plan 05 UAT).
//
// TikTok's tiktokcdn-us.com / tiktokcdn.com serves the post cover with an
// anti-hotlink policy: a raw cross-origin <img> load fails browser-side with
// `net::ERR_BLOCKED_BY_ORB` (Opaque-Response-Blocking — the browser refuses to
// hand a cross-origin no-cors image response to a different origin's <img>),
// even though the SAME URL fetched server-side returns 200 image/webp. This is
// the same shape as IG's CORP: same-origin block (#69) — a different CDN, the
// same fix. The SERVER can fetch the URL (ORB is a browser-side embedding rule,
// not enforced on a direct fetch), so we re-serve the bytes from our OWN origin,
// where the response is now same-origin as the page and renders normally. The
// spike noted Q3 was OWED to Plan 05 UAT; UAT confirmed the browser block, so
// the proxy is added now (mirroring instagram/server/thumbnail-proxy.ts).
//
// Security:
//   - Auth: the tenantScope chain gates all of /api/* (anonymous → 401); only a
//     signed-in user's same-origin <img> (which carries the session cookie)
//     reaches here.
//   - NOT an open proxy: the URL is NEVER taken from the request. We look up the
//     post's stored thumbnail_url by aweme_id and host-validate it against the
//     TikTok CDN before fetching, so we only ever proxy URLs we ourselves
//     persisted from the provider (no SSRF).
//
// tiktok_posts is PUBLIC-DATA (post-keyed, no user_id) — the tenant guarantee is
// the auth gate, not row ownership; the thumbnail is public TikTok content shared
// across every tenant referencing the post (mirrors feed-enrichment).

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { tiktokPosts } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";

// The only hosts the provider ever returns for tiktok_posts.thumbnail_url. The
// normalizer reads video.dynamic_cover.url_list / video.cover.url_list, both on
// `*.tiktokcdn-us.com` (10-SPIKE.md finding (e)); `.tiktokcdn.com` is the base
// TikTok CDN domain that also serves covers in some regions. Suffix-matched
// against the stored URL's host — defence-in-depth so a future provider change
// can never turn this into a general-purpose fetch.
const ALLOWED_HOST_SUFFIXES = [".tiktokcdn-us.com", ".tiktokcdn.com"];

/**
 * Resolve a post's stored thumbnail URL, host-validated. Returns null when the
 * post is unknown, has no thumbnail, or the stored host is not a TikTok CDN.
 * tiktok_posts is public-data (allowlisted, no user_id scope).
 */
export async function resolveTikTokThumbnailUrl(awemeId: string): Promise<string | null> {
  const [row] = await db
    .select({ url: tiktokPosts.thumbnailUrl })
    .from(tiktokPosts)
    .where(eq(tiktokPosts.awemeId, awemeId))
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

export const tiktokThumbnailRoutes = new Hono<{
  Variables: { userId: string; sessionId: string };
}>();

tiktokThumbnailRoutes.get("/tiktok/thumbnail/:postId", async (c) => {
  const url = await resolveTikTokThumbnailUrl(c.req.param("postId"));
  if (url === null) return c.body(null, 404);

  // No Referer to the CDN (the original <img> used referrerpolicy=no-referrer).
  // An expired/failed CDN URL (the signed cover URL carries x-expires) → 502 →
  // the <img> onerror falls back to the KindIcon placeholder. The next account
  // poll refreshes the stored URL.
  //
  // redirect:"manual" — the host allow-list validates only the INITIAL URL, so
  // FOLLOWING a redirect would re-open SSRF (a 3xx → internal host). The TikTok
  // CDN serves image bytes directly and never legitimately redirects, so a 3xx
  // comes back as a non-ok opaque-redirect response and falls through to the 502
  // below — we never fetch the redirect target. The timeout bounds a slow/hung
  // CDN (the route is auth-gated, but cheap insurance against a held request).
  const upstream = await fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(8000),
  }).catch((err: unknown) => {
    logger.warn(
      { err: String((err as Error)?.message ?? err) },
      "tiktok thumbnail proxy: upstream fetch failed",
    );
    return null;
  });
  if (upstream === null || !upstream.ok || upstream.body === null) {
    // Diagnostic for the steady prod 502 rate on this route: a network error is
    // already logged above; this captures the HTTP-level failure so we can tell a
    // signed-URL expiry (403/404 — the next poll refreshes thumbnail_url) from a
    // CDN block / opaque-redirect (3xx) without guessing.
    if (upstream !== null) {
      logger.warn(
        { postId: c.req.param("postId"), status: upstream.status, hadBody: upstream.body !== null },
        "tiktok thumbnail proxy: upstream non-ok",
      );
    }
    return c.body(null, 502);
  }

  // Re-served same-origin → ORB no longer blocks it. Cache 1h in the browser:
  // the cover image is effectively immutable for a given signed URL, so the upper
  // bound can be long. Freshness does NOT rely on this expiring — the card
  // versions the proxy URL by the last poll timestamp (?v=), so a re-poll (incl.
  // Refresh-Now) yields a NEW URL that bypasses the cache immediately. `private`
  // keeps it out of shared caches (the route is auth-gated).
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/webp",
      "cache-control": "private, max-age=3600",
    },
  });
});
