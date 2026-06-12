// Twitter/X URL parsers — parseUrl (tweet permalink) + parseSourceUrl (@handle)
// (Wave-0 scaffold).
//
// Named it.skip placeholders — Plan 11-02 flips these live. Mirrors the
// #73-hardened telegram/tiktok parser shapes: host-check-first, raw-@handle /
// bare-handle before new URL(), scheme-less, www + bare host. NO t.co short-link
// host in the set (D-07 — no short-link resolve, YAGNI).
//
// Requirements: PLAT-03 (D-07 tracking-param strip).
import { describe, it } from "vitest";

describe("twitter URL parsers", () => {
  describe("parseSourceUrl — add-source (@handle)", () => {
    it.skip("[11-02] x.com/@handle -> {handle}", () => {});

    it.skip("[11-02] twitter.com/@handle -> {handle}", () => {});

    it.skip("[11-02] mobile.twitter.com / mobile.x.com -> {handle}", () => {});

    it.skip("[11-02] scheme-less host (x.com/@h) -> {handle}", () => {});

    it.skip("[11-02] a raw @handle -> {handle}", () => {});

    it.skip("[11-02] a bare handle (no @, no host) -> {handle}", () => {});

    it.skip("[11-02] a non-twitter host -> null", () => {});
  });

  describe("parseUrl — event paste (tweet permalink)", () => {
    it.skip("[11-02] x.com/<handle>/status/<id> -> {kind:'twitter_post', externalId:<id>}", () => {});

    it.skip("[11-02] twitter.com/<handle>/status/<id> -> {kind:'twitter_post', externalId:<id>}", () => {});

    it.skip("[11-02] strips ?s= / ?t= tracking params from the permalink (D-07)", () => {});

    it.skip("[11-02] a profile URL (no /status/) returns null (a profile is a source, not an event)", () => {});
  });
});
