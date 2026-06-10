// TikTok URL parsers — parseUrl (video permalink) + parseSourceUrl (@handle).
// Pure unit test — no DB, no HTTP.
//
// WAVE-0 SCAFFOLD: named `it.skip` placeholders the implementing plan (10-02,
// the TikTok url.ts) flips to live `it(...)`.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok URL parsers — Wave-0 scaffold", () => {
  describe("parseUrl — event paste (video permalink)", () => {
    it.skip(
      "[10-02] /@handle/video/<id> returns a tiktok_post-kind ParsedUrl with the aweme id externalId",
    );
    it.skip("[10-02] accepts a scheme-less video permalink (www.tiktok.com/...)");
  });

  describe("parseSourceUrl — add-source (@handle profile)", () => {
    it.skip("[10-02] https://www.tiktok.com/@handle resolves to a tiktok_account source (D-04)");
    it.skip("[10-02] the bare tiktok.com host (no www) resolves the @handle");
    it.skip("[10-02] a scheme-less handle URL (tiktok.com/@handle) resolves (D-05)");
    it.skip("[10-02] a raw @handle (leading @) resolves to the canonical profile URL");
    it.skip("[10-02] a bare handle (no @, no host) resolves to the canonical profile URL");
  });
});
