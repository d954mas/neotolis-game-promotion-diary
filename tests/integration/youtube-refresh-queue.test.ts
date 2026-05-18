import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const { pollStatsByVideoIdCalls, quotaMock, writeSnapshotFailures } = vi.hoisted(() => ({
  pollStatsByVideoIdCalls: [] as Array<{
    videoIds: string[];
    quotaUser: string;
    apiKeyId: string;
  }>,
  quotaMock: {
    throttleState: "ok" as "ok" | "eighty" | "ninetyfive",
    throwThrottle: false,
  },
  writeSnapshotFailures: new Set<string>(),
}));

vi.mock("../../src/lib/sources/youtube/server/adapter.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    youtubeChannelAdapterCore: {
      ...(actual.youtubeChannelAdapterCore as Record<string, unknown>),
      pollStatsByVideoId: async (
        videoIds: string[],
        quotaUser: string,
        picked: { apiKeyId: string },
      ) => {
        pollStatsByVideoIdCalls.push({ videoIds, quotaUser, apiKeyId: picked.apiKeyId });
        return videoIds.map(() => ({
          polledAt: new Date(),
          status: "ok" as const,
          metrics: { view_count: 10, like_count: 2, comment_count: 1 },
        }));
      },
    },
  };
});

vi.mock("../../src/lib/sources/youtube/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getThrottleState: async () => {
      if (quotaMock.throwThrottle) {
        throw new Error("quota guard failed");
      }
      return quotaMock.throttleState;
    },
    msUntilMidnightPacific: () => 60_000,
    hasYoutubeApiKeys: () => true,
    reserveYoutubeQuota: async (args: { origin: "cron" | "user"; units: number }) => {
      if (quotaMock.throwThrottle) {
        throw new Error("quota guard failed");
      }
      if (quotaMock.throttleState === "ninetyfive") {
        return null;
      }
      return {
        apiKey: "test-key",
        apiKeyId: "test-key-id",
        poolKind: args.origin,
        units: args.units,
      };
    },
  };
});

vi.mock("../../src/lib/sources/youtube/server/snapshots.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    writeSnapshot: async (args: { videoId: string }) => {
      if (writeSnapshotFailures.has(args.videoId)) {
        throw new Error("writeSnapshot failed");
      }
      return (actual.writeSnapshot as (a: typeof args) => Promise<void>)(args);
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { events, adapterRefreshQueue, youtubeVideos, youtubeVideoSnapshots } =
  await import("../../src/lib/server/db/schema/index.js");
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { seedUserDirectly } = await import("./helpers.js");
const { youtubeRefreshQueueTick, __resetYoutubeRefreshQueueWorkerForTest } =
  await import("../../src/lib/sources/youtube/server/handlers/refresh-queue-tick.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function insertYoutubeEvent(userId: string): Promise<typeof events.$inferSelect> {
  const id = uuidv7();
  const externalId = `ytq${uniq()}`.slice(0, 11).padEnd(11, "x");
  await db.insert(youtubeVideos).values({
    videoId: externalId,
    title: "queued video",
    publishedAt: new Date("2026-05-01T10:00:00Z"),
    fetchedAt: new Date(),
  });
  const [row] = await db
    .insert(events)
    .values({
      id,
      userId,
      kind: "youtube_video",
      authorIsMe: false,
      occurredAt: new Date("2026-05-01T10:00:00Z"),
      title: "queued video",
      url: `https://www.youtube.com/watch?v=${externalId}`,
      externalId,
      metadata: {},
    })
    .returning();
  return row!;
}

async function enqueue(event: typeof events.$inferSelect): Promise<number> {
  const [row] = await db
    .insert(adapterRefreshQueue)
    .values({
      adapterKind: "youtube_channel",
      queueName: "user_video",
      type: "video_stats",
      payload: { event_id: event.id, video_id: event.externalId, flow: "refresh-now" },
      userId: event.userId,
      priority: -10,
      status: "pending",
    })
    .returning({ id: adapterRefreshQueue.id });
  return row!.id;
}

async function enqueueServiceVideo(videoId: string): Promise<number> {
  const [row] = await db
    .insert(adapterRefreshQueue)
    .values({
      adapterKind: "youtube_channel",
      queueName: "service_video",
      type: "video_stats",
      payload: { video_id: videoId, flow: "active" },
      userId: null,
      priority: 10,
      status: "pending",
    })
    .returning({ id: adapterRefreshQueue.id });
  return row!.id;
}

beforeEach(async () => {
  pollStatsByVideoIdCalls.length = 0;
  quotaMock.throttleState = "ok";
  quotaMock.throwThrottle = false;
  writeSnapshotFailures.clear();
  __resetYoutubeRefreshQueueWorkerForTest();
  await db.execute(sql`DELETE FROM adapter_refresh_queue`);
});

describe("youtube refresh SQL queue", () => {
  it("batches refresh-now rows across users so one videos.list call can serve many tenants", async () => {
    const userA = await seedUserDirectly({ email: `ytq-a-${uniq()}@test.local` });
    const userB = await seedUserDirectly({ email: `ytq-b-${uniq()}@test.local` });
    const eventA = await insertYoutubeEvent(userA.id);
    const eventB = await insertYoutubeEvent(userB.id);
    const idA = await enqueue(eventA);
    const idB = await enqueue(eventB);

    const result = await youtubeRefreshQueueTick();

    expect(result.processedQueue).toBe("user_video");
    expect(new Set(result.processedIds)).toEqual(new Set([idA, idB]));
    expect(pollStatsByVideoIdCalls).toEqual([
      {
        videoIds: [eventA.externalId!, eventB.externalId!],
        quotaUser: "neotolis-user-refresh",
        apiKeyId: "test-key-id",
      },
    ]);

    const rows = await db
      .select({ id: adapterRefreshQueue.id, status: adapterRefreshQueue.status })
      .from(adapterRefreshQueue)
      .where(sql`${adapterRefreshQueue.id} IN (${idA}, ${idB})`);
    expect(rows.map((row) => row.status).sort()).toEqual(["done", "done"]);

    const snapshots = await db
      .select({ videoId: youtubeVideoSnapshots.videoId })
      .from(youtubeVideoSnapshots)
      .where(eq(youtubeVideoSnapshots.viewCount, 10));
    expect(new Set(snapshots.map((snapshot) => snapshot.videoId))).toEqual(
      new Set([eventA.externalId!, eventB.externalId!]),
    );
  });

  it("processes service_video rows without a tenant event lookup", async () => {
    const externalId = `svc${uniq()}`.slice(0, 11).padEnd(11, "x");
    await db.insert(youtubeVideos).values({
      videoId: externalId,
      title: "service queued video",
      publishedAt: new Date("2026-05-01T10:00:00Z"),
      fetchedAt: new Date(),
    });
    const rowId = await enqueueServiceVideo(externalId);

    const result = await youtubeRefreshQueueTick();

    expect(result.processedQueue).toBe("service_video");
    expect(result.processedIds).toEqual([rowId]);
    expect(pollStatsByVideoIdCalls).toEqual([
      {
        videoIds: [externalId],
        quotaUser: "neotolis-svc-video",
        apiKeyId: "test-key-id",
      },
    ]);

    const [row] = await db
      .select({ status: adapterRefreshQueue.status })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.id, rowId));
    expect(row!.status).toBe("done");
  });

  it("returns rows to pending when snapshot write fails", async () => {
    const externalId = `fail${uniq()}`.slice(0, 11).padEnd(11, "x");
    await db.insert(youtubeVideos).values({
      videoId: externalId,
      title: "service queued video",
      publishedAt: new Date("2026-05-01T10:00:00Z"),
      fetchedAt: new Date(),
    });
    const rowId = await enqueueServiceVideo(externalId);
    writeSnapshotFailures.add(externalId);

    const result = await youtubeRefreshQueueTick();

    expect(result.processedQueue).toBe("service_video");
    expect(result.processedIds).toEqual([rowId]);
    const [row] = await db
      .select({
        status: adapterRefreshQueue.status,
        attempts: adapterRefreshQueue.attempts,
        nextAttemptAt: adapterRefreshQueue.nextAttemptAt,
      })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.id, rowId));
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(1);
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("defers user_video rows at 95 percent quota without calling YouTube", async () => {
    const user = await seedUserDirectly({ email: `ytq-guard-${uniq()}@test.local` });
    const event = await insertYoutubeEvent(user.id);
    const rowId = await enqueue(event);
    quotaMock.throttleState = "ninetyfive";

    const result = await youtubeRefreshQueueTick();

    expect(result.processedQueue).toBeNull();
    expect(result.processedIds).toEqual([]);
    expect(pollStatsByVideoIdCalls).toEqual([]);

    const [row] = await db
      .select({
        status: adapterRefreshQueue.status,
        attempts: adapterRefreshQueue.attempts,
        nextAttemptAt: adapterRefreshQueue.nextAttemptAt,
      })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.id, rowId));
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(0);
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("defers service_video rows at 95 percent quota without calling YouTube", async () => {
    const externalId = `guard${uniq()}`.slice(0, 11).padEnd(11, "x");
    await db.insert(youtubeVideos).values({
      videoId: externalId,
      title: "guarded service queued video",
      publishedAt: new Date("2026-05-01T10:00:00Z"),
      fetchedAt: new Date(),
    });
    const rowId = await enqueueServiceVideo(externalId);
    quotaMock.throttleState = "ninetyfive";

    const result = await youtubeRefreshQueueTick();

    expect(result.processedQueue).toBeNull();
    expect(result.processedIds).toEqual([]);
    expect(pollStatsByVideoIdCalls).toEqual([]);

    const [row] = await db
      .select({
        status: adapterRefreshQueue.status,
        attempts: adapterRefreshQueue.attempts,
        nextAttemptAt: adapterRefreshQueue.nextAttemptAt,
      })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.id, rowId));
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(0);
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("defers rows without consuming attempts when the quota guard fails", async () => {
    const externalId = `gerr${uniq()}`.slice(0, 11).padEnd(11, "x");
    await db.insert(youtubeVideos).values({
      videoId: externalId,
      title: "guard error queued video",
      publishedAt: new Date("2026-05-01T10:00:00Z"),
      fetchedAt: new Date(),
    });
    const rowId = await enqueueServiceVideo(externalId);
    quotaMock.throwThrottle = true;

    const result = await youtubeRefreshQueueTick();

    expect(result.processedQueue).toBeNull();
    expect(result.processedIds).toEqual([]);
    expect(pollStatsByVideoIdCalls).toEqual([]);

    const [row] = await db
      .select({
        status: adapterRefreshQueue.status,
        attempts: adapterRefreshQueue.attempts,
        nextAttemptAt: adapterRefreshQueue.nextAttemptAt,
      })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.id, rowId));
    expect(row!.status).toBe("pending");
    expect(row!.attempts).toBe(0);
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});
