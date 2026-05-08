import { describe, it, expect, test } from "vitest";
import { allAdapters, getAdapter } from "$lib/sources/registry.js";

describe("SourceRegistry — Phase 03.0.1 D-14", () => {
  it("allAdapters is an array (empty pre-Plan 03; populated Wave 1)", () => {
    expect(Array.isArray(allAdapters)).toBe(true);
  });

  it("getAdapter throws on unknown kind with descriptive message", () => {
    expect(() => getAdapter("unknown_kind" as never)).toThrow(/No adapter registered/);
  });

  test.todo("getAdapter('youtube_channel') returns adapter with .kind === 'youtube_channel' — flips live in Plan 03");
  test.todo("allAdapters has length >= 1 after youtube registration — flips live in Plan 03");
  test.todo("youtubeAdapter.observability.auth.kind === 'operator-static-key' — flips live in Plan 08");
  test.todo("youtubeAdapter.parseUrl('https://www.youtube.com/watch?v=abc') returns { kind: 'youtube_video', externalId: 'abc' } — flips live in Plan 06");
  test.todo("youtubeAdapter.parseUrl('https://example.com/foo') returns null — flips live in Plan 06");
  test.todo("youtubeAdapter.canRefreshPoll('youtube_video') returns true — flips live in Plan 08");
});
