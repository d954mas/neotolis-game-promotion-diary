import { describe, it, expect, test } from "vitest";
import { allAdapters, getAdapter } from "$lib/sources/registry.js";
import type { ParsedUrl } from "$lib/sources/adapter.js";

describe("SourceRegistry — Phase 03.0.1 D-14", () => {
  it("allAdapters is an array (empty pre-Plan 03; populated Wave 1)", () => {
    expect(Array.isArray(allAdapters)).toBe(true);
  });

  it("getAdapter throws on unknown kind with descriptive message", () => {
    expect(() => getAdapter("unknown_kind" as never)).toThrow(/No adapter registered/);
  });

  it("getAdapter('youtube_channel') returns adapter with .kind === 'youtube_channel'", () => {
    const adapter = getAdapter("youtube_channel");
    expect(adapter.kind).toBe("youtube_channel");
  });

  it("allAdapters has length >= 1 after youtube registration", () => {
    expect(allAdapters.length).toBeGreaterThanOrEqual(1);
  });

  it("youtubeAdapter.canRefreshPoll('youtube_video') returns true", () => {
    const adapter = getAdapter("youtube_channel");
    expect(adapter.canRefreshPoll?.("youtube_video")).toBe(true);
  });

  it("youtubeAdapter.canRefreshPoll('reddit_post') returns false", () => {
    const adapter = getAdapter("youtube_channel");
    expect(adapter.canRefreshPoll?.("reddit_post")).toBe(false);
  });

  test.todo("youtubeAdapter.observability.auth.kind === 'operator-static-key' — flips live in Plan 08");

  it("youtubeAdapter.parseUrl('https://www.youtube.com/watch?v=abc') returns { kind: 'youtube_video', externalId: 'abc' }", () => {
    const adapter = getAdapter("youtube_channel");
    const parsed = adapter.parseUrl("https://www.youtube.com/watch?v=abc") as ParsedUrl | null;
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ kind: "youtube_video", externalId: "abc" });
  });

  it("youtubeAdapter.parseUrl('https://youtu.be/abc123') returns { kind: 'youtube_video', externalId: 'abc123' }", () => {
    const adapter = getAdapter("youtube_channel");
    const parsed = adapter.parseUrl("https://youtu.be/abc123") as ParsedUrl | null;
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ kind: "youtube_video", externalId: "abc123" });
  });

  it("youtubeAdapter.parseUrl('https://example.com/foo') returns null (non-YouTube host)", () => {
    const adapter = getAdapter("youtube_channel");
    expect(adapter.parseUrl("https://example.com/foo")).toBeNull();
  });

  it("youtubeAdapter.parseUrl('https://reddit.com/r/foo') returns null (non-YouTube host)", () => {
    const adapter = getAdapter("youtube_channel");
    expect(adapter.parseUrl("https://reddit.com/r/foo")).toBeNull();
  });
});
