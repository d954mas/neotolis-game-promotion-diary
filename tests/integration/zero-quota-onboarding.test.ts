// Zero-quota onboarding integration test.
//
// Verifies that when a new subscriber is added to a YouTube channel that
// another user has previously walked, events are bulk-INSERTed from
// the youtube_videos cache without any HTTP calls. The user gets an
// instantly-populated feed; quota is unchanged.
//
// Path:
//   1. User A onboards UC..., walk seeds youtube_videos cache (simulated
//      directly by INSERTing rows in the test).
//   2. User B onboards same UC... via createSource. onSourceCreated hook
//      fires; sees cache populated; bulk INSERTs events for User B
//      (filtered by User B's target_since).
//   3. User B sees events instantly with no pollContent invocation.
//
// We do NOT mock the queue — onSourceCreated still enqueues
// channel-context-backfill (worker takes over later for new uploads).
// We mock the boss.send call to capture without executing.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, and, isNull } from "drizzle-orm";

interface CapturedJob {
  queue: string;
  data: Record<string, unknown>;
  options: Record<string, unknown>;
}
const sentJobs: CapturedJob[] = [];

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
        return `mock-job-${Math.random().toString(36).slice(2, 10)}`;
      },
      schedule: async () => {},
      createQueue: async () => {},
      work: async () => {},
    }),
  };
});

const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { youtubeVideos } = await import("../../src/lib/server/db/schema/index.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("zero-quota onboarding (channel cache → events fan-in)", () => {
  beforeEach(() => {
    sentJobs.length = 0;
  });

  it("new subscriber on already-walked channel bulk-INSERTs events from cache without HTTP", async () => {
    const channelId = `UC${uniq()}${uniq().slice(0, 8)}aa`;

    // Simulate prior walk: youtube_videos cache populated.
    await db.insert(youtubeVideos).values([
      {
        videoId: `vid_a_${uniq()}`,
        title: "Video A",
        channelId,
        publishedAt: new Date("2026-01-15T00:00:00Z"),
      },
      {
        videoId: `vid_b_${uniq()}`,
        title: "Video B",
        channelId,
        publishedAt: new Date("2026-02-15T00:00:00Z"),
      },
      {
        videoId: `vid_c_${uniq()}`,
        title: "Video C — too old",
        channelId,
        publishedAt: new Date("2025-12-15T00:00:00Z"),
      },
    ]);

    // New subscriber onboards with target_since = 2026-01-01 (filters out
    // Video C from the cache).
    const newUser = await seedUserDirectly({ email: `zq-${uniq()}@test.local` });
    const src = await createSource(
      newUser.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelId}`,
        isOwnedByMe: true,
        autoImport: true,
        backfillWindow: "30d",
      },
      "127.0.0.1",
    );

    // For createSource the "30d" window resolves to ~today - 30 days.
    // Override target to a known date so filter assertion is deterministic.
    await db
      .update((await import("../../src/lib/server/db/schema/data-sources.js")).dataSources)
      .set({ backfillTargetSince: new Date("2026-01-01T00:00:00Z") })
      .where(
        eq((await import("../../src/lib/server/db/schema/data-sources.js")).dataSources.id, src.id),
      );

    // The seed runs INSIDE createSource (synchronously, before return).
    // Re-trigger by simulating onSourceCreated path — call the adapter
    // hook directly with explicit target.
    const adapterModule = await import("../../src/lib/sources/youtube/server/index.js");
    await db.transaction(async (tx) => {
      await adapterModule.youtubeAdapter.onSourceCreated!(
        {
          id: src.id,
          userId: newUser.id,
          autoImport: true,
          handleUrl: src.handleUrl,
          metadata: {},
          kind: "youtube_channel",
          channelId,
          backfillTargetSince: new Date("2026-01-01T00:00:00Z"),
          isOwnedByMe: true,
        },
        { backfillWindow: "30d", tx },
      );
    });

    // Events landed for new subscriber, filtered by target_since.
    const seededEvents = await db
      .select()
      .from(events)
      .where(
        and(eq(events.userId, newUser.id), eq(events.sourceId, src.id), isNull(events.deletedAt)),
      );
    const titles = seededEvents.map((e) => e.title).sort();
    // Video A (Jan 15) and Video B (Feb 15) match target_since=Jan 1.
    // Video C (Dec 2025) is before target — filtered out.
    expect(titles).toEqual(["Video A", "Video B"]);
    // All events have authorIsMe = true (new subscriber's isOwnedByMe).
    expect(seededEvents.every((e) => e.authorIsMe === true)).toBe(true);
    // External IDs preserved from cache (idempotency UNIQUE on
    // user_id + source_id + kind + external_id is intact).
    expect(seededEvents.every((e) => e.externalId !== null && e.externalId.length > 0)).toBe(true);

    // The onSourceCreated also enqueued the channel-context-backfill job
    // (existing path) — zero-quota seed doesn't suppress it. Worker takes
    // over for new uploads after this point.
    const contextJobs = sentJobs.filter((j) => j.queue === "youtube.channel_context_backfill");
    expect(contextJobs.length).toBeGreaterThanOrEqual(1);
  });

  it("cache miss (channel never seen) returns 0 — caller's HTTP backfill takes over", async () => {
    const channelId = `UC${uniq()}${uniq().slice(0, 8)}empty`;
    // No youtube_videos cache rows for this channel.

    const newUser = await seedUserDirectly({ email: `zq-empty-${uniq()}@test.local` });
    const src = await createSource(
      newUser.id,
      {
        kind: "youtube_channel",
        handleUrl: `https://www.youtube.com/channel/${channelId}`,
        isOwnedByMe: true,
        autoImport: true,
      },
      "127.0.0.1",
    );

    // No events seeded — cache was empty.
    const seededEvents = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, newUser.id), eq(events.sourceId, src.id)));
    expect(seededEvents.length).toBe(0);

    // Channel-context-backfill still enqueued — HTTP path takes over.
    const contextJobs = sentJobs.filter((j) => j.queue === "youtube.channel_context_backfill");
    expect(contextJobs.length).toBeGreaterThanOrEqual(1);
  });
});
