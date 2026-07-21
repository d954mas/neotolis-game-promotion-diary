import { describe, it, expect } from "vitest";
import { parseIngestUrl } from "../../src/lib/server/services/url-parser.js";

/**
 * URL parser unit tests.
 *
 * The parser is pure (no I/O, no env, no DB) — these tests confirm the
 * host-routing rules and the canonicalization (Twitter unifies on the
 * x.com host via the adapter parser) that downstream services rely on.
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

  it("parseIngestUrl canonicalizes twitter status URLs to the x.com permalink", () => {
    // Twitter now routes through the adapter (twitterParseUrl) — the single
    // source of truth — which canonicalizes EVERY in-set host to the x.com
    // permalink. twitter.com / mobile.* are accepted but normalize to x.com.
    const r = parseIngestUrl("https://x.com/AnnaIndie/status/12345");
    expect(r.kind).toBe("twitter_post");
    if (r.kind === "twitter_post") {
      expect(r.canonicalUrl).toBe("https://x.com/AnnaIndie/status/12345");
    }

    // twitter.com / mobile.twitter.com canonicalize to the x.com permalink.
    const t = parseIngestUrl("https://twitter.com/AnnaIndie/status/12345");
    expect(t.kind).toBe("twitter_post");
    if (t.kind === "twitter_post") {
      expect(t.canonicalUrl).toBe("https://x.com/AnnaIndie/status/12345");
    }

    const m = parseIngestUrl("https://mobile.twitter.com/AnnaIndie/status/12345");
    expect(m.kind).toBe("twitter_post");
    if (m.kind === "twitter_post") {
      expect(m.canonicalUrl).toBe("https://x.com/AnnaIndie/status/12345");
    }

    // The adapter accepts a WIDER host set than the old manual fallback did:
    // www.x.com / mobile.x.com / scheme-less all parse now (previously rejected).
    for (const input of [
      "https://www.x.com/AnnaIndie/status/12345",
      "https://mobile.x.com/AnnaIndie/status/12345",
      "x.com/AnnaIndie/status/12345",
    ]) {
      const w = parseIngestUrl(input);
      expect(w.kind).toBe("twitter_post");
      if (w.kind === "twitter_post") {
        expect(w.canonicalUrl).toBe("https://x.com/AnnaIndie/status/12345");
      }
    }

    // D-07: the ?s=/?t= share-tracker tail is STRIPPED — the adapter reads only
    // the pathname, so the query never reaches the canonical permalink.
    const tailed = parseIngestUrl("https://x.com/AnnaIndie/status/12345?s=20&t=abc");
    expect(tailed.kind).toBe("twitter_post");
    if (tailed.kind === "twitter_post") {
      expect(tailed.canonicalUrl).toBe("https://x.com/AnnaIndie/status/12345");
    }

    // A bare PROFILE url is a SOURCE, not a post — the adapter returns null so
    // it falls through to `unsupported` (more correct than the old fallback,
    // which would have created a bogus twitter_post for a profile paste).
    expect(parseIngestUrl("https://x.com/AnnaIndie").kind).toBe("unsupported");
  });

  // TODO(12-05): re-enable once redditAdapter is re-wired into the registry
  // (unwired in 12-02 → parseIngestUrl returns unsupported for reddit URLs).
  it.skip("parseIngestUrl returns reddit_post for reddit POST URLs (Phase 03.1 plan 09)", () => {
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

  it("parseIngestUrl returns instagram_post for IG post/reel permalinks (Phase 08)", () => {
    // Recognition-only: the IG adapter's parseUrl matches /p/<code> and
    // /reel/<code> and canonicalizes the permalink; url-parser surfaces
    // `instagram_post` + the shortcode. There is NO single-post preview
    // fetch — enrichFromUrl returns this kind + URL with an empty title so
    // the user types it manually. The bare profile URL is a SOURCE, not an
    // event, so it must NOT be recognized here.
    const p = parseIngestUrl("https://www.instagram.com/p/CabcDEF123/");
    expect(p.kind).toBe("instagram_post");
    if (p.kind === "instagram_post") {
      expect(p.externalId).toBe("CabcDEF123");
      expect(p.canonicalUrl).toBe("https://www.instagram.com/p/CabcDEF123/");
    }

    // `/reels/<code>` (plural app route) canonicalizes to the singular
    // `/reel/<code>/` Instagram shares.
    const r = parseIngestUrl("https://instagram.com/reels/XyZ_-789/");
    expect(r.kind).toBe("instagram_post");
    if (r.kind === "instagram_post") {
      expect(r.externalId).toBe("XyZ_-789");
      expect(r.canonicalUrl).toBe("https://www.instagram.com/reel/XyZ_-789/");
    }

    // A bare profile URL is a SOURCE, not an event — not recognized here.
    expect(parseIngestUrl("https://www.instagram.com/natgeo/").kind).toBe("unsupported");
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
