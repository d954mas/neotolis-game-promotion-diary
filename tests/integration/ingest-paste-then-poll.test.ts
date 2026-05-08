// Phase 3.0 Plan 09 + post-build refactor (2026-05-06) — manual-paste →
// auto-poll handoff smoke (D-05 / D-11).
//
// Pasting a YouTube URL creates an event with source_id=NULL; the next
// scheduler tick still picks it up for poll.active because the tier
// resolver keys on the VIDEO's published_at (per-video refactor), not
// the event's occurred_at, and not source_id. This test pins the unified
// contract end-to-end:
//
//   1. seed a user
//   2. insert a youtube_videos row + youtube_video event with source_id=NULL
//   3. mock the adapter's pollStatsByVideoId to return a known snapshot
//   4. invoke handlePollActive directly with { videoIds: [...] }
//   5. assert the youtube_video_snapshots row exists + youtube_videos.
//      last_polled_at + last_poll_status='ok' set
//
// Plan 03.0-10 handles the channel-context-trigger half of the paste flow
// — that's tested in tests/integration/ingest.test.ts. This file owns the
// "paste → poll → snapshot + youtube_videos UPDATE" pipeline.

import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

// Phase 3.0 post-build review (2026-05-07): worker handlers short-circuit
// to status='auth_error' without invoking the adapter when
// pickKeyForJob() returns null. Mock pickKeyForJob to return a fixture
// so this suite reaches the mocked adapter under test.
vi.mock("../../src/lib/sources/youtube/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    pickKeyForJob: () => ({ apiKey: "test-key-paste-then-poll", apiKeyId: "ptp00001" }),
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
const { handlePollActive } = await import(
  "../../src/lib/sources/youtube/server/handlers/poll-active.js"
);
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("ingest paste-then-poll (Plan 03.0-09 + per-video refactor)", () => {
  it("manual-paste event (source_id=NULL) flows through handlePollActive → snapshot row + youtube_videos.last_polled_at populated", async () => {
    const u = await seedUserDirectly({ email: `paste-${uniq()}@test.local` });

    // Step 1: insert a youtube_videos row + a manual-paste event (source_id
    // explicitly NULL, matching createEventFromPaste output when no
    // data_source matches). The youtube_videos row simulates the result of
    // channel-context-backfill having run before this test exercises the
    // poll path.
    const eventId = uuidv7();
    const externalId = `pasteVid_${uniq()}`;
    await db.insert(youtubeVideos).values({
      videoId: externalId,
      title: "manually pasted YouTube video",
      publishedAt: new Date(),
      fetchedAt: new Date(),
    });
    await db.insert(events).values({
      id: eventId,
      userId: u.id,
      kind: "youtube_video",
      authorIsMe: false,
      sourceId: null,
      occurredAt: new Date(),
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

    // Step 3: invoke the worker handler directly. In production the
    // scheduler-tick handler enqueues a POLL_ACTIVE job carrying videoIds;
    // here we skip the queue boundary and call the handler directly so the
    // test does not depend on a live pg-boss singleton.
    await handlePollActive({
      id: "test-paste-job",
      data: { videoIds: [externalId] },
    });

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

    // The adapter was called once with the per-video shape.
    expect(adapterMock.pollStatsByVideoId).toHaveBeenCalledTimes(1);
    const callArgs = adapterMock.pollStatsByVideoId.mock.calls[0]!;
    expect(callArgs[0]).toEqual([externalId]);
    expect(callArgs[1]).toBe("neotolis-svc-active"); // service-tier quotaUser fingerprint
  });
});
