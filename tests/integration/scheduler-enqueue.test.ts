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
const { youtubeVideos } = await import("../../src/lib/server/db/schema/index.js");
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

  it("stats polling is per-video — source state (deletedAt, auto_import) does NOT gate eligibility", async () => {
    // Post-build review 2026-05-09: stats polling decouples from source
    // state. A video with at least one alive event IS eligible regardless
    // of whether its source is soft-deleted or has auto_import=false. The
    // gate the scheduler USED to apply on (deletedAt, auto_import) was a
    // legacy carry-over from the per-event design; under the per-video
    // model (one videos.list per ≤50 ids serves all referencing tenants)
    // it offered no quota saving — only a "freeze stats history" UX
    // surprise after a user removed a source for declutter purposes.
    //
    // The auto-import path (creating new events from a channel's
    // playlistItems) keeps its source-state gate — that lives in the
    // future auto-import worker, not here.
    const u = await seedUserDirectly({ email: `sch-perVideo-${uniq()}@test.local` });
    const now = new Date("2026-05-05T12:00:00Z");

    // Source A — soft-deleted (the user removed it for declutter).
    const softDeletedSourceId = uuidv7();
    await db.insert(dataSources).values({
      id: softDeletedSourceId,
      userId: u.id,
      kind: "youtube_channel",
      handleUrl: "https://youtube.com/@deleted",
      isOwnedByMe: true,
      autoImport: true,
      deletedAt: new Date(now.getTime() - 7 * 86_400_000), // 7d ago
      metadata: {},
    });

    // Source B — active but auto_import=false (user disabled auto-import).
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

    // Three events, all in Active tier:
    //   1. From soft-deleted source.
    const { videoId: fromDeletedSourceVideo } = await insertEventWithVideo(
      u.id,
      new Date(now.getTime() - 6 * 60 * 60 * 1000),
      { eventOverrides: { sourceId: softDeletedSourceId } },
    );
    //   2. From auto_import=false source.
    const { videoId: fromNoAutoSourceVideo } = await insertEventWithVideo(
      u.id,
      new Date(now.getTime() - 6 * 60 * 60 * 1000),
      { eventOverrides: { sourceId: noAutoSourceId } },
    );
    //   3. Manual paste (source_id NULL).
    const { videoId: manualPasteVideo } = await insertEventWithVideo(
      u.id,
      new Date(now.getTime() - 6 * 60 * 60 * 1000),
      { eventOverrides: { sourceId: null } },
    );

    await enqueueActivePolls(now);

    const allSentVideoIds = sentJobs.flatMap((j) => {
      const data = j.data as { videoIds?: string[] };
      return data.videoIds ?? [];
    });
    expect(allSentVideoIds).toContain(fromDeletedSourceVideo);
    expect(allSentVideoIds).toContain(fromNoAutoSourceVideo);
    expect(allSentVideoIds).toContain(manualPasteVideo);
  });
});
