import { describe, it, expect } from "vitest";
import { detectFutureKind } from "$lib/sources/future-kinds.js";
import { parseAnyUrl } from "$lib/sources/url.js";
import { allAdapters } from "$lib/sources/registry.js";

describe("detectFutureKind — Reddit deferral preservation", () => {
  it("reddit.com → 'reddit_post'", () => {
    expect(detectFutureKind("https://reddit.com/r/IndieDev/comments/x/y")).toBe("reddit_post");
  });
  it("www.reddit.com → 'reddit_post'", () => {
    expect(detectFutureKind("https://www.reddit.com/r/IndieDev/foo")).toBe("reddit_post");
  });
  it("old.reddit.com → 'reddit_post'", () => {
    expect(detectFutureKind("https://old.reddit.com/r/IndieDev/foo")).toBe("reddit_post");
  });
  it("redd.it → 'reddit_post'", () => {
    expect(detectFutureKind("https://redd.it/abc123")).toBe("reddit_post");
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

  it("twitter.com URL → kind: 'unsupported' (no Twitter adapter registered)", () => {
    expect(parseAnyUrl("https://twitter.com/x/status/123").kind).toBe("unsupported");
  });

  it("reddit.com URL → kind: 'unsupported' (registry layer; ingest.ts maps to reddit_not_yet_supported)", () => {
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
