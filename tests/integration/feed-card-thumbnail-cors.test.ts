import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Feed-card thumbnail must NOT set crossorigin (#69).
//
// The thumbnail <img> is display-only (never read into a canvas). Instagram's
// cdninstagram.com serves the image bytes WITHOUT Access-Control-Allow-Origin
// headers, so `crossorigin="anonymous"` makes the browser fetch 200 then DISCARD
// the image on the failed CORS check → every Instagram thumbnail breaks. The
// YouTube/Reddit CDNs DO send CORS headers, which masked the bug until real IG
// thumbnails finally rendered (after the #69 paste fixes). Guard: the shared
// feed card keeps referrerpolicy (CDN hotlink hygiene) but carries no crossorigin.

const read = (p: string): string => fs.readFileSync(path.resolve(p), "utf8");

describe("feed card thumbnail CORS (#69)", () => {
  it("BaseFeedCard thumbnail img keeps referrerpolicy but sets NO crossorigin", () => {
    // Strip HTML comments first — the markup carries a why-comment that names
    // crossorigin; this guard targets the actual attribute, not the prose.
    const src = read("src/lib/components/feed/parts/BaseFeedCard.svelte").replace(
      /<!--[\s\S]*?-->/g,
      "",
    );
    expect(src, "referrerpolicy kept for CDN hotlink hygiene").toMatch(
      /referrerpolicy="no-referrer"/,
    );
    expect(
      src,
      "no crossorigin attribute — IG CDN sends no CORS headers; the img is display-only",
    ).not.toMatch(/crossorigin/);
  });
});
