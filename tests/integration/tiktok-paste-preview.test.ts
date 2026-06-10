// TikTok paste preview — pasting a TikTok video URL issues ONE by-URL provider
// request (1 credit, gated by the per-user + operator budget), maps it into a
// NormalizedSinglePost (incl shares), and returns the enriched event the client
// saves (mirrors the IG paste-preview flow via fetchEventPreviewMetadata).
//
// WAVE-0 SCAFFOLD: named `it.skip` placeholders the implementing plan (10-03)
// flips to live `it(...)`.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok paste preview — Wave-0 scaffold", () => {
  it.skip("[10-03] pasting a video URL returns an enriched tiktok_post preview with shares");
  it.skip("[10-03] the preview reserves exactly one credit against the shared budget");
  it.skip("[10-03] a second paste of the same video hits the cache (no second provider request)");
});
