// Twitter/X URL parsers — twitterParseUrl (status permalink) + twitterParseSourceUrl
// (@handle). Pure unit test — no DB, no HTTP.
//
// Mirrors the #73-hardened telegram/tiktok parser shapes: host-check-first, raw-@handle
// / bare-handle before new URL(), scheme-less, www + bare + mobile host. NO t.co
// short-link host in the set (D-07 — no short-link resolve, YAGNI). Tracking params
// (?s= / ?t=) are stripped by construction (the parser reads only the pathname).
//
// Requirements: PLAT-03 (D-07 tracking-param strip).
import { describe, it, expect } from "vitest";
import { twitterParseSourceUrl, twitterParseUrl } from "$lib/sources/twitter/server/url.js";

describe("twitter URL parsers", () => {
  describe("parseSourceUrl — add-source (@handle)", () => {
    it("[11-02] x.com/<handle> -> {handle} (bare profile path, no /@)", () => {
      expect(twitterParseSourceUrl("https://x.com/supergiantgames")).toEqual({
        kind: "twitter_account",
        handle: "supergiantgames",
        externalUrl: "https://x.com/supergiantgames",
      });
    });

    it("[11-02] twitter.com/<handle> -> {handle} (canonicalizes to x.com)", () => {
      expect(twitterParseSourceUrl("https://twitter.com/ConcernedApe")).toEqual({
        kind: "twitter_account",
        handle: "ConcernedApe",
        externalUrl: "https://x.com/ConcernedApe",
      });
    });

    it("[11-02] mobile.twitter.com / mobile.x.com -> {handle}", () => {
      expect(twitterParseSourceUrl("https://mobile.twitter.com/ConcernedApe")?.handle).toBe(
        "ConcernedApe",
      );
      expect(twitterParseSourceUrl("https://mobile.x.com/supergiantgames")?.handle).toBe(
        "supergiantgames",
      );
    });

    it("[11-02] scheme-less host (x.com/<handle>) -> {handle}", () => {
      expect(twitterParseSourceUrl("x.com/supergiantgames")?.handle).toBe("supergiantgames");
    });

    it("[11-02] a raw @handle -> {handle}", () => {
      expect(twitterParseSourceUrl("@supergiantgames")).toEqual({
        kind: "twitter_account",
        handle: "supergiantgames",
        externalUrl: "https://x.com/supergiantgames",
      });
    });

    it("[11-02] a bare handle (no @, no host) -> {handle}", () => {
      expect(twitterParseSourceUrl("supergiantgames")?.externalUrl).toBe(
        "https://x.com/supergiantgames",
      );
    });

    it("[11-02] www.x.com / www.twitter.com hosts resolve", () => {
      expect(twitterParseSourceUrl("https://www.x.com/ConcernedApe")?.handle).toBe("ConcernedApe");
    });

    it("[11-02] a non-twitter host -> null (host-check first)", () => {
      expect(twitterParseSourceUrl("https://example.com/supergiantgames")).toBeNull();
    });

    it("[11-02] a status permalink -> null (caller meant the post parser)", () => {
      expect(twitterParseSourceUrl("https://x.com/supergiantgames/status/123")).toBeNull();
    });
  });

  describe("parseUrl — event paste (status permalink)", () => {
    it("[11-02] x.com/<handle>/status/<id> -> {kind:'twitter_post', externalId:<id>}", () => {
      expect(twitterParseUrl("https://x.com/supergiantgames/status/1799999999999999999")).toEqual({
        kind: "twitter_post",
        externalId: "1799999999999999999",
        metadata: {
          handle: "supergiantgames",
          permalink: "https://x.com/supergiantgames/status/1799999999999999999",
        },
      });
    });

    it("[11-02] twitter.com/<handle>/status/<id> -> {kind:'twitter_post', externalId:<id>}", () => {
      const parsed = twitterParseUrl("https://twitter.com/ConcernedApe/status/42");
      expect(parsed?.kind).toBe("twitter_post");
      expect(parsed?.externalId).toBe("42");
      // Permalink canonicalizes to x.com.
      expect((parsed?.metadata as { permalink: string }).permalink).toBe(
        "https://x.com/ConcernedApe/status/42",
      );
    });

    it("[11-02] mobile + scheme-less status permalinks resolve the id", () => {
      expect(twitterParseUrl("https://mobile.x.com/h/status/7")?.externalId).toBe("7");
      expect(twitterParseUrl("x.com/h/status/9")?.externalId).toBe("9");
    });

    it("[11-02] strips ?s= / ?t= tracking params from the permalink (D-07)", () => {
      // The query never reaches the id — only the pathname is parsed.
      expect(twitterParseUrl("https://x.com/h/status/123?s=20")?.externalId).toBe("123");
      expect(twitterParseUrl("https://x.com/h/status/123?t=abc&s=09")?.externalId).toBe("123");
      // The stored permalink carries NO query string.
      const parsed = twitterParseUrl("https://x.com/h/status/123?s=20");
      expect((parsed?.metadata as { permalink: string }).permalink).toBe(
        "https://x.com/h/status/123",
      );
    });

    it("[11-02] tolerates a /photo/N tail on a status permalink", () => {
      expect(twitterParseUrl("https://x.com/h/status/123/photo/1")?.externalId).toBe("123");
    });

    it("[11-02] a profile URL (no /status/) returns null (a profile is a source, not an event)", () => {
      expect(twitterParseUrl("https://x.com/supergiantgames")).toBeNull();
    });

    it("[11-02] a foreign host returns null (host-check first)", () => {
      expect(twitterParseUrl("https://example.com/h/status/123")).toBeNull();
    });
  });
});
