// Phase 03.0.3 follow-up — D-#29-1 backdated-upload safety, adapter-level.
//
// Pre-fix, youtubeChannelAdapter.pollContent dropped every item with
// publishedAt <= since (the `walkedPastSince = true; continue` branch).
// Test (b) in refresh-content-quota.test.ts mocked pollContent so the
// drop was never exercised end-to-end; this file drives the REAL walker
// against a fixture playlistItems.list response with chargedFetch
// stubbed at the HTTP boundary (not at the adapter boundary).
//
// Two scenarios pinned here:
//   1. walkStop="depth" (legacy / cron / deep branch) — items with
//      publishedAt <= since ARE dropped. Existing unit tests already
//      cover this in isolation; we keep one assertion here to make the
//      contrast explicit alongside the overlap-mode test.
//   2. walkStop="overlap" (Phase 03.0.3 incremental / exhausted branches)
//      — items with publishedAt <= since are dropped ONLY when they are
//      ALSO in the youtube_videos cache. A backdated upload (publishedAt
//      far in the past, NOT in the cache) survives the walk.
//
// Stop-after-overlap: after OVERLAP_THRESHOLD=3 consecutive cached-and-
// past-since items, the walker breaks early. Single-item gaps (one
// re-upload sitting between unknown items) do NOT terminate the walk.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

vi.mock("../../src/lib/sources/youtube/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    pickKeyForJob: async () => ({ apiKey: "TEST_KEY", apiKeyId: "test-walker-key" }),
    youtubeQuotaUser: () => "test-walker-quota-user",
  };
});

interface CapturedCall {
  url: URL;
}
const fetchCalls: CapturedCall[] = [];
let fetchResponder: (url: URL) => Response = () =>
  new Response(JSON.stringify({ items: [] }), { status: 200 });

vi.mock("../../src/lib/sources/youtube/server/http.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    chargedFetch: async (url: URL): Promise<Response> => {
      fetchCalls.push({ url });
      return fetchResponder(url);
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { youtubeVideos } = await import("../../src/lib/sources/youtube/server/schema/index.js");
const { youtubeChannelAdapterCore } = await import(
  "../../src/lib/sources/youtube/server/adapter.js"
);

const uniq = (): string => Math.random().toString(36).slice(2, 10);

interface FixtureItem {
  videoId: string;
  publishedAt: string;
  title?: string;
}

function playlistResponse(items: FixtureItem[], nextPageToken?: string): Response {
  return new Response(
    JSON.stringify({
      kind: "youtube#playlistItemListResponse",
      ...(nextPageToken ? { nextPageToken } : {}),
      items: items.map((it) => ({
        snippet: {
          publishedAt: it.publishedAt,
          title: it.title ?? `Title ${it.videoId}`,
          channelId: "UCFIXTURE",
          resourceId: { videoId: it.videoId, kind: "youtube#video" },
        },
      })),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function seedYoutubeVideos(rows: Array<{ videoId: string; publishedAt: Date }>): Promise<void> {
  for (const r of rows) {
    await db
      .insert(youtubeVideos)
      .values({
        videoId: r.videoId,
        title: `Cached ${r.videoId}`,
        channelId: "UCFIXTURE",
        publishedAt: r.publishedAt,
        fetchedAt: new Date(),
      })
      .onConflictDoNothing();
  }
}

async function clearFixtures(prefix: string): Promise<void> {
  await db.delete(youtubeVideos).where(eq(youtubeVideos.channelId, "UCFIXTURE"));
  // Defensive — clear any specific prefix the test seeded directly.
  const rows = await db
    .select({ videoId: youtubeVideos.videoId })
    .from(youtubeVideos)
    .where(and(inArray(youtubeVideos.videoId, [prefix])));
  if (rows.length > 0) {
    await db.delete(youtubeVideos).where(inArray(youtubeVideos.videoId, [prefix]));
  }
}

describe("youtubeChannelAdapterCore.pollContent — D-#29-1 backdated-upload safety", () => {
  beforeEach(async () => {
    fetchCalls.length = 0;
    fetchResponder = () => new Response(JSON.stringify({ items: [] }), { status: 200 });
    await clearFixtures("");
  });

  it("walkStop='depth' drops items publishedAt <= since (legacy / deep branch behavior)", async () => {
    const now = Date.now();
    const since = new Date(now - 7 * 86_400_000); // 7d ago
    const playlist: FixtureItem[] = [
      { videoId: `wd_new1_${uniq()}`, publishedAt: new Date(now - 86_400_000).toISOString() }, // 1d ago — after since → collect
      { videoId: `wd_old1_${uniq()}`, publishedAt: new Date(now - 10 * 86_400_000).toISOString() }, // 10d ago — before since → drop
    ];
    fetchResponder = () => playlistResponse(playlist);

    const result = await youtubeChannelAdapterCore.pollContent(
      {
        id: "UCFIXTURE",
        userId: "user-test-walker",
        metadata: { uploadsPlaylistId: "UUFIXTURE", channelId: "UCFIXTURE" },
      },
      since,
      { origin: "user", walkStop: "depth" },
    );

    expect(result.events.map((e) => e.externalId)).toEqual([playlist[0]!.videoId]);
    // walkedPastSince triggered → nextPageToken cleared (undefined).
    expect(result.nextPageToken).toBeUndefined();
  });

  it("walkStop='overlap' KEEPS backdated cache-miss items (D-#29-1 invariant)", async () => {
    const now = Date.now();
    const since = new Date(now); // since = "newestKnown" = now (incremental branch shape)
    const backdatedId = `ov_backdated_${uniq()}`;
    const new1Id = `ov_new1_${uniq()}`;
    const playlist: FixtureItem[] = [
      // Page order = upload order DESC. Both items uploaded recently.
      { videoId: new1Id, publishedAt: new Date(now - 60_000).toISOString() }, // 60s ago
      { videoId: backdatedId, publishedAt: new Date(now - 90 * 86_400_000).toISOString() }, // 90d ago — past since but NOT in cache
    ];
    fetchResponder = () => playlistResponse(playlist);

    const result = await youtubeChannelAdapterCore.pollContent(
      {
        id: "UCFIXTURE",
        userId: "user-test-walker",
        metadata: { uploadsPlaylistId: "UUFIXTURE", channelId: "UCFIXTURE" },
      },
      since,
      { origin: "user", walkStop: "overlap" },
    );

    // BOTH items collected: new1 (publishedAt > since irrelevant in overlap mode)
    // AND backdated (publishedAt past since but cache-miss).
    expect(result.events.map((e) => e.externalId).sort()).toEqual([backdatedId, new1Id].sort());
  });

  it("walkStop='overlap' stops after OVERLAP_THRESHOLD=3 consecutive cached+past-since items", async () => {
    const now = Date.now();
    const since = new Date(now);
    // Seed cache with 3 known videos all dated in the past.
    const known1 = `ov_k1_${uniq()}`;
    const known2 = `ov_k2_${uniq()}`;
    const known3 = `ov_k3_${uniq()}`;
    const known4 = `ov_k4_${uniq()}`;
    await seedYoutubeVideos([
      { videoId: known1, publishedAt: new Date(now - 86_400_000) },
      { videoId: known2, publishedAt: new Date(now - 2 * 86_400_000) },
      { videoId: known3, publishedAt: new Date(now - 3 * 86_400_000) },
      { videoId: known4, publishedAt: new Date(now - 4 * 86_400_000) },
    ]);

    const new1 = `ov_n1_${uniq()}`;
    const playlist: FixtureItem[] = [
      { videoId: new1, publishedAt: new Date(now - 60_000).toISOString() },
      { videoId: known1, publishedAt: new Date(now - 86_400_000).toISOString() },
      { videoId: known2, publishedAt: new Date(now - 2 * 86_400_000).toISOString() },
      { videoId: known3, publishedAt: new Date(now - 3 * 86_400_000).toISOString() },
      // The 4th known would only be reached if the walker did NOT stop after 3.
      { videoId: known4, publishedAt: new Date(now - 4 * 86_400_000).toISOString() },
    ];
    fetchResponder = () => playlistResponse(playlist);

    const result = await youtubeChannelAdapterCore.pollContent(
      {
        id: "UCFIXTURE",
        userId: "user-test-walker",
        metadata: { uploadsPlaylistId: "UUFIXTURE", channelId: "UCFIXTURE" },
      },
      since,
      { origin: "user", walkStop: "overlap" },
    );

    // Only new1 collected. known1/known2/known3 hit the overlap threshold;
    // known4 is never even seen by the per-item loop (walker breaks at known3).
    expect(result.events.map((e) => e.externalId)).toEqual([new1]);
    // walkedPastSince → nextPageToken cleared.
    expect(result.nextPageToken).toBeUndefined();
  });

  it("walkStop='overlap' does NOT stop on single-item gaps (counter resets on unknown)", async () => {
    const now = Date.now();
    const since = new Date(now);
    const known1 = `ov_g_k1_${uniq()}`;
    const known2 = `ov_g_k2_${uniq()}`;
    await seedYoutubeVideos([
      { videoId: known1, publishedAt: new Date(now - 86_400_000) },
      { videoId: known2, publishedAt: new Date(now - 3 * 86_400_000) },
    ]);

    const new1 = `ov_g_n1_${uniq()}`;
    const new2 = `ov_g_n2_${uniq()}`;
    // Pattern: known, known, NEW (gap), known, known — counter resets at NEW,
    // so 2 known + 1 new + 2 known = walker should NOT have hit the threshold,
    // continues to endOfPlaylist.
    const playlist: FixtureItem[] = [
      { videoId: known1, publishedAt: new Date(now - 86_400_000).toISOString() },
      { videoId: known2, publishedAt: new Date(now - 3 * 86_400_000).toISOString() },
      { videoId: new1, publishedAt: new Date(now - 50 * 86_400_000).toISOString() }, // backdated, not cached
      { videoId: new2, publishedAt: new Date(now - 51 * 86_400_000).toISOString() }, // backdated, not cached
    ];
    fetchResponder = () => playlistResponse(playlist);

    const result = await youtubeChannelAdapterCore.pollContent(
      {
        id: "UCFIXTURE",
        userId: "user-test-walker",
        metadata: { uploadsPlaylistId: "UUFIXTURE", channelId: "UCFIXTURE" },
      },
      since,
      { origin: "user", walkStop: "overlap" },
    );

    // new1 and new2 both collected — the cache-miss gap reset the counter.
    expect(result.events.map((e) => e.externalId).sort()).toEqual([new1, new2].sort());
  });
});
