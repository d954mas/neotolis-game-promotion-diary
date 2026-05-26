// Paste-flow YouTube cache contract.
//
// Closes the gap where paste-only events (kind=youtube_video, no
// registered data_source) never populated the public-data caches
// — feed-enrichment JOINed youtube_videos and found no row, so the
// channel chip rendered blank, AND selectEligibleVideoIds filtered
// on `youtube_videos.published_at IS NOT NULL` so the paste-only
// video never appeared in active/cold poll windows.
//
// Contract under test (mirrors handlePostSingle's contract for
// Reddit paste flow):
//
//   1. With Data API key configured + oEmbed reachable:
//      enrichFromUrl ⇒ youtube_videos row UPSERTed with title +
//      channel_title from oEmbed; channel_id + published_at from
//      Data API; youtube_video_snapshots row written; audit
//      event.poll_refreshed (flow=stats_refresh) written.
//
//   2. Without Data API key:
//      enrichFromUrl ⇒ youtube_videos row UPSERTed with title +
//      channel_title from oEmbed; channel_id=null,
//      published_at=null; NO snapshot row; NO audit row.
//
//   3. Re-paste within 60s:
//      Second enrichFromUrl call hits the dedup pre-check and
//      returns the cached row without a second Data API HTTP call.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";

// Mock fetch at the global level so chargedFetch's videos.list call
// returns a fixture without burning real quota. The mock is reset
// per-test to control which path each scenario exercises.
const globalFetchMock = vi.fn();
const originalFetch = globalThis.fetch;

// Mock the quota module so hasYoutubeApiKeys() / reserveYoutubeQuota
// can be toggled per-test via the `apiKeysConfigured` variable below.
let apiKeysConfigured = true;

vi.mock("../../src/lib/sources/youtube/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    hasYoutubeApiKeys: () => apiKeysConfigured,
    reserveYoutubeQuota: async (args: { origin: "cron" | "user"; units: number }) => {
      if (!apiKeysConfigured) return null;
      return {
        apiKey: "test-key-cache",
        apiKeyId: "cachetest",
        poolKind: args.origin,
        units: args.units,
      };
    },
  };
});

// Mock oEmbed so the test doesn't hit youtube.com. The fixture mirrors
// the production response shape — fetchYoutubeOembed returns kind:"ok"
// + data { title, authorName, authorUrl, thumbnailUrl }.
vi.mock("../../src/lib/server/integrations/youtube-oembed.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fetchYoutubeOembed: vi.fn(async (canonicalUrl: string) => {
      void canonicalUrl;
      return {
        kind: "ok" as const,
        data: {
          title: "Test Video Title",
          authorName: "Test Channel Name",
          authorUrl: "https://www.youtube.com/channel/UCtest1234567",
          thumbnailUrl: "https://i.ytimg.com/vi/test/hqdefault.jpg",
        },
      };
    }),
  };
});

const { enrichFromUrl } = await import("../../src/lib/server/services/events.js");
const { db } = await import("../../src/lib/server/db/client.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { youtubeVideos, youtubeVideoSnapshots } =
  await import("../../src/lib/server/db/schema/index.js");
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => uuidv7().slice(0, 8);

// YouTube video IDs are exactly 11 chars in [\w-] per services/url-parser.ts
// YOUTUBE_VIDEO_ID_RE. Tests need 11-char ids to pass parseIngestUrl's
// validate-first check.
const vid11 = (): string => {
  const raw = uuidv7().replace(/-/g, "");
  return raw.slice(0, 11);
};
const channel24 = (): string => {
  const raw = uuidv7().replace(/-/g, "");
  return `UC${raw}_${raw}`.slice(0, 24);
};

// Helper: build a minimal videos.list response. Matches the
// Zod schema in handlers/video-single.ts and the production response
// shape (kind=youtube#videoListResponse + items[].snippet + items[].statistics).
function videosListResponse(args: {
  id: string;
  channelId: string;
  publishedAt: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}): Response {
  const body = JSON.stringify({
    kind: "youtube#videoListResponse",
    items: [
      {
        id: args.id,
        snippet: {
          title: "Test Video Title",
          channelTitle: "Test Channel Name",
          channelId: args.channelId,
          publishedAt: args.publishedAt,
        },
        statistics: {
          viewCount: String(args.viewCount),
          likeCount: String(args.likeCount),
          commentCount: String(args.commentCount),
        },
      },
    ],
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("YouTube paste flow — public-data cache population", () => {
  beforeEach(() => {
    apiKeysConfigured = true;
    globalFetchMock.mockReset();
    // Default: route every fetch through the mock; tests opt-in to
    // specific responses per scenario.
    globalThis.fetch = globalFetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("with Data API key — UPSERTs youtube_videos with channel_id + published_at, writes snapshot + audit", async () => {
    const u = await seedUserDirectly({ email: `yt-cache-key-${uniq()}@test.local` });
    const videoId = vid11();
    const channelId = channel24();
    const publishedAt = "2026-03-15T12:00:00Z";

    globalFetchMock.mockResolvedValueOnce(
      videosListResponse({
        id: videoId,
        channelId,
        publishedAt,
        viewCount: 12345,
        likeCount: 678,
        commentCount: 90,
      }),
    );

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const result = await enrichFromUrl(u.id, url, "127.0.0.1");

    expect(result.kind).toBe("youtube_video");
    expect(result.externalId).toBe(videoId);
    expect(result.authorName).toBe("Test Channel Name");

    // 1. youtube_videos row exists with Data-API-derived
    //    (channel_id, published_at) columns populated. channel_title
    //    NOT on this row post no-denorm fix V-1 — it lives on
    //    youtube_channels and is read via JOIN (see
    //    docs/denormalization-policy.md). handleVideoSingle
    //    intentionally does NOT UPSERT youtube_channels (videos.list
    //    snippet lacks uploads_playlist_id which is NOT NULL on that
    //    table); the channel-context-backfill worker is the canonical
    //    writer for youtube_channels.
    const rows = await db.select().from(youtubeVideos).where(eq(youtubeVideos.videoId, videoId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.title).toBe("Test Video Title");
    expect(row.channelId).toBe(channelId);
    expect(row.publishedAt).toBeInstanceOf(Date);
    expect(row.publishedAt?.toISOString()).toBe("2026-03-15T12:00:00.000Z");
    expect(row.lastPollStatus).toBe("ok");
    expect(row.lastPolledAt).toBeInstanceOf(Date);
    // result.authorName == "Test Channel Name" already asserted above
    // (line 175) — that's the in-memory return value derived from
    // oEmbed, which is the source for live preview rendering. It is
    // NOT persisted to youtube_videos by design.

    // 2. youtube_video_snapshots row written from videos.list stats.
    const snaps = await db
      .select()
      .from(youtubeVideoSnapshots)
      .where(eq(youtubeVideoSnapshots.videoId, videoId));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.viewCount).toBe(12345);
    expect(snaps[0]!.likeCount).toBe(678);
    expect(snaps[0]!.commentCount).toBe(90);

    // 3. event.poll_refreshed audit row written (load-bearing for
    //    the per-user requestsPerDay cap counter).
    const audit = await db.select().from(auditLog).where(eq(auditLog.userId, u.id));
    const refreshRows = audit.filter((a) => a.action === "event.poll_refreshed");
    expect(refreshRows).toHaveLength(1);
    const meta = refreshRows[0]!.metadata as Record<string, unknown>;
    expect(meta.platform).toBe("youtube_channel");
    expect(meta.flow).toBe("stats_refresh");
    expect(meta.external_id).toBe(videoId);
  });

  it("without Data API key — UPSERTs youtube_videos from oEmbed only, no snapshot, no audit", async () => {
    apiKeysConfigured = false;
    const u = await seedUserDirectly({ email: `yt-cache-nokey-${uniq()}@test.local` });
    const videoId = vid11();

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const result = await enrichFromUrl(u.id, url, "127.0.0.1");

    expect(result.kind).toBe("youtube_video");
    expect(result.externalId).toBe(videoId);

    // 1. youtube_videos row exists with title from oEmbed; channel_id
    //    + published_at stay null because Data API was unavailable.
    //    channel_title NOT on this row (no-denorm fix V-1, see
    //    docs/denormalization-policy.md). result.authorName below
    //    asserts the in-memory oEmbed value surfaces for the caller.
    const rows = await db.select().from(youtubeVideos).where(eq(youtubeVideos.videoId, videoId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.title).toBe("Test Video Title");
    expect(row.channelId).toBeNull();
    expect(row.publishedAt).toBeNull();
    // last_polled_at NOT set because no Data API call happened.
    expect(row.lastPolledAt).toBeNull();
    // In-memory result surfaces channelTitle from oEmbed even with
    // no Data API key.
    expect(result.authorName).toBe("Test Channel Name");

    // 2. NO snapshot row — we never had stats.
    const snaps = await db
      .select()
      .from(youtubeVideoSnapshots)
      .where(eq(youtubeVideoSnapshots.videoId, videoId));
    expect(snaps).toHaveLength(0);

    // 3. NO audit row — audit fires only after a successful Data
    //    API hit.
    const audit = await db.select().from(auditLog).where(eq(auditLog.userId, u.id));
    const refreshRows = audit.filter((a) => a.action === "event.poll_refreshed");
    expect(refreshRows).toHaveLength(0);

    // No fetch should have been issued — handler short-circuits
    // when hasYoutubeApiKeys() returns false.
    expect(globalFetchMock).not.toHaveBeenCalled();
  });

  it("re-paste within 60s — second call is a dedup cache hit (no Data API HTTP call)", async () => {
    const u = await seedUserDirectly({ email: `yt-cache-dedup-${uniq()}@test.local` });
    const videoId = vid11();
    const channelId = channel24();

    globalFetchMock.mockResolvedValueOnce(
      videosListResponse({
        id: videoId,
        channelId,
        publishedAt: "2026-04-01T12:00:00Z",
        viewCount: 100,
        likeCount: 10,
        commentCount: 1,
      }),
    );

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    // First paste — Data API hit, cache populated.
    await enrichFromUrl(u.id, url, "127.0.0.1");
    expect(globalFetchMock).toHaveBeenCalledTimes(1);

    // Second paste immediately after — dedup window is 60s, so
    // handleVideoSingle should return cached without firing a
    // second videos.list request.
    await enrichFromUrl(u.id, url, "127.0.0.1");
    expect(globalFetchMock).toHaveBeenCalledTimes(1);

    // Single snapshot row (no second one from the dedup hit).
    const snaps = await db
      .select()
      .from(youtubeVideoSnapshots)
      .where(eq(youtubeVideoSnapshots.videoId, videoId));
    expect(snaps).toHaveLength(1);

    // Single audit row (no second one from the dedup hit).
    const audit = await db.select().from(auditLog).where(eq(auditLog.userId, u.id));
    const refreshRows = audit.filter((a) => a.action === "event.poll_refreshed");
    expect(refreshRows).toHaveLength(1);
  });

  it("paste-only video appears in selectEligibleVideoIds after enrichFromUrl with Data API key", async () => {
    // Wires the eligibility-window prerequisite — once
    // handleVideoSingle has run with Data API, the youtube_videos
    // row has published_at IS NOT NULL, which is the gate
    // selectEligibleVideoIds checks. Polling cron picks the video
    // up automatically thereafter; no manual Refresh-now needed.
    const u = await seedUserDirectly({ email: `yt-cache-eligib-${uniq()}@test.local` });
    const videoId = vid11();
    const channelId = channel24();
    // Pick a "recent" publishedAt so resolveTier classifies the
    // video as active (active boundary is age-based; old videos
    // fall into cold).
    const publishedAt = new Date(Date.now() - 7 * 86_400_000).toISOString();

    globalFetchMock.mockResolvedValueOnce(
      videosListResponse({
        id: videoId,
        channelId,
        publishedAt,
        viewCount: 500,
        likeCount: 50,
        commentCount: 5,
      }),
    );

    const url = `https://www.youtube.com/watch?v=${videoId}`;
    await enrichFromUrl(u.id, url, "127.0.0.1");

    // INSERT an events row referencing this video (paste-only —
    // source_id null) so selectEligibleVideoIds's JOIN on events
    // finds at least one alive event.
    const { events } = await import("../../src/lib/server/db/schema/events.js");
    await db.insert(events).values({
      id: uuidv7(),
      userId: u.id,
      kind: "youtube_video",
      authorIsMe: false,
      occurredAt: new Date(publishedAt),
      title: "paste-only note",
      url,
      externalId: videoId,
      metadata: {},
    });

    // Now hit the eligibility selector. The video must appear in
    // the active-tier window because:
    //   - youtube_videos.published_at is non-null (we just
    //     populated it via handleVideoSingle).
    //   - last_polled_at is set (recently polled by the same
    //     handler), but tier=active counts the window-membership
    //     check at the SQL level. resolveTier on the JS side may
    //     classify it as one of the tiers based on now-vs-published.
    //
    // The integration-level check is "video_id present in the
    // candidate query result set" — that proves the JOIN +
    // published_at gate passed. The specific tier classification
    // is the SUT of poll-eligibility-resolver tests, not this one.
    const { selectEligibleVideoIds } =
      await import("../../src/lib/server/services/poll-eligibility.js");
    // Active tier window: walk a year back so any recent video
    // falls inside the SQL window. The SUT here is "the JOIN +
    // published_at IS NOT NULL gate finds the row", not the tier
    // boundary classification (that has its own dedicated tests
    // in poll-eligibility-resolver).
    const cutoffOldest = new Date(Date.now() - 365 * 86_400_000);
    const now = new Date();
    const activeIds = await selectEligibleVideoIds(null, cutoffOldest, "active", now);
    const coldIds = await selectEligibleVideoIds(null, cutoffOldest, "cold", now);
    expect([...activeIds, ...coldIds]).toContain(videoId);
  });
});
