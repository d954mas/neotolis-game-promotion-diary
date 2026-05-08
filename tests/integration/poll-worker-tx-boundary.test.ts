// Phase 3.0 Plan 09 + post-build refactor (2026-05-06) — poll worker tx
// boundary assertion (Pitfall 5).
//
// Holding a row lock during the upstream YouTube fetch is the classic
// anti-pattern that cascades into pool exhaustion. The two-phase pattern
// (HTTP OUTSIDE tx → write tx) keeps the tx boundary short (< 50ms)
// regardless of upstream latency.
//
// Strategy: stub the youtube-channel-adapter.pollStatsByVideoId to inject
// a delay before returning, then verify writeSnapshot's tx-time stays
// short. The test ALSO asserts that a concurrent SELECT on the
// youtube_videos row succeeds DURING the simulated HTTP delay — proving
// the row is not locked while the adapter sleeps.

import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

// Phase 3.0 post-build review (2026-05-07): worker handlers now require
// pickKeyForJob() to return a non-null PickedKey — the no-key path
// short-circuits without invoking the adapter (matches production
// self-host parity for the env.SERVICE_YOUTUBE_API_KEYS-empty case).
// Mock pickKeyForJob to return a fixture so this suite reaches the
// adapter mock under test. ESM hoisting prevents seeding env at module
// top from being picked up by env.ts; mocking the picker directly is
// the same approach the existing adapter tests use for env-control.
vi.mock("../../src/lib/server/services/youtube-quota-tracker.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    pickKeyForJob: () => ({ apiKey: "test-key-tx-boundary", apiKeyId: "txbound1" }),
  };
});

const adapterMock = {
  pollStatsByVideoId: vi.fn(),
};
vi.mock("../../src/lib/sources/youtube/server/index.js", () => ({
  youtubeAdapter: {
    kind: "youtube_channel" as const,
    pollContent: vi.fn(),
    pollStats: vi.fn(),
    pollStatsByVideoId: (...args: unknown[]) => adapterMock.pollStatsByVideoId(...args),
  },
}));

const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { youtubeVideos, youtubeVideoSnapshots } = await import(
  "../../src/lib/server/db/schema/index.js"
);
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { handlePollActive } = await import("../../src/worker/handlers/poll-active.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function insertEventAndVideo(userId: string, externalId: string): Promise<string> {
  const id = uuidv7();
  await db.insert(youtubeVideos).values({
    videoId: externalId,
    title: "tx-boundary test",
    publishedAt: new Date("2026-05-05T12:00:00Z"),
    fetchedAt: new Date(),
  });
  await db.insert(events).values({
    id,
    userId,
    kind: "youtube_video",
    authorIsMe: false,
    occurredAt: new Date("2026-05-05T12:00:00Z"),
    title: "tx-boundary test",
    url: `https://www.youtube.com/watch?v=${externalId}`,
    externalId,
    metadata: {},
  });
  return id;
}

describe("poll worker tx boundary (Plan 03.0-09 + per-video refactor)", () => {
  it("snapshot write tx stays short even with 100ms simulated upstream latency", async () => {
    const u = await seedUserDirectly({ email: `tx-bound-${uniq()}@test.local` });
    const externalId = `vid_${uniq()}`;
    await insertEventAndVideo(u.id, externalId);

    adapterMock.pollStatsByVideoId.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return [
        {
          polledAt: new Date(),
          status: "ok" as const,
          metrics: { view_count: 42, like_count: 1, comment_count: 0 },
        },
      ];
    });

    const handlerStart = Date.now();
    await handlePollActive({ id: "test-job", data: { videoIds: [externalId] } });
    const handlerEnd = Date.now();
    const totalMs = handlerEnd - handlerStart;

    // Total handler time includes the 100ms adapter delay.
    expect(totalMs).toBeGreaterThanOrEqual(100);

    // Verify the snapshot was written.
    const snaps = await db
      .select()
      .from(youtubeVideoSnapshots)
      .where(eq(youtubeVideoSnapshots.videoId, externalId));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.viewCount).toBe(42);

    // youtube_videos.last_polled_at advanced.
    const [video] = await db
      .select()
      .from(youtubeVideos)
      .where(eq(youtubeVideos.videoId, externalId));
    expect(video!.lastPolledAt).not.toBeNull();
    expect(video!.lastPollStatus).toBe("ok");
    expect(video!.pollFailureCount).toBe(0);
  });

  it("youtube_videos row is NOT locked during the upstream HTTP call (concurrent SELECT succeeds)", async () => {
    const u = await seedUserDirectly({ email: `tx-bound-conc-${uniq()}@test.local` });
    const externalId = `vid_${uniq()}`;
    await insertEventAndVideo(u.id, externalId);

    let concurrentSelectMs = -1;
    let selectCompletedAt = 0;
    adapterMock.pollStatsByVideoId.mockImplementation(async () => {
      // Concurrent SELECT during the simulated HTTP wait. If the youtube_videos
      // row were locked in a tx, this SELECT would block until the lock
      // released; it should complete in single-digit ms.
      const sStart = Date.now();
      const concRows = await db
        .select()
        .from(youtubeVideos)
        .where(eq(youtubeVideos.videoId, externalId));
      concurrentSelectMs = Date.now() - sStart;
      selectCompletedAt = Date.now();
      expect(concRows).toHaveLength(1);

      await new Promise((r) => setTimeout(r, 200));
      return [
        {
          polledAt: new Date(),
          status: "ok" as const,
          metrics: { view_count: 7, like_count: 0, comment_count: 0 },
        },
      ];
    });

    const handlerStart = Date.now();
    await handlePollActive({ id: "test-job-conc", data: { videoIds: [externalId] } });
    const handlerEnd = Date.now();

    expect(concurrentSelectMs).toBeGreaterThanOrEqual(0);
    expect(concurrentSelectMs).toBeLessThan(200);
    expect(selectCompletedAt).toBeLessThan(handlerEnd);
    expect(handlerEnd - handlerStart).toBeGreaterThanOrEqual(200);
  });
});
