import { describe, it, expect } from "vitest";
import { allAdapters, getAdapter } from "$lib/sources/registry.js";
import type { ParsedUrl } from "$lib/sources/adapter.js";

describe("SourceRegistry", () => {
  it("allAdapters is an array", () => {
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

  it("youtubeAdapter.refreshQueue.canRefresh('youtube_video') returns true", () => {
    const adapter = getAdapter("youtube_channel");
    expect(adapter.refreshQueue?.canRefresh("youtube_video")).toBe(true);
  });

  it("youtubeAdapter.refreshQueue.canRefresh('reddit_post') returns false", () => {
    const adapter = getAdapter("youtube_channel");
    expect(adapter.refreshQueue?.canRefresh("reddit_post")).toBe(false);
  });

  it("redditAdapter declares its fixed lane worker schedule", () => {
    const adapter = getAdapter("reddit_account");
    const worker = adapter.workQueue?.scheduledWorkers[0];
    expect(worker?.name).toBe("reddit.refresh");
    expect(worker?.intervalMs).toBe(7500);
    expect(worker?.replicaPolicy).toBe("parallel");
    expect(worker?.laneQueue).toMatchObject({
      strategy: "fixed-slot-round-robin",
      adapterKind: "reddit_account",
      slots: [
        "service_source",
        "user_source",
        "user_post",
        "user_source",
        "service_post",
        "user_post",
        "user_source",
        "user_post",
      ],
      fallthrough: ["user_post", "user_source", "service_post", "service_source"],
    });
  });

  it("youtubeAdapter declares its SQL refresh worker schedule", () => {
    const adapter = getAdapter("youtube_channel");
    const worker = adapter.workQueue?.scheduledWorkers.find(
      (entry) => entry.name === "youtube.refresh",
    );
    expect(worker?.intervalMs).toBe(1000);
    expect(worker?.replicaPolicy).toBe("parallel");
    expect(worker?.laneQueue).toMatchObject({
      strategy: "fixed-slot-round-robin",
      adapterKind: "youtube_channel",
      slots: ["user_video", "service_video"],
      fallthrough: ["user_video", "service_video"],
      batchScope: "global",
    });
  });

  it("youtubeAdapter declares a syncStats quota guard", () => {
    const adapter = getAdapter("youtube_channel");
    expect(typeof adapter.syncStats?.canRun).toBe("function");
  });

  it("youtubeAdapter declares a source-backfill quota guard", () => {
    const adapter = getAdapter("youtube_channel");
    expect(typeof adapter.canBackfillSource).toBe("function");
  });

  it("redditAdapter does not treat synthetic daily observability as a syncStats hard stop", () => {
    const adapter = getAdapter("reddit_account");
    expect(adapter.syncStats?.canRun).toBeUndefined();
  });

  it("redditAdapter does not treat synthetic daily observability as a source-backfill hard stop", () => {
    const adapter = getAdapter("reddit_account");
    expect(adapter.canBackfillSource).toBeUndefined();
  });

  // Observability surface assertions: auth.kind / requiresUserSetup /
  // quota.getDailyStats shape / quota.getRecentAudit shape.

  it("youtubeAdapter.observability.auth.kind === 'operator-static-key'", () => {
    const a = getAdapter("youtube_channel");
    expect(a.observability.auth.kind).toBe("operator-static-key");
  });

  it("youtubeAdapter.observability.auth.requiresUserSetup === false", () => {
    const a = getAdapter("youtube_channel");
    expect(a.observability.auth.requiresUserSetup).toBe(false);
  });

  it("youtubeAdapter.observability.auth.isOperatorConfigured is a boolean derived from env.SERVICE_YOUTUBE_API_KEYS", () => {
    const a = getAdapter("youtube_channel");
    // The value is computed at module load time from
    // env.SERVICE_YOUTUBE_API_KEYS.length > 0. Whatever the test env yields
    // at import time, it MUST be a boolean — not undefined / not a string.
    expect(typeof a.observability.auth.isOperatorConfigured).toBe("boolean");
  });

  it("youtubeAdapter.observability.quota.getDailyStats is a function", () => {
    const a = getAdapter("youtube_channel");
    expect(typeof a.observability.quota.getDailyStats).toBe("function");
  });

  it("youtubeAdapter.observability.quota.getRecentAudit is a function", () => {
    const a = getAdapter("youtube_channel");
    expect(typeof a.observability.quota.getRecentAudit).toBe("function");
  });

  // The behavioral shape of getDailyStats / getRecentAudit (DB-backed) is
  // pinned in tests/integration/admin-quota.test.ts which runs against
  // Postgres in CI.

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
