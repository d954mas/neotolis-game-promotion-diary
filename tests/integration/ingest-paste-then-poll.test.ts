// Phase 3.0 Plan 09 — manual-paste → auto-poll handoff smoke (D-05 / D-11).
//
// Pasting a YouTube URL creates an event with source_id=NULL; the next
// scheduler tick still picks it up for poll.active because the tier
// resolver keys on (last_polled_at, occurred_at), not source_id. This
// test pins the unified contract end-to-end:
//
//   1. seed a user
//   2. insert a youtube_video event with source_id=NULL (the manual-paste shape)
//   3. mock the youtube-channel-adapter.pollStats to return a known snapshot
//   4. invoke handlePollActive directly with the eventId
//   5. assert the youtube_video_snapshots row exists + events.last_polled_at set
//
// Plan 03.0-10 (running in parallel) handles the channel-context-trigger
// half of the paste flow — that's tested in tests/integration/ingest.test.ts
// per Plan 10's plan. This file owns the "paste → events row → poll → snapshot"
// pipeline up to the worker boundary.

import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";

const adapterMock = {
  pollStats: vi.fn(),
};
vi.mock("../../src/lib/server/integrations/youtube-channel-adapter.js", () => ({
  youtubeChannelAdapter: {
    kind: "youtube_channel" as const,
    pollContent: vi.fn(),
    pollStats: (...args: unknown[]) => adapterMock.pollStats(...args),
  },
}));

const { db } = await import("../../src/lib/server/db/client.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { youtubeVideoSnapshots } = await import(
  "../../src/lib/server/db/schema/youtube-video-snapshots.js"
);
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { handlePollActive } = await import("../../src/worker/handlers/poll-active.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

describe("ingest paste-then-poll (Plan 03.0-09)", () => {
  it("Plan 03.0-09: manual-paste event (source_id=NULL) flows through handlePollActive → snapshot row + events.last_polled_at populated", async () => {
    const u = await seedUserDirectly({ email: `paste-${uniq()}@test.local` });

    // Step 1: insert a manual-paste event (source_id explicitly NULL,
    // matching createEventFromPaste output when no data_source matches).
    const eventId = uuidv7();
    const externalId = `pasteVid_${uniq()}`;
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

    // Step 2: stub the adapter to return a known snapshot for this event id.
    adapterMock.pollStats.mockImplementation(async () => [
      {
        eventId,
        polledAt: new Date(),
        status: "ok" as const,
        metrics: { view_count: 1234, like_count: 56, comment_count: 7 },
      },
    ]);

    // Step 3: invoke the worker handler directly. In production the
    // scheduler-tick handler enqueues a POLL_ACTIVE job carrying eventIds;
    // here we skip the queue boundary and call the handler directly so the
    // test does not depend on a live pg-boss singleton.
    await handlePollActive({
      id: "test-paste-job",
      data: { eventIds: [eventId] },
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

    // Step 5: events.last_polled_at populated; last_poll_status = 'ok'.
    const [row] = await db.select().from(events).where(eq(events.id, eventId));
    expect(row!.lastPolledAt).not.toBeNull();
    expect(row!.lastPollStatus).toBe("ok");

    // The adapter was called with the manual-paste shape (source = null).
    expect(adapterMock.pollStats).toHaveBeenCalledTimes(1);
    const callArgs = adapterMock.pollStats.mock.calls[0]!;
    expect(callArgs[1]).toBeNull(); // second arg is `source` and must be null for manual paste
  });
});
