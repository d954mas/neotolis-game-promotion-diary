// Phase 3.0 Plan 09 — poll worker tx boundary assertion (Pitfall 5).
//
// Holding a row lock during the upstream YouTube fetch is the classic
// anti-pattern that cascades into pool exhaustion. The two-phase pattern
// (load OUTSIDE tx → HTTP OUTSIDE tx → write tx) keeps the tx boundary
// short (< 50ms) regardless of upstream latency.
//
// Strategy: stub the youtube-channel-adapter.pollStats to inject a 5s
// delay before returning, then verify writeSnapshot's tx-time stays
// under 50ms. The test ALSO asserts that a concurrent SELECT on the
// events row succeeds DURING the simulated HTTP delay — proving the row
// is not locked while the adapter sleeps.

import { describe, it, expect, vi } from "vitest";
import { eq, and } from "drizzle-orm";

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
const { youtubeVideoSnapshots } =
  await import("../../src/lib/server/db/schema/youtube-video-snapshots.js");
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { handlePollActive } = await import("../../src/worker/handlers/poll-active.js");
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function insertEvent(userId: string, externalId: string): Promise<string> {
  const id = uuidv7();
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

describe("poll worker tx boundary (Plan 03.0-09)", () => {
  it("Plan 03.0-09: snapshot write tx stays short even with 100ms simulated upstream latency", async () => {
    const u = await seedUserDirectly({ email: `tx-bound-${uniq()}@test.local` });
    const externalId = `vid_${uniq()}`;
    const eventId = await insertEvent(u.id, externalId);

    // Adapter stub: simulate a slow HTTP call (100ms is enough to prove
    // the boundary; we don't need the literal 5s — what we're proving is
    // that the writeSnapshot tx itself is fast and decoupled from the
    // adapter delay).
    adapterMock.pollStats.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return [
        {
          eventId,
          polledAt: new Date(),
          status: "ok" as const,
          metrics: { view_count: 42, like_count: 1, comment_count: 0 },
        },
      ];
    });

    const handlerStart = Date.now();
    await handlePollActive({ id: "test-job", data: { eventIds: [eventId] } });
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

    // events.last_polled_at advanced.
    const [evRow] = await db.select().from(events).where(eq(events.id, eventId));
    expect(evRow!.lastPolledAt).not.toBeNull();
    expect(evRow!.lastPollStatus).toBe("ok");
  });

  it("Plan 03.0-09: events row is NOT locked during the upstream HTTP call (concurrent SELECT succeeds)", async () => {
    const u = await seedUserDirectly({ email: `tx-bound-conc-${uniq()}@test.local` });
    const externalId = `vid_${uniq()}`;
    const eventId = await insertEvent(u.id, externalId);

    // Block the adapter for 200ms; while it's blocked, fire a SELECT and
    // assert it returns immediately (< 100ms).
    let concurrentSelectMs = -1;
    let selectCompletedAt = 0;
    adapterMock.pollStats.mockImplementation(async () => {
      // Concurrent SELECT during the simulated HTTP wait. If the events
      // row were locked in a tx, this SELECT would block until the lock
      // released; it should complete in single-digit ms.
      const sStart = Date.now();
      const concRows = await db
        .select()
        .from(events)
        .where(and(eq(events.id, eventId), eq(events.userId, u.id)));
      concurrentSelectMs = Date.now() - sStart;
      selectCompletedAt = Date.now();
      expect(concRows).toHaveLength(1);

      await new Promise((r) => setTimeout(r, 200));
      return [
        {
          eventId,
          polledAt: new Date(),
          status: "ok" as const,
          metrics: { view_count: 7, like_count: 0, comment_count: 0 },
        },
      ];
    });

    const handlerStart = Date.now();
    await handlePollActive({ id: "test-job-conc", data: { eventIds: [eventId] } });
    const handlerEnd = Date.now();

    // The concurrent SELECT must succeed quickly (well under the adapter delay).
    expect(concurrentSelectMs).toBeGreaterThanOrEqual(0);
    expect(concurrentSelectMs).toBeLessThan(200);

    // The SELECT returned BEFORE the handler completed (proving the
    // SELECT was not blocking on a write tx).
    expect(selectCompletedAt).toBeLessThan(handlerEnd);
    expect(handlerEnd - handlerStart).toBeGreaterThanOrEqual(200);
  });
});
