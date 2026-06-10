// TikTok feed visualization — the /feed enrichment + chart loader surface
// share_count alongside views/likes/comments (the PLAT-02 metric that makes
// TikTok complete the "metrics across all channels" view).
//
// WAVE-0 SCAFFOLD: named `it.skip` placeholders the implementing plan (10-05,
// the TikTok UI/feed integration) flips to live `it(...)`.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok feed visualization — Wave-0 scaffold", () => {
  it.skip("[10-05] a tiktok_post event enriches with its latest snapshot metrics in /feed");
  it.skip(
    "[10-05] the chart loader returns a populated share_count series for a tiktok_post (the IG-omitted metric is present)",
  );
});
