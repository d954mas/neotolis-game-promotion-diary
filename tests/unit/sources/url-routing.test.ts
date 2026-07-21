import { describe, it, expect } from "vitest";
import { detectFutureKind } from "$lib/sources/future-kinds.js";
import { parseAnyUrl } from "$lib/sources/url.js";
import { allAdapters } from "$lib/sources/registry.js";

describe("detectFutureKind — empty map post Phase 03.1 (D-RDT-INGEST-REPLACE)", () => {
  // Phase 03.1 landed the Reddit adapter and removed reddit hosts from
  // FUTURE_KIND_HOSTS — the registry-driven parseAnyUrl iterator now
  // matches reddit.com / redd.it via redditAdapter.parseUrl. The map is
  // currently empty; future deferred adapters (Twitter / Telegram /
  // Discord) repopulate it as their hosts surface.
  it("reddit.com → null (handled by registry; no longer a future-kind)", () => {
    expect(detectFutureKind("https://reddit.com/r/IndieDev/comments/x/y")).toBeNull();
  });
  it("www.reddit.com → null (handled by registry)", () => {
    expect(detectFutureKind("https://www.reddit.com/r/IndieDev/foo")).toBeNull();
  });
  it("old.reddit.com → null (handled by registry)", () => {
    expect(detectFutureKind("https://old.reddit.com/r/IndieDev/foo")).toBeNull();
  });
  it("redd.it → null (handled by registry)", () => {
    expect(detectFutureKind("https://redd.it/abc123")).toBeNull();
  });
  it("twitter.com → null (twitter not on the future-kinds map)", () => {
    expect(detectFutureKind("https://twitter.com/x/status/123")).toBeNull();
  });
  it("example.com → null", () => {
    expect(detectFutureKind("https://example.com/foo")).toBeNull();
  });
  it("malformed URL → null (no throw)", () => {
    expect(detectFutureKind("not a url")).toBeNull();
  });
});

describe("parseAnyUrl — first-match-wins iterate-registry", () => {
  it("registry has at least one adapter (precondition for first-match-wins)", () => {
    expect(allAdapters.length).toBeGreaterThanOrEqual(1);
  });

  it("youtube.com /watch?v=<id> → kind: 'youtube_video' with externalId", () => {
    const r = parseAnyUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(r.kind).toBe("youtube_video");
    expect((r as { externalId: string }).externalId).toBe("dQw4w9WgXcQ");
  });

  it("youtu.be/<id> → kind: 'youtube_video' with externalId", () => {
    const r = parseAnyUrl("https://youtu.be/abc123XYZ");
    expect(r.kind).toBe("youtube_video");
    expect((r as { externalId: string }).externalId).toBe("abc123XYZ");
  });

  it("m.youtube.com/watch?v=<id> → kind: 'youtube_video'", () => {
    const r = parseAnyUrl("https://m.youtube.com/watch?v=xyz");
    expect(r.kind).toBe("youtube_video");
  });

  it("youtube.com/shorts/<id> → kind: 'youtube_video' (Shorts)", () => {
    const r = parseAnyUrl("https://www.youtube.com/shorts/abc");
    expect(r.kind).toBe("youtube_video");
  });

  it("youtube.com/embed/<id> → kind: 'youtube_video'", () => {
    const r = parseAnyUrl("https://www.youtube.com/embed/abc");
    expect(r.kind).toBe("youtube_video");
  });

  it("twitter.com /<handle>/status/<id> → kind: 'twitter_post' via twitterAdapter (Phase 11)", () => {
    // Phase 11 registered twitterAdapter; a status permalink now resolves to a
    // twitter_post event with the URL-intrinsic numeric tweet id (?s=/?t= stripped).
    const r = parseAnyUrl("https://twitter.com/ConcernedApe/status/123");
    expect(r.kind).toBe("twitter_post");
    expect((r as { externalId: string }).externalId).toBe("123");
  });

  // TODO(12-05): re-enable both once redditAdapter is re-wired into the registry
  // (unwired in 12-02 → parseAnyUrl returns 'unsupported' for reddit URLs).
  it.skip("reddit.com /r/X/comments/<id> POST URL → kind: 'reddit_post' via redditAdapter (Phase 03.1)", () => {
    const r = parseAnyUrl("https://reddit.com/r/IndieDev/comments/abc123/foo-slug");
    expect(r.kind).toBe("reddit_post");
    expect((r as { externalId: string }).externalId).toBe("abc123");
  });

  it.skip("redd.it short-link → kind: 'reddit_post' via redditAdapter (Phase 03.1)", () => {
    const r = parseAnyUrl("https://redd.it/abc123");
    expect(r.kind).toBe("reddit_post");
    expect((r as { externalId: string }).externalId).toBe("abc123");
  });

  it("reddit.com /r/X (subreddit landing) → kind: 'unsupported' (sources, not events)", () => {
    // /sources/new uses redditAdapter.parseSourceUrl for the SOURCE form;
    // the EVENT-shape parseAnyUrl iterator only recognizes POST URLs.
    expect(parseAnyUrl("https://reddit.com/r/IndieDev").kind).toBe("unsupported");
  });

  it("malformed input → kind: 'unsupported'", () => {
    expect(parseAnyUrl("not a url").kind).toBe("unsupported");
  });

  it("youtube.com/channel/<id> → kind: 'unsupported' (channels are not events)", () => {
    expect(parseAnyUrl("https://www.youtube.com/channel/UCxyz").kind).toBe("unsupported");
  });

  it("youtube.com/@handle → kind: 'unsupported' (handles are not events)", () => {
    expect(parseAnyUrl("https://www.youtube.com/@somecreator").kind).toBe("unsupported");
  });
});
