// IG URL parsers — the live test gate for the parsers (no typecheck-only
// fallthrough). Activated by Plan 08-04 Task 1 (flipped live from the Wave-0
// it.skip placeholder). Pure unit test — no DB, no HTTP.
// Requirements: SOC-01.
import { describe, it, expect } from "vitest";
import { instagramParseUrl, instagramParseSourceUrl } from "$lib/sources/instagram/server/url.js";

describe("instagram URL parsers (SOC-01)", () => {
  describe("instagramParseUrl — event paste (post / reel permalink)", () => {
    it('"/reel/ABC123/" returns an instagram_post-kind ParsedUrl with the shortcode externalId', () => {
      const parsed = instagramParseUrl("https://www.instagram.com/reel/ABC123/");
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("instagram_post");
      expect(parsed!.externalId).toBe("ABC123");
      expect(parsed!.metadata?.permalink).toBe("https://www.instagram.com/reel/ABC123/");
    });

    it('"/p/XYZ789/" returns an instagram_post-kind ParsedUrl with the shortcode externalId', () => {
      const parsed = instagramParseUrl("https://www.instagram.com/p/XYZ789/");
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("instagram_post");
      expect(parsed!.externalId).toBe("XYZ789");
      expect(parsed!.metadata?.permalink).toBe("https://www.instagram.com/p/XYZ789/");
    });

    it('"/reels/DEF456/" (the plural reels path) also resolves to instagram_post', () => {
      const parsed = instagramParseUrl("https://instagram.com/reels/DEF456/");
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("instagram_post");
      expect(parsed!.externalId).toBe("DEF456");
    });

    it("accepts the bare instagram.com host (no www) and a trailing query string", () => {
      const parsed = instagramParseUrl("https://instagram.com/p/QQ11/?igshid=abc");
      expect(parsed).not.toBeNull();
      expect(parsed!.externalId).toBe("QQ11");
    });

    it("a bare profile URL returns null (a profile is a SOURCE, not an event)", () => {
      expect(instagramParseUrl("https://www.instagram.com/natgeo/")).toBeNull();
    });

    it("a non-Instagram / garbage URL returns null", () => {
      expect(instagramParseUrl("https://www.youtube.com/watch?v=abc")).toBeNull();
      expect(instagramParseUrl("not a url at all")).toBeNull();
      expect(instagramParseUrl("https://example.com/p/XYZ789/")).toBeNull();
    });
  });

  describe("instagramParseSourceUrl — source registration (profile / handle)", () => {
    it('"/somehandle/" returns an instagram_account-kind ParsedSourceUrl', () => {
      const parsed = instagramParseSourceUrl("https://www.instagram.com/somehandle/");
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("instagram_account");
      expect(parsed!.handle).toBe("somehandle");
      expect(parsed!.externalUrl).toBe("https://www.instagram.com/somehandle/");
    });

    it('the bare-host "instagram.com/natgeo" form (no scheme nuance) resolves to instagram_account', () => {
      const parsed = instagramParseSourceUrl("https://instagram.com/natgeo");
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("instagram_account");
      expect(parsed!.handle).toBe("natgeo");
      expect(parsed!.externalUrl).toBe("https://www.instagram.com/natgeo/");
    });

    it('the raw "@natgeo" / "natgeo" prefix shapes resolve to instagram_account', () => {
      const at = instagramParseSourceUrl("@natgeo");
      expect(at).not.toBeNull();
      expect(at!.kind).toBe("instagram_account");
      expect(at!.handle).toBe("natgeo");

      const bare = instagramParseSourceUrl("natgeo");
      expect(bare).not.toBeNull();
      expect(bare!.handle).toBe("natgeo");
    });

    it("an @-prefixed DOTTED handle resolves (RAW_HANDLE_RE allows dots)", () => {
      // The leading @ is unambiguous, so a dotted handle is safely a handle, not a
      // hostname. Pre-fix the dot-gate (!includes('.')) sent it to the URL branch →
      // null, breaking a legitimate paste like `@some.handle`.
      expect(instagramParseSourceUrl("@some.handle")).toEqual({
        kind: "instagram_account",
        handle: "some.handle",
        externalUrl: "https://www.instagram.com/some.handle/",
      });
    });

    it("a BARE dotted string stays null/URL-branch (hostname-ambiguous)", () => {
      // No leading @ + a dot → could be a domain; it must NOT be treated as a bare
      // handle. Falls to the URL branch, where `some.handle` is a foreign host → null.
      expect(instagramParseSourceUrl("some.handle")).toBeNull();
    });

    it("@natgeo (dotless @handle) still resolves", () => {
      const parsed = instagramParseSourceUrl("@natgeo");
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("instagram_account");
      expect(parsed!.handle).toBe("natgeo");
    });

    it("a /p/ permalink returns null (caller meant the post parser)", () => {
      expect(instagramParseSourceUrl("https://www.instagram.com/p/XYZ789/")).toBeNull();
    });

    it("a /reel/ permalink returns null", () => {
      expect(instagramParseSourceUrl("https://www.instagram.com/reel/ABC123/")).toBeNull();
    });

    it("reserved first-segment paths (/explore, /stories) return null", () => {
      expect(instagramParseSourceUrl("https://www.instagram.com/explore/")).toBeNull();
      expect(instagramParseSourceUrl("https://www.instagram.com/stories/highlights/")).toBeNull();
    });

    it("a non-Instagram / garbage URL returns null", () => {
      expect(instagramParseSourceUrl("https://www.youtube.com/@somechannel")).toBeNull();
      expect(instagramParseSourceUrl("https://example.com/natgeo/")).toBeNull();
    });
  });
});
