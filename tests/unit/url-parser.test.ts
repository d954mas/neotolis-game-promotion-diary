import { describe, it, expect } from "vitest";
import { parseIngestUrl } from "../../src/lib/server/services/url-parser.js";

/**
 * URL parser unit tests.
 *
 * The parser is pure (no I/O, no env, no DB) — these tests confirm the
 * host-routing rules and the x.com → twitter.com canonicalization that
 * downstream services rely on.
 */
describe("URL parser canonicalization", () => {
  it("parseIngestUrl handles youtube.com/watch?v=ID", () => {
    const r = parseIngestUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(r).toEqual({
      kind: "youtube_video",
      videoId: "dQw4w9WgXcQ",
      canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it("parseIngestUrl handles youtu.be/ID", () => {
    const r = parseIngestUrl("https://youtu.be/dQw4w9WgXcQ");
    expect(r.kind).toBe("youtube_video");
    if (r.kind === "youtube_video") {
      expect(r.videoId).toBe("dQw4w9WgXcQ");
      expect(r.canonicalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    }
  });

  it("parseIngestUrl handles /shorts/ID and /live/ID", () => {
    for (const path of ["shorts", "live", "embed"]) {
      const r = parseIngestUrl(`https://www.youtube.com/${path}/dQw4w9WgXcQ`);
      expect(r.kind).toBe("youtube_video");
      if (r.kind === "youtube_video") {
        expect(r.videoId).toBe("dQw4w9WgXcQ");
        expect(r.canonicalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      }
    }
  });

  it("parseIngestUrl canonicalizes x.com → twitter.com", () => {
    const r = parseIngestUrl("https://x.com/AnnaIndie/status/12345");
    expect(r.kind).toBe("twitter_post");
    if (r.kind === "twitter_post") {
      expect(r.canonicalUrl).toBe("https://twitter.com/AnnaIndie/status/12345");
    }

    // mobile.twitter.com also canonicalizes to twitter.com.
    const m = parseIngestUrl("https://mobile.twitter.com/AnnaIndie/status/12345");
    expect(m.kind).toBe("twitter_post");
    if (m.kind === "twitter_post") {
      expect(m.canonicalUrl).toBe("https://twitter.com/AnnaIndie/status/12345");
    }

    // Already-canonical twitter.com is left unchanged.
    const t = parseIngestUrl("https://twitter.com/AnnaIndie/status/12345");
    expect(t.kind).toBe("twitter_post");
    if (t.kind === "twitter_post") {
      expect(t.canonicalUrl).toContain("twitter.com/AnnaIndie/status/12345");
    }
  });

  it("parseIngestUrl returns reddit_post for reddit POST URLs (Phase 03.1 plan 09)", () => {
    // D-RDT-INGEST-REPLACE: redditAdapter.parseUrl matches POST URLs;
    // url-parser.ts now surfaces `reddit_post` directly (transitional
    // `reddit_deferred` variant removed in plan 09). services/ingest.ts
    // dispatches this variant through handlePostSingle → events INSERT.
    // Reddit identifiers are case-insensitive; the adapter lowercases
    // subreddit / username at the parser boundary so both the metadata
    // hint AND the canonicalUrl come out in lowercase form. Mixed-case
    // input ("IndieDev") normalizes to "indiedev".
    const r1 = parseIngestUrl("https://www.reddit.com/r/IndieDev/comments/abc/foo/");
    expect(r1.kind).toBe("reddit_post");
    if (r1.kind === "reddit_post") {
      expect(r1.externalId).toBe("abc");
      expect(r1.canonicalUrl).toBe("https://www.reddit.com/r/indiedev/comments/abc/");
      expect(r1.metadata).toEqual({ subreddit: "indiedev" });
    }

    const r2 = parseIngestUrl("https://redd.it/abc");
    expect(r2.kind).toBe("reddit_post");
    if (r2.kind === "reddit_post") {
      expect(r2.externalId).toBe("abc");
      // redd.it short-links don't carry the subreddit in the path; the
      // canonical fallback is the redd.it form itself until the worker
      // resolves the subreddit on first fetch.
      expect(r2.canonicalUrl).toBe("https://redd.it/abc");
      expect(r2.metadata).toEqual({ subreddit: null });
    }

    const r3 = parseIngestUrl("https://old.reddit.com/r/IndieDev/comments/xyz/foo");
    expect(r3.kind).toBe("reddit_post");
    if (r3.kind === "reddit_post") {
      expect(r3.externalId).toBe("xyz");
      expect(r3.metadata).toEqual({ subreddit: "indiedev" });
    }
  });

  it("parseIngestUrl returns unsupported for reddit SOURCE URLs (sub/user, not posts)", () => {
    // `/r/IndieDev` (subreddit landing) and `/user/anna` (account page)
    // are SOURCE-shape URLs — they belong to /sources/new flow, not the
    // EVENT ingest flow. parseAnyUrl returns `unsupported` here; the
    // user is routed to /sources/new via the friendly empty-state banner.
    expect(parseIngestUrl("https://old.reddit.com/r/foo").kind).toBe("unsupported");
    expect(parseIngestUrl("https://www.reddit.com/user/anna").kind).toBe("unsupported");
  });

  // Sanity tests — negative complements of the routes above.
  it("returns unsupported for unknown host", () => {
    expect(parseIngestUrl("https://example.com/foo").kind).toBe("unsupported");
  });

  it("returns unsupported for malformed input", () => {
    expect(parseIngestUrl("not-a-url").kind).toBe("unsupported");
    expect(parseIngestUrl("").kind).toBe("unsupported");
    expect(parseIngestUrl("   ").kind).toBe("unsupported");
  });

  it("returns unsupported for youtube host without a valid videoId", () => {
    // Hostname matches but no /watch?v= and no /shorts/ID etc → unsupported.
    expect(parseIngestUrl("https://www.youtube.com/").kind).toBe("unsupported");
    expect(parseIngestUrl("https://www.youtube.com/feed/subscriptions").kind).toBe("unsupported");
  });

  it("telegram routing", () => {
    const r = parseIngestUrl("https://t.me/somechannel/42");
    expect(r.kind).toBe("telegram_post");
    if (r.kind === "telegram_post") {
      expect(r.canonicalUrl).toContain("t.me/somechannel/42");
    }
  });
});
