// YouTube ui/index.ts — client-safe entry.
//
// Re-exports the server-safe surface AND any per-source Svelte components
// (none yet; the escape hatch remains available for kinds with unique
// layouts).
//
// .svelte files MUST import from this barrel (not from ./server.js)
// when they want both the mapper AND any future per-source component
// re-exports. SvelteKit +page.server.ts loaders and other server
// modules must import from ./server.js to avoid bundler crashes pulling
// server-only deps into the client.
export * from "./server.js";

/** Client-side URL detection for the /events/new "Get info" paste-preview
 *  button. Returns true if `url` is a YouTube watch / shorts / embed URL
 *  that the YouTube adapter knows how to preview. Mirrors the server-side
 *  parseIngestUrl predicate but lives on the client so the button can
 *  appear/disappear as the user types without a roundtrip. */
export function detectPreviewUrl(url: string): boolean {
  try {
    const p = new URL(url);
    const host = p.hostname.toLowerCase();
    if (host === "youtu.be") return p.pathname.length > 1;
    if (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") {
      if (p.pathname === "/watch" && p.searchParams.get("v")) return true;
      const seg = p.pathname.split("/").filter(Boolean);
      if (seg.length >= 2 && (seg[0] === "shorts" || seg[0] === "embed")) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Endpoint the universal /events/new preview button POSTs to when
 *  `detectPreviewUrl` returns true. Server route is mounted by the
 *  adapter's `registerRoutes` method (see ../server/route-metadata.ts). */
export const previewEndpoint = "/api/youtube/fetch-metadata";
