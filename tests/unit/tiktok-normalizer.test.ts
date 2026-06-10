// TikTok response normalizer — aweme → NormalizedPost / single-video →
// NormalizedSinglePost, with share metrics threaded (PLAT-02) and photo-mode
// handling (carousel media_type, views null by presence). Pure unit test — no
// DB, no HTTP.
//
// WAVE-0 SCAFFOLD: these are named `it.skip` placeholders that the implementing
// plan (10-02, the TikTok provider/normalizer) flips to live `it(...)`. They
// name the behavior so the test map is legible now; the bodies land WITH the
// normalizer.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok normalizer (PLAT-02) — Wave-0 scaffold", () => {
  it.skip("[10-02] maps an aweme feed item to NormalizedPost including a real shares count");
  it.skip(
    "[10-02] maps a single video to NormalizedSinglePost including shares (the IG-omitted metric)",
  );
  it.skip("[10-02] photo-mode posts map to media_type 'carousel' with views null by presence");
  it.skip("[10-02] a metric absent on this content type is null, never 0 (metrics-by-presence)");
});
