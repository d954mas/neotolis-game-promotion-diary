// Tier-eligibility assertions on the poll-cron path.
//
// Historically the scheduler.tick.{active,cold} cron drove
// src/scheduler/enqueue.ts.{enqueueActivePolls,enqueueColdPolls},
// which sent per-tier-batch jobs to poll.active / poll.cold. This test
// pinned the tier-resolver → enqueue indirection by mocking pg-boss send
// and asserting the queue + payload shape.
//
// That hop has been collapsed. The cron schedule sends tier-tagged jobs
// DIRECTLY to youtube.poll.cron; the poll-cron handler dispatches by
// job.data.tier and the per-tier handlers (handlePollActive /
// handlePollCold) now own the eligibility query + writeSnapshot pipeline.
// scheduler/enqueue.ts is deleted.
//
// This test is rewritten to invoke handlePollActive / handlePollCold
// directly with tier-tagged jobs and assert the SAME tier-eligibility
// behavior (Frozen / Unavailable / per-video-decoupled-from-source-state)
// via the youtubeChannelAdapter.pollStatsByVideoId mock — which captures
// the videoIds the handler resolved for each tier.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Capture videoIds passed to the adapter so we can assert tier eligibility.
const pollStatsCalls: Array<{ videoIds: string[]; quotaUser: string }> = [];

vi.mock("../../src/lib/sources/youtube/server/adapter.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  // The handler uses `youtubeChannelAdapter.pollStatsByVideoId`. Replace it
  // with a stub that records the call and returns 'ok' snapshots so
  // writeSnapshot succeeds (we don't care about the actual snapshot
  // contents here — only that the handler resolved the right videoIds).
  return {
    ...actual,
    youtubeChannelAdapterCore: {
      ...(actual.youtubeChannelAdapterCore as Record<string, unknown>),
      pollStatsByVideoId: async (videoIds: string[], quotaUser: string) => {
        pollStatsCalls.push({ videoIds, quotaUser });
        return videoIds.map(() => ({
          polledAt: new Date(),
          status: "ok" as const,
          metrics: { view_count: 1, like_count: 0, comment_count: 0 },
        }));
      },
    },
  };
});

// Force pickKeyForJob to return a deterministic fixture so the handler
// reaches the adapter mock above (env.SERVICE_YOUTUBE_API_KEYS is empty
// in the test env; pre-Plan-07 enqueue.ts didn't need a key, but the
// handler does).
vi.mock("../../src/lib/sources/youtube/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    pickKeyForJob: () => ({ apiKey: "test-key-sched", apiKeyId: "schedfix1" }),
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { youtubeVideos } = await import("../../src/lib/server/db/schema/index.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { resetThrottleState } = await import("../../src/lib/sources/youtube/server/quota.js");
const { handlePollActive } =
  await import("../../src/lib/sources/youtube/server/handlers/poll-active.js");
const { handlePollCold } =
  await import("../../src/lib/sources/youtube/server/handlers/poll-cold.js");
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
  pollStatsCalls.length = 0;
  resetThrottleState();
});

describe("youtube.poll.cron tier-eligibility (per-video refactor)", () => {
  it("handlePollActive picks Active-tier videos (publishedAt < 24h) and polls them", async () => {
    const u = await seedUserDirectly({ email: `sch-active-${uniq()}@test.local` });
    // The handler reads the LIVE clock (no `now` injection in Plan-07
    // model — eligibility uses `new Date()` inside the handler). Seed
    // the fixture with a recent publishedAt so it falls in Active tier.
    const recent = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12h ago
    const { videoId } = await insertEventWithVideo(u.id, recent);

    await handlePollActive({ id: "test", data: { tier: "active" } });

    expect(pollStatsCalls.length).toBeGreaterThanOrEqual(1);
    const allVideoIds = pollStatsCalls.flatMap((c) => c.videoIds);
    expect(allVideoIds).toContain(videoId);
    // quotaUser fingerprint is the service-tier constant.
    expect(pollStatsCalls[0]!.quotaUser).toBe("neotolis-svc-active");
  });

  it("handlePollCold picks Cold-tier videos (24h-28d) and polls them", async () => {
    const u = await seedUserDirectly({ email: `sch-cold-${uniq()}@test.local` });
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000);
    const { videoId } = await insertEventWithVideo(u.id, fiveDaysAgo);

    await handlePollCold({ id: "test", data: { tier: "cold" } });

    expect(pollStatsCalls.length).toBeGreaterThanOrEqual(1);
    const allVideoIds = pollStatsCalls.flatMap((c) => c.videoIds);
    expect(allVideoIds).toContain(videoId);
    expect(pollStatsCalls[0]!.quotaUser).toBe("neotolis-svc-cold");
  });

  it("Frozen videos that have already been polled (publishedAt > 28d, lastPolledAt set) are NOT polled by either tier handler", async () => {
    const u = await seedUserDirectly({ email: `sch-frozen-${uniq()}@test.local` });
    const longAgo = new Date(Date.now() - 35 * 86_400_000);
    // The bootstrap rule promotes frozen-by-age videos with
    // lastPolledAt=NULL to cold for ONE shot. To pin the
    // dormant path (already-polled video stays frozen forever), seed an
    // explicit lastPolledAt timestamp.
    const { videoId } = await insertEventWithVideo(u.id, longAgo, {
      videoOverrides: { lastPolledAt: new Date(Date.now() - 86_400_000) },
    });

    await handlePollActive({ id: "test", data: { tier: "active" } });
    await handlePollCold({ id: "test", data: { tier: "cold" } });

    const allPolledIds = pollStatsCalls.flatMap((c) => c.videoIds);
    expect(allPolledIds).not.toContain(videoId);
  });

  it("Frozen videos that have NEVER been polled (publishedAt > 28d, lastPolledAt IS NULL) ARE polled once by cold tier (bootstrap)", async () => {
    const u = await seedUserDirectly({ email: `sch-frozen-bootstrap-${uniq()}@test.local` });
    const longAgo = new Date(Date.now() - 35 * 86_400_000);
    // No videoOverrides — youtube_videos.last_polled_at column defaults
    // to NULL. The bootstrap rule (resolveTier line: frozen + lastPolledAt
    // === null → cold) makes this video eligible for handlePollCold's
    // selectEligibleVideoIds query.
    const { videoId } = await insertEventWithVideo(u.id, longAgo);

    await handlePollCold({ id: "test", data: { tier: "cold" } });

    const allPolledIds = pollStatsCalls.flatMap((c) => c.videoIds);
    expect(allPolledIds).toContain(videoId);
  });

  it("Bootstrap is dormant on active tier — never-polled active videos still classify as active, NOT cold (no double-poll across both crons)", async () => {
    const u = await seedUserDirectly({ email: `sch-active-bootstrap-${uniq()}@test.local` });
    const recent = new Date(Date.now() - 12 * 60 * 60 * 1000); // 12h ago — active
    const { videoId } = await insertEventWithVideo(u.id, recent);

    await handlePollCold({ id: "test", data: { tier: "cold" } });

    // handlePollCold's eligibility filter must reject this video — it's
    // active-tier by age and the bootstrap rule only fires for frozen.
    const allPolledIds = pollStatsCalls.flatMap((c) => c.videoIds);
    expect(allPolledIds).not.toContain(videoId);
  });

  it("Unavailable videos (last_poll_status='not_found') are NOT polled by either tier handler", async () => {
    const u = await seedUserDirectly({ email: `sch-unavail-${uniq()}@test.local` });
    const recent = new Date(Date.now() - 12 * 60 * 60 * 1000);
    const { videoId } = await insertEventWithVideo(u.id, recent, {
      videoOverrides: { lastPollStatus: "not_found" },
    });

    await handlePollActive({ id: "test", data: { tier: "active" } });
    await handlePollCold({ id: "test", data: { tier: "cold" } });

    const allPolledIds = pollStatsCalls.flatMap((c) => c.videoIds);
    expect(allPolledIds).not.toContain(videoId);
  });

  it("stats polling is per-video — source state (deletedAt, auto_import) does NOT gate eligibility", async () => {
    // Post-build review 2026-05-09 invariant: stats polling decouples from
    // source state. A video with at least one alive event IS eligible
    // regardless of whether its source is soft-deleted or has
    // auto_import=false. The auto-import path keeps its source-state gate
    // — that lives in the future auto-import worker, not in the per-video
    // tier eligibility helper.
    const u = await seedUserDirectly({ email: `sch-perVideo-${uniq()}@test.local` });
    const recent = new Date(Date.now() - 6 * 60 * 60 * 1000);

    const softDeletedSourceId = uuidv7();
    await db.insert(dataSources).values({
      id: softDeletedSourceId,
      userId: u.id,
      kind: "youtube_channel",
      handleUrl: "https://youtube.com/@deleted",
      isOwnedByMe: true,
      autoImport: true,
      deletedAt: new Date(Date.now() - 7 * 86_400_000),
      metadata: {},
    });

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

    const { videoId: fromDeletedSourceVideo } = await insertEventWithVideo(u.id, recent, {
      eventOverrides: { sourceId: softDeletedSourceId },
    });
    const { videoId: fromNoAutoSourceVideo } = await insertEventWithVideo(u.id, recent, {
      eventOverrides: { sourceId: noAutoSourceId },
    });
    const { videoId: manualPasteVideo } = await insertEventWithVideo(u.id, recent, {
      eventOverrides: { sourceId: null },
    });

    await handlePollActive({ id: "test", data: { tier: "active" } });

    const allPolledIds = pollStatsCalls.flatMap((c) => c.videoIds);
    expect(allPolledIds).toContain(fromDeletedSourceVideo);
    expect(allPolledIds).toContain(fromNoAutoSourceVideo);
    expect(allPolledIds).toContain(manualPasteVideo);
  });
});
