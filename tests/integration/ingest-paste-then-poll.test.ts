// Manual-paste → auto-poll handoff smoke.
//
// Pasting a YouTube URL creates an event with source_id=NULL; the next
// youtube.poll.cron tick (key=active) still picks it up because the tier
// resolver keys on the VIDEO's published_at (per-video refactor), not
// the event's occurred_at, and not source_id. This test pins the unified
// contract end-to-end:
//
//   1. seed a user
//   2. insert a youtube_videos row (publishedAt=Active tier window) + a
//      youtube_video event with source_id=NULL referencing it
//   3. mock the adapter's pollStatsByVideoId to return a known snapshot
//   4. invoke handlePollActive directly with { tier: "active" }; the
//      handler internally enumerates eligible videos via
//      selectEligibleVideoIds and the seeded video should land in the
//      tier's eligible set.
//   5. run one SQL refresh worker tick and assert the
//      youtube_video_snapshots row exists + youtube_videos.
//
// The channel-context-trigger half of the paste flow is tested in
// tests/integration/ingest.test.ts. This file owns the
// "paste -> enqueue -> worker tick -> snapshot + youtube_videos UPDATE"
// pipeline.

import { describe, it, expect, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

// Worker handlers short-circuit to status='auth_error' without invoking
// the adapter when the DB-backed quota gate returns null. Mock that gate
// so this suite reaches the mocked adapter under test.
vi.mock("../../src/lib/sources/youtube/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    hasYoutubeApiKeys: () => true,
    reserveYoutubeQuota: async (args: { origin: "cron" | "user"; units: number }) => ({
      apiKey: "test-key-paste-then-poll",
      apiKeyId: "ptp00001",
      poolKind: args.origin,
      units: args.units,
    }),
  };
});

const adapterMock = {
  pollStatsByVideoId: vi.fn(),
};
// handlePollActive imports from ../adapter.js directly to avoid the
// circular barrel→handlers→barrel import.
vi.mock("../../src/lib/sources/youtube/server/adapter.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    youtubeChannelAdapterCore: {
      ...(actual.youtubeChannelAdapterCore as Record<string, unknown>),
      pollStatsByVideoId: (...args: unknown[]) => adapterMock.pollStatsByVideoId(...args),
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { adapterRefreshQueue, youtubeVideos, youtubeVideoSnapshots } =
  await import("../../src/lib/server/db/schema/index.js");
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { handlePollActive } =
  await import("../../src/lib/sources/youtube/server/handlers/poll-active.js");
const { youtubeRefreshQueueTick, __resetYoutubeRefreshQueueWorkerForTest } =
  await import("../../src/lib/sources/youtube/server/handlers/refresh-queue-tick.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("ingest paste-then-poll (per-video refactor)", () => {
  it("manual-paste event (source_id=NULL) flows through service_video queue into snapshot row", async () => {
    __resetYoutubeRefreshQueueWorkerForTest();
    await db.execute(sql`DELETE FROM adapter_refresh_queue`);
    const u = await seedUserDirectly({ email: `paste-${uniq()}@test.local` });

    // Step 1: insert a youtube_videos row + a manual-paste event (source_id
    // explicitly NULL, matching createEventFromPaste output when no
    // data_source matches). The youtube_videos row simulates the result of
    // channel-context-backfill having run before this test exercises the
    // poll path. publishedAt is set inside the Active tier window (12h ago)
    // so the handler's selectEligibleVideoIds picks it up.
    const eventId = uuidv7();
    const externalId = `pasteVid_${uniq()}`;
    const publishedAt = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12h ago
    await db.insert(youtubeVideos).values({
      videoId: externalId,
      title: "manually pasted YouTube video",
      publishedAt,
      fetchedAt: new Date(),
    });
    await db.insert(events).values({
      id: eventId,
      userId: u.id,
      kind: "youtube_video",
      authorIsMe: false,
      sourceId: null,
      occurredAt: publishedAt,
      title: "manually pasted YouTube video",
      url: `https://www.youtube.com/watch?v=${externalId}`,
      externalId,
      metadata: {},
    });

    // Step 2: stub the adapter's per-video method to return a known snapshot.
    adapterMock.pollStatsByVideoId.mockImplementation(async () => [
      {
        polledAt: new Date(),
        status: "ok" as const,
        metrics: { view_count: 1234, like_count: 56, comment_count: 7 },
      },
    ]);

    // Step 3: invoke the cron producer directly, then run one SQL refresh
    // worker tick. In production pg-boss triggers the producer, but the
    // upstream videos.list call happens only in youtubeRefreshQueueTick.
    await handlePollActive({
      id: "test-paste-job",
      data: { tier: "active" },
    });
    await db
      .update(adapterRefreshQueue)
      .set({ priority: -100 })
      .where(sql`${adapterRefreshQueue.payload}->>'video_id' = ${externalId}`);
    const tickResult = await youtubeRefreshQueueTick();
    expect(tickResult.processedQueue).toBe("service_video");

    // Step 4: snapshot row written.
    const snaps = await db
      .select()
      .from(youtubeVideoSnapshots)
      .where(eq(youtubeVideoSnapshots.videoId, externalId));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.viewCount).toBe(1234);
    expect(snaps[0]!.likeCount).toBe(56);
    expect(snaps[0]!.commentCount).toBe(7);

    // Step 5: youtube_videos.last_polled_at populated; last_poll_status = 'ok'.
    const [video] = await db
      .select()
      .from(youtubeVideos)
      .where(eq(youtubeVideos.videoId, externalId));
    expect(video!.lastPolledAt).not.toBeNull();
    expect(video!.lastPollStatus).toBe("ok");
    expect(video!.pollFailureCount).toBe(0);

    // The adapter was called with the per-video shape; the handler may
    // resolve other Active-tier videos from the test DB too (parallel
    // tests may seed extras), so we only assert the seeded videoId is
    // present in one of the calls.
    expect(adapterMock.pollStatsByVideoId).toHaveBeenCalled();
    const allCallVideoIds: string[] = [];
    for (const call of adapterMock.pollStatsByVideoId.mock.calls) {
      allCallVideoIds.push(...(call[0] as string[]));
    }
    expect(allCallVideoIds).toContain(externalId);
    // Service queue quotaUser fingerprint on every call.
    for (const call of adapterMock.pollStatsByVideoId.mock.calls) {
      expect(call[1]).toBe("neotolis-svc-video");
    }
  });
});
