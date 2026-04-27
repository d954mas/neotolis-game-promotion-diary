import { describe, it, expect } from "vitest";
import { parseIngestUrl } from "../../src/lib/server/services/url-parser.js";

/**
 * Plan 02-06 — URL parser unit tests. Live bodies replace the it.skip
 * placeholders Plan 02-01 shipped (Wave 0 invariant: every it.skip is
 * filled by exactly one implementing plan; no new it() calls land here).
 *
 * The parser is pure (no I/O, no env, no DB) — these tests confirm the
 * D-18 host-routing rules and Pitfall 8 (x.com → twitter.com) at the
 * canonicalization boundary that downstream services rely on.
 */
describe("URL parser canonicalization", () => {
  it("02-06: parseIngestUrl handles youtube.com/watch?v=ID", () => {
    const r = parseIngestUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(r).toEqual({
      kind: "youtube_video",
      videoId: "dQw4w9WgXcQ",
      canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it("02-06: parseIngestUrl handles youtu.be/ID", () => {
    const r = parseIngestUrl("https://youtu.be/dQw4w9WgXcQ");
    expect(r.kind).toBe("youtube_video");
    if (r.kind === "youtube_video") {
      expect(r.videoId).toBe("dQw4w9WgXcQ");
      expect(r.canonicalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    }
  });

  it("02-06: parseIngestUrl handles /shorts/ID and /live/ID", () => {
    for (const path of ["shorts", "live", "embed"]) {
      const r = parseIngestUrl(`https://www.youtube.com/${path}/dQw4w9WgXcQ`);
      expect(r.kind).toBe("youtube_video");
      if (r.kind === "youtube_video") {
        expect(r.videoId).toBe("dQw4w9WgXcQ");
        expect(r.canonicalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
      }
    }
  });

  it("02-06: parseIngestUrl canonicalizes x.com → twitter.com", () => {
    const r = parseIngestUrl("https://x.com/AnnaIndie/status/12345");
    expect(r.kind).toBe("twitter_post");
    if (r.kind === "twitter_post") {
      expect(r.canonicalUrl).toBe("https://twitter.com/AnnaIndie/status/12345");
    }

    // mobile.twitter.com also canonicalizes to twitter.com (Pitfall 8).
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

  it("02-06: parseIngestUrl returns reddit_deferred for reddit.com", () => {
    expect(parseIngestUrl("https://www.reddit.com/r/IndieDev/comments/abc/foo/").kind).toBe(
      "reddit_deferred",
    );
    expect(parseIngestUrl("https://redd.it/abc").kind).toBe("reddit_deferred");
    expect(parseIngestUrl("https://old.reddit.com/r/foo").kind).toBe("reddit_deferred");
  });

  // Sanity tests — not in Plan 02-01's named placeholder list but document
  // the negative cases covered by the same parser. Plan 02-06 owns the
  // file body so adding these here is consistent with the Wave 0 invariant
  // (no NEW behavior; these are the negative complements of the routes above).
  it("02-06: returns unsupported for unknown host", () => {
    expect(parseIngestUrl("https://example.com/foo").kind).toBe("unsupported");
  });

  it("02-06: returns unsupported for malformed input", () => {
    expect(parseIngestUrl("not-a-url").kind).toBe("unsupported");
    expect(parseIngestUrl("").kind).toBe("unsupported");
    expect(parseIngestUrl("   ").kind).toBe("unsupported");
  });

  it("02-06: returns unsupported for youtube host without a valid videoId", () => {
    // Hostname matches but no /watch?v= and no /shorts/ID etc → unsupported.
    expect(parseIngestUrl("https://www.youtube.com/").kind).toBe("unsupported");
    expect(parseIngestUrl("https://www.youtube.com/feed/subscriptions").kind).toBe("unsupported");
  });

  it("02-06: telegram routing", () => {
    const r = parseIngestUrl("https://t.me/somechannel/42");
    expect(r.kind).toBe("telegram_post");
    if (r.kind === "telegram_post") {
      expect(r.canonicalUrl).toContain("t.me/somechannel/42");
    }
  });
});
