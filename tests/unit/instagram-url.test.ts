// PLACEHOLDER (Wave-0, it.skip) — activated by Plan 08-04 Task 1.
// Requirements: SOC-01.
//
// The IG URL parsers — the live test gate for the parsers (no typecheck-only
// fallthrough). Plan 04 Task 1 flips these to live `it`. Pure unit test —
// no DB, no HTTP.
import { describe, it } from "vitest";
// import { instagramParseUrl, instagramParseSourceUrl } from "$lib/sources/instagram/server/url.js";

describe("instagram URL parsers (SOC-01)", () => {
  it.skip('instagramParseUrl("https://www.instagram.com/reel/ABC123/") returns an instagram_post-kind ParsedUrl', async () => {
    // Plan 04: /p/<id> and /reel/<id> URLs resolve to a kind:"instagram_post"
    // ParsedUrl carrying the shortcode as externalId.
  });

  it.skip('instagramParseSourceUrl("https://www.instagram.com/somehandle/") returns an instagram_account-kind ParsedSourceUrl', async () => {
    // Plan 04: a bare profile URL resolves to a kind:"instagram_account"
    // ParsedSourceUrl carrying the handle.
  });

  it.skip("a non-profile / garbage URL returns null from both parsers", async () => {
    // Plan 04: a YouTube URL / random string returns null from both parsers
    // (no false-positive kind assignment).
  });
});
