// Reddit ui/index.ts — client-safe entry.
//
// Re-exports the server-safe surface AND any per-source Svelte components
// (none yet for Reddit — universal FeedCard.svelte handles reddit_post
// via its kind switch; the override escape hatch remains available if
// Reddit-specific layouts surface later).
//
// .svelte files MUST import from this barrel (not from ./server.js)
// when they want both the mapper AND any future per-source component
// re-exports. SvelteKit +page.server.ts loaders and other server
// modules must import from ./server.js to avoid bundler crashes pulling
// server-only deps into the client.
export * from "./server.js";

/** Client-side URL detection for the /events/new "Get info" paste-preview
 *  button. Returns true if `url` is a Reddit post URL the adapter knows
 *  how to preview. Mirrors src/lib/sources/reddit/server/url.ts but
 *  client-safe (no DB imports). */
export function detectPreviewUrl(url: string): boolean {
  try {
    const p = new URL(url);
    const host = p.hostname.toLowerCase();
    // Accept www.reddit.com / old.reddit.com / np.reddit.com / reddit.com
    // and redd.it short-links. Path must contain a comments segment OR
    // be a redd.it short-link.
    if (host === "redd.it") return p.pathname.length > 1;
    if (host.endsWith("reddit.com")) {
      const seg = p.pathname.split("/").filter(Boolean);
      // /r/<sub>/comments/<id>/...
      const ci = seg.indexOf("comments");
      if (ci > -1 && ci + 1 < seg.length && seg[ci + 1]!.length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Endpoint the universal /events/new preview button POSTs to when
 *  `detectPreviewUrl` returns true. Server route is mounted by the
 *  adapter's `registerRoutes` method (see ../server/route-metadata.ts). */
export const previewEndpoint = "/api/reddit/fetch-metadata";
