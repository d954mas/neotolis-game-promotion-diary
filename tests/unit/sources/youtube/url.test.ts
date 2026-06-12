// YouTube URL parsing — the /shorts/ paste intrinsic.
//
// A pasted youtube.com/shorts/<id> URL IS the Short verdict: isYoutubeShortsUrl
// reads it off the RAW input BEFORE canonicalization (youtubeParseUrl collapses
// /shorts/<id> → the same videoId as /watch?v=<id>, erasing the path signal).
// The paste flow uses isYoutubeShortsUrl to persist media_type='short' with NO
// redirect probe. A /watch / youtu.be / /embed URL carries NO Short signal —
// the poll worker's probe decides those later.

import { describe, it, expect } from "vitest";
import {
  youtubeParseUrl,
  isYoutubeShortsUrl,
} from "../../../../src/lib/sources/youtube/server/url.js";

describe("youtubeParseUrl — /shorts/ canonicalizes to the same videoId as /watch", () => {
  it("/shorts/<id> and /watch?v=<id> produce the SAME externalId + canonicalUrl", () => {
    const fromShorts = youtubeParseUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ");
    const fromWatch = youtubeParseUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(fromShorts?.externalId).toBe("dQw4w9WgXcQ");
    expect(fromShorts?.externalId).toBe(fromWatch?.externalId);
    expect((fromShorts?.metadata as { canonicalUrl: string }).canonicalUrl).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  it("/shorts/<id> with extra path/query still parses the id", () => {
    const r = youtubeParseUrl("https://www.youtube.com/shorts/abc123?feature=share");
    expect(r?.externalId).toBe("abc123");
  });
});

describe("isYoutubeShortsUrl — the paste intrinsic", () => {
  it("youtube.com/shorts/<id> → true", () => {
    expect(isYoutubeShortsUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(true);
  });

  it("m.youtube.com/shorts/<id> → true", () => {
    expect(isYoutubeShortsUrl("https://m.youtube.com/shorts/abc")).toBe(true);
  });

  it("/shorts/<id> with trailing query → true", () => {
    expect(isYoutubeShortsUrl("https://www.youtube.com/shorts/abc?si=xyz")).toBe(true);
  });

  it("/watch?v=<id> → false (no Short signal — probe decides)", () => {
    expect(isYoutubeShortsUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(false);
  });

  it("youtu.be/<id> → false", () => {
    expect(isYoutubeShortsUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(false);
  });

  it("/embed/<id> → false", () => {
    expect(isYoutubeShortsUrl("https://www.youtube.com/embed/abc")).toBe(false);
  });

  it("a non-YouTube host with a /shorts/ path → false (host gate first)", () => {
    expect(isYoutubeShortsUrl("https://example.com/shorts/abc")).toBe(false);
  });

  it("bare /shorts with no id → false", () => {
    expect(isYoutubeShortsUrl("https://www.youtube.com/shorts/")).toBe(false);
  });

  it("garbage input → false (no throw)", () => {
    expect(isYoutubeShortsUrl("not a url")).toBe(false);
    expect(isYoutubeShortsUrl("")).toBe(false);
  });
});
