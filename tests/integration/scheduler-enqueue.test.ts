// Phase 3.0 Plan 09 — scheduler enqueue assertions.
//
// Pins the tier-resolver → enqueue indirection (CONTEXT D-12 cron → DB →
// worker). Frozen and Unavailable events MUST NOT be enqueued. Active and
// Cold tier events go to the right queue. The throttle gate halts Cold at
// 'eighty' and halts both at 'ninetyfive'.
//
// pg-boss is mocked so the test does not need a live boss singleton — we
// capture sent jobs in an array and assert the queue + payload shape.

import { describe, it, expect, beforeEach, vi } from "vitest";

const sentJobs: Array<{
  queue: string;
  data: Record<string, unknown>;
  options: Record<string, unknown>;
}> = [];

vi.mock("../../src/lib/server/queue-client.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getBoss: async () => ({
      send: async (
        queue: string,
        data: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        sentJobs.push({ queue, data, options });
        return "mock-job-id";
      },
    }),
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { youtubeVideos } = await import("../../src/lib/server/db/schema/youtube-videos.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { resetThrottleState } =
  await import("../../src/lib/server/services/youtube-quota-tracker.js");
const { enqueueActivePolls, enqueueColdPolls } = await import("../../src/scheduler/enqueue.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

// Per-video refactor (2026-05-06): the scheduler keys tier on
// youtube_videos.published_at + last_poll_status, NOT events.occurred_at.
// Test fixtures must seed BOTH tables.
async function insertEventWithVideo(
  userId: string,
  publishedAt: Date,
  options: {
    eventOverrides?: Partial<typeof events.$inferInsert>;
    videoOverrides?: Partial<typeof youtubeVideos.$inferInsert>;
  } = {},
): Promise<{ eventId: string; videoId: string }> {
  const id = uuidv7();
  const videoId = `fix_${uniq()}`;
  await db.insert(youtubeVideos).values({
    videoId,
    title: "scheduled poll fixture",
    publishedAt,
    fetchedAt: new Date(),
    ...options.videoOverrides,
  });
  await db.insert(events).values({
    id,
    userId,
    kind: "youtube_video",
    authorIsMe: false,
    occurredAt: publishedAt,
    title: "scheduled poll fixture",
    url: `https://www.youtube.com/watch?v=${videoId}`,
    externalId: videoId,
    metadata: {},
    ...options.eventOverrides,
  });
  return { eventId: id, videoId };
}

beforeEach(() => {
  sentJobs.length = 0;
  resetThrottleState();
});

describe("scheduler enqueue (Plan 03.0-09 + per-video refactor)", () => {
  it("enqueueActivePolls picks Active-tier videos (publishedAt < 24h) and sends videoIds to POLL_ACTIVE", async () => {
    const u = await seedUserDirectly({ email: `sch-active-${uniq()}@test.local` });
    const now = new Date("2026-05-05T12:00:00Z");
    const { videoId } = await insertEventWithVideo(
      u.id,
      new Date(now.getTime() - 12 * 60 * 60 * 1000),
    );

    const result = await enqueueActivePolls(now);

    expect(result.skipped).toBe(false);
    expect(result.videosCovered).toBeGreaterThanOrEqual(1);
    const activeJobs = sentJobs.filter((j) => j.queue === "poll.active");
    expect(activeJobs.length).toBeGreaterThanOrEqual(1);
    const allVideoIds = activeJobs.flatMap((j) => (j.data as { videoIds: string[] }).videoIds);
    expect(allVideoIds).toContain(videoId);
  });

  it("enqueueColdPolls picks Cold-tier videos (24h-28d) and sends videoIds to POLL_COLD", async () => {
    const u = await seedUserDirectly({ email: `sch-cold-${uniq()}@test.local` });
    const now = new Date("2026-05-05T12:00:00Z");
    const { videoId } = await insertEventWithVideo(u.id, new Date(now.getTime() - 5 * 86_400_000));

    const result = await enqueueColdPolls(now);

    expect(result.skipped).toBe(false);
    const coldJobs = sentJobs.filter((j) => j.queue === "poll.cold");
    expect(coldJobs.length).toBeGreaterThanOrEqual(1);
    const allVideoIds = coldJobs.flatMap((j) => (j.data as { videoIds: string[] }).videoIds);
    expect(allVideoIds).toContain(videoId);
  });

  it("Frozen videos (publishedAt > 28d) are NOT enqueued by enqueueColdPolls or enqueueActivePolls", async () => {
    const u = await seedUserDirectly({ email: `sch-frozen-${uniq()}@test.local` });
    const now = new Date("2026-05-05T12:00:00Z");
    const { videoId } = await insertEventWithVideo(u.id, new Date(now.getTime() - 35 * 86_400_000));

    await enqueueActivePolls(now);
    await enqueueColdPolls(now);

    const allSentVideoIds = sentJobs.flatMap((j) => {
      const data = j.data as { videoIds?: string[] };
      return data.videoIds ?? [];
    });
    expect(allSentVideoIds).not.toContain(videoId);
  });

  it("Unavailable videos (last_poll_status='not_found') are NOT enqueued", async () => {
    const u = await seedUserDirectly({ email: `sch-unavail-${uniq()}@test.local` });
    const now = new Date("2026-05-05T12:00:00Z");
    const { videoId } = await insertEventWithVideo(
      u.id,
      new Date(now.getTime() - 12 * 60 * 60 * 1000),
      { videoOverrides: { lastPollStatus: "not_found" } },
    );

    await enqueueActivePolls(now);
    await enqueueColdPolls(now);

    const allSentVideoIds = sentJobs.flatMap((j) => {
      const data = j.data as { videoIds?: string[] };
      return data.videoIds ?? [];
    });
    expect(allSentVideoIds).not.toContain(videoId);
  });

  it("auto_import=false data_sources are skipped (manual paste with source_id=NULL still polls)", async () => {
    const u = await seedUserDirectly({ email: `sch-autoimp-${uniq()}@test.local` });
    const now = new Date("2026-05-05T12:00:00Z");

    // Source with auto_import = false.
    const noAutoSourceId = uuidv7();
    await db.insert(dataSources).values({
      id: noAutoSourceId,
      userId: u.id,
      kind: "youtube_channel",
      handleUrl: "https://youtube.com/@noauto",
      isOwnedByMe: true,
      autoImport: false,
      metadata: {},
    });

    // Auto-import event (source_id set, auto_import=false → SKIP).
    const { videoId: skippedVideoId } = await insertEventWithVideo(
      u.id,
      new Date(now.getTime() - 6 * 60 * 60 * 1000),
      { eventOverrides: { sourceId: noAutoSourceId } },
    );
    // Manual paste event (source_id NULL → ALWAYS pollable).
    const { videoId: pastedVideoId } = await insertEventWithVideo(
      u.id,
      new Date(now.getTime() - 6 * 60 * 60 * 1000),
      { eventOverrides: { sourceId: null } },
    );

    await enqueueActivePolls(now);

    const allSentVideoIds = sentJobs.flatMap((j) => {
      const data = j.data as { videoIds?: string[] };
      return data.videoIds ?? [];
    });
    expect(allSentVideoIds).toContain(pastedVideoId);
    expect(allSentVideoIds).not.toContain(skippedVideoId);
  });
});
