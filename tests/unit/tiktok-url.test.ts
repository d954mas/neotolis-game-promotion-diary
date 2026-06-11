// TikTok URL parsers — parseUrl (video permalink) + parseSourceUrl (@handle).
// Pure unit test — no DB, no HTTP.
//
// Mirrors the #73-hardened telegram/IG parser shapes: host-check-first,
// raw-@handle / bare-handle before new URL(), scheme-less, www + bare host. The
// short-link hosts (vm./vt.) are NOT in the host set — they resolve via
// short-link.ts first (D-06).
//
// Requirements: PLAT-02 (D-04/D-05).
import { describe, it, expect } from "vitest";
import { tiktokParseSourceUrl, tiktokParseUrl } from "$lib/sources/tiktok/server/url.js";

describe("tiktok URL parsers", () => {
  describe("parseUrl — event paste (video permalink)", () => {
    it("[10-03] /@handle/video/<id> returns a tiktok_post-kind ParsedUrl with the aweme id externalId", () => {
      expect(
        tiktokParseUrl("https://www.tiktok.com/@stoolpresidente/video/7649569886871522573"),
      ).toEqual({
        kind: "tiktok_post",
        externalId: "7649569886871522573",
        metadata: {
          handle: "stoolpresidente",
          permalink: "https://www.tiktok.com/@stoolpresidente/video/7649569886871522573",
        },
      });
    });

    it("[10-03] accepts a scheme-less video permalink (www.tiktok.com/...)", () => {
      const parsed = tiktokParseUrl("www.tiktok.com/@zachking/video/123");
      expect(parsed?.kind).toBe("tiktok_post");
      expect(parsed?.externalId).toBe("123");
    });

    it("[10-03] the bare tiktok.com host (no www) parses a video permalink", () => {
      expect(tiktokParseUrl("https://tiktok.com/@h/video/9")?.externalId).toBe("9");
    });

    it("[10-03] a profile URL returns null (a profile is a source, not an event)", () => {
      expect(tiktokParseUrl("https://www.tiktok.com/@stoolpresidente")).toBeNull();
    });

    it("[10-03] a foreign host returns null (host-check first)", () => {
      expect(tiktokParseUrl("https://example.com/@u/video/123")).toBeNull();
    });

    it("[10-03] a vm./vt. short link returns null (resolves via short-link first)", () => {
      expect(tiktokParseUrl("https://vm.tiktok.com/ZGef/")).toBeNull();
    });
  });

  describe("parseSourceUrl — add-source (@handle profile)", () => {
    it("[10-03] https://www.tiktok.com/@handle resolves to a tiktok_account source (D-04)", () => {
      expect(tiktokParseSourceUrl("https://www.tiktok.com/@stoolpresidente")).toEqual({
        kind: "tiktok_account",
        handle: "stoolpresidente",
        externalUrl: "https://www.tiktok.com/@stoolpresidente",
      });
    });

    it("[10-03] the bare tiktok.com host (no www) resolves the @handle", () => {
      expect(tiktokParseSourceUrl("https://tiktok.com/@zachking")?.handle).toBe("zachking");
    });

    it("[10-03] a scheme-less handle URL (tiktok.com/@handle) resolves (D-05)", () => {
      expect(tiktokParseSourceUrl("tiktok.com/@zachking")?.handle).toBe("zachking");
    });

    it("[10-03] a raw @handle (leading @) resolves to the canonical profile URL", () => {
      expect(tiktokParseSourceUrl("@zachking")).toEqual({
        kind: "tiktok_account",
        handle: "zachking",
        externalUrl: "https://www.tiktok.com/@zachking",
      });
    });

    it("[10-03] a bare handle (no @, no host) resolves to the canonical profile URL", () => {
      expect(tiktokParseSourceUrl("zachking")?.externalUrl).toBe(
        "https://www.tiktok.com/@zachking",
      );
    });

    it("[10-03] an @-prefixed DOTTED handle resolves (RAW_HANDLE_RE allows dots — FIX 5)", () => {
      // The leading @ is unambiguous, so a dotted handle is safely a handle, not a
      // hostname. Pre-fix the dot-gate (!includes('.')) sent it to the URL branch →
      // null, breaking a legitimate paste like `@game.studio`.
      expect(tiktokParseSourceUrl("@game.studio")).toEqual({
        kind: "tiktok_account",
        handle: "game.studio",
        externalUrl: "https://www.tiktok.com/@game.studio",
      });
    });

    it("[10-03] a BARE dotted string stays null/URL-branch (hostname-ambiguous)", () => {
      // No leading @ + a dot → could be a domain; it must NOT be treated as a bare
      // handle. Falls to the URL branch, where `game.studio` is a foreign host → null.
      expect(tiktokParseSourceUrl("game.studio")).toBeNull();
    });

    it("[10-03] @charlidamelio (dotless @handle) still resolves", () => {
      expect(tiktokParseSourceUrl("@charlidamelio")).toEqual({
        kind: "tiktok_account",
        handle: "charlidamelio",
        externalUrl: "https://www.tiktok.com/@charlidamelio",
      });
    });

    it("[10-03] a video permalink returns null (caller meant the post parser)", () => {
      expect(tiktokParseSourceUrl("https://www.tiktok.com/@h/video/9")).toBeNull();
    });

    it("[10-03] a foreign host returns null (host-check first)", () => {
      expect(tiktokParseSourceUrl("https://example.com/@zachking")).toBeNull();
    });
  });
});
