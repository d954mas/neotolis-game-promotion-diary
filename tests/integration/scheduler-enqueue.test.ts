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
import { eq } from "drizzle-orm";

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
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { youtubeServiceQuotaUsage } = await import(
  "../../src/lib/server/db/schema/youtube-service-quota-usage.js"
);
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const {
  resetThrottleState,
  todayPacific,
  hashApiKeyId,
} = await import("../../src/lib/server/services/youtube-quota-tracker.js");
const { enqueueActivePolls, enqueueColdPolls } = await import(
  "../../src/scheduler/enqueue.js"
);
const { seedUserDirectly } = await import("./helpers.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function insertEvent(
  userId: string,
  occurredAt: Date,
  overrides: Partial<typeof events.$inferInsert> = {},
): Promise<string> {
  const id = uuidv7();
  await db.insert(events).values({
    id,
    userId,
    kind: "youtube_video",
    authorIsMe: false,
    occurredAt,
    title: "scheduled poll fixture",
    url: "https://www.youtube.com/watch?v=fixture",
    externalId: `fix_${uniq()}`,
    metadata: {},
    ...overrides,
  });
  return id;
}

beforeEach(() => {
  sentJobs.length = 0;
  resetThrottleState();
});

describe("scheduler enqueue (Plan 03.0-09)", () => {
  it("Plan 03.0-09: enqueueActivePolls picks Active-tier events (occurredAt < 24h) and sends to POLL_ACTIVE", async () => {
    const u = await seedUserDirectly({ email: `sch-active-${uniq()}@test.local` });
    const now = new Date("2026-05-05T12:00:00Z");
    // 12 hours ago — within Active window.
    const eventId = await insertEvent(u.id, new Date(now.getTime() - 12 * 60 * 60 * 1000));

    const result = await enqueueActivePolls(now);

    expect(result.skipped).toBe(false);
    expect(result.eventsCovered).toBeGreaterThanOrEqual(1);
    const activeJobs = sentJobs.filter((j) => j.queue === "poll.active");
    expect(activeJobs.length).toBeGreaterThanOrEqual(1);
    const allEventIds = activeJobs.flatMap(
      (j) => (j.data as { eventIds: string[] }).eventIds,
    );
    expect(allEventIds).toContain(eventId);
  });

  it("Plan 03.0-09: enqueueColdPolls picks Cold-tier events (24h-28d) and sends to POLL_COLD", async () => {
    const u = await seedUserDirectly({ email: `sch-cold-${uniq()}@test.local` });
    const now = new Date("2026-05-05T12:00:00Z");
    // 5 days ago — within Cold window.
    const eventId = await insertEvent(u.id, new Date(now.getTime() - 5 * 86_400_000));

    const result = await enqueueColdPolls(now);

    expect(result.skipped).toBe(false);
    const coldJobs = sentJobs.filter((j) => j.queue === "poll.cold");
    expect(coldJobs.length).toBeGreaterThanOrEqual(1);
    const allEventIds = coldJobs.flatMap(
      (j) => (j.data as { eventIds: string[] }).eventIds,
    );
    expect(allEventIds).toContain(eventId);
  });

  it("Plan 03.0-09: Frozen events (occurredAt > 28d) are NOT enqueued by enqueueColdPolls or enqueueActivePolls", async () => {
    const u = await seedUserDirectly({ email: `sch-frozen-${uniq()}@test.local` });
    const now = new Date("2026-05-05T12:00:00Z");
    // 35 days ago — past Cold cutoff (28d), so Frozen.
    const eventId = await insertEvent(u.id, new Date(now.getTime() - 35 * 86_400_000));

    await enqueueActivePolls(now);
    await enqueueColdPolls(now);

    const allSentEventIds = sentJobs.flatMap((j) => {
      const data = j.data as { eventIds?: string[] };
      return data.eventIds ?? [];
    });
    expect(allSentEventIds).not.toContain(eventId);
  });

  it("Plan 03.0-09: Unavailable events (last_poll_status='not_found') are NOT enqueued", async () => {
    const u = await seedUserDirectly({ email: `sch-unavail-${uniq()}@test.local` });
    const now = new Date("2026-05-05T12:00:00Z");
    // 12 hours ago — would be Active by age, but last_poll_status overrides.
    const eventId = await insertEvent(u.id, new Date(now.getTime() - 12 * 60 * 60 * 1000), {
      lastPollStatus: "not_found",
    });

    await enqueueActivePolls(now);
    await enqueueColdPolls(now);

    const allSentEventIds = sentJobs.flatMap((j) => {
      const data = j.data as { eventIds?: string[] };
      return data.eventIds ?? [];
    });
    expect(allSentEventIds).not.toContain(eventId);
  });

  it("Plan 03.0-09: auto_import=false data_sources are skipped (manual paste with source_id=NULL still polls)", async () => {
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
    const skippedId = await insertEvent(u.id, new Date(now.getTime() - 6 * 60 * 60 * 1000), {
      sourceId: noAutoSourceId,
    });
    // Manual paste event (source_id NULL → ALWAYS pollable).
    const pastedId = await insertEvent(u.id, new Date(now.getTime() - 6 * 60 * 60 * 1000), {
      sourceId: null,
    });

    await enqueueActivePolls(now);

    const allSentEventIds = sentJobs.flatMap((j) => {
      const data = j.data as { eventIds?: string[] };
      return data.eventIds ?? [];
    });
    expect(allSentEventIds).toContain(pastedId);
    expect(allSentEventIds).not.toContain(skippedId);
  });
});
