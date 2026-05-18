// Phase 03.1 Plan 05A Task 3 — Reddit worker-tick round-robin + claim.
//
// Pins the 8-slot round-robin + fallthrough + FOR UPDATE SKIP LOCKED
// + permanent vs transient → dead_letter / re-pending state machine.
//
// Tests mock the 4 handler functions so no real Reddit HTTP fires.
// Each test seeds adapter_refresh_queue rows directly, advances the
// tick counter, and asserts both the dispatch (which handler was
// called with which payload) AND the final status of the row.
//
// V coverage:
//   - SELECT FOR UPDATE SKIP LOCKED (claim invariant under concurrency)
//   - REDDIT_SLOT_MAPPING (8-slot deterministic order)
//   - FALLTHROUGH_ORDER (user_post → user_source → service_post → service_source)
//   - AdapterError permanent → dead_letter
//   - AdapterError transient → pending (re-queue)
//   - MAX_ATTEMPTS=5 → dead_letter regardless of category

import { describe, it, expect, beforeEach, vi } from "vitest";
import { sql } from "drizzle-orm";

// Capture handler invocations across cases.
const subPollCalls: Array<{ sub: string; userId: string | null }> = [];
const authorPollCalls: Array<{ handle: string; userId: string | null }> = [];
const postBatchCalls: Array<{ postIds: string[]; userId: string | null }> = [];
const postSingleCalls: Array<{ postId: string; userId: string | null }> = [];

// Behaviour control — tests flip these to drive failure paths.
let subPollShouldThrow: "transient" | "permanent" | null = null;

vi.mock("../../src/lib/sources/reddit/server/handlers/sub-poll.js", async () => {
  return {
    handleSubPoll: async (args: { sub: string; userId: string | null }) => {
      subPollCalls.push({ sub: args.sub, userId: args.userId });
      if (subPollShouldThrow !== null) {
        const { AdapterError } = await import("../../src/lib/sources/errors.js");
        throw new AdapterError(`mock sub_poll throw (${subPollShouldThrow})`, {
          category: subPollShouldThrow,
        });
      }
      return { postsUpserted: 0, eventsInserted: 0 };
    },
  };
});

vi.mock("../../src/lib/sources/reddit/server/handlers/author-poll.js", async () => {
  return {
    handleAuthorPoll: async (args: { handle: string; userId: string | null }) => {
      authorPollCalls.push({ handle: args.handle, userId: args.userId });
      return { postsUpserted: 0, eventsInserted: 0 };
    },
  };
});

vi.mock("../../src/lib/sources/reddit/server/handlers/post-batch.js", async () => {
  return {
    handlePostBatch: async (args: { postIds: string[]; userId: string | null }) => {
      postBatchCalls.push({ postIds: args.postIds, userId: args.userId });
      return { presentIds: args.postIds, missingIds: [] };
    },
  };
});

vi.mock("../../src/lib/sources/reddit/server/handlers/post-single.js", async () => {
  return {
    handlePostSingle: async (args: { postId: string; userId: string | null }) => {
      postSingleCalls.push({ postId: args.postId, userId: args.userId });
      return {
        postId: args.postId,
        subreddit: "test",
        author: "op",
        authorFullname: "t2_op",
        permalink: "/r/test/comments/x",
        title: "x",
        submittedAt: new Date(),
      };
    },
    // classifySnapshotStatus is consumed by other handlers but the
    // worker-tick does not import it. Keep the shape for the mock to
    // satisfy any transitive imports.
    classifySnapshotStatus: () => "ok" as const,
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { adapterRefreshQueue } = await import("../../src/lib/server/db/schema/index.js");
const {
  redditWorkerTick,
  REDDIT_SLOT_MAPPING,
  FALLTHROUGH_ORDER,
  __resetTickCounterForTest,
  __setTickCounterForTest,
} = await import("../../src/lib/sources/reddit/server/handlers/worker-tick.js");
const { __resetRedditPacerForTest } = await import("../../src/lib/sources/reddit/server/pacer.js");

async function enqueueRow(args: {
  queueName: string;
  type: string;
  payload: Record<string, unknown>;
  userId?: string | null;
  priority?: number;
  attempts?: number;
}): Promise<number> {
  // Migration 0031 added ON DELETE CASCADE FK on adapter_refresh_queue.user_id.
  // Tests using synthetic user IDs ("user-A", "user-B", ...) now need a
  // matching user row to exist before INSERT. Ensure it idempotently.
  if (args.userId) {
    await db.execute(sql`
      INSERT INTO "user" (id, email, name, email_verified, created_at, updated_at)
      VALUES (${args.userId}, ${args.userId + "@test.local"}, ${args.userId}, true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `);
  }
  const rows = await db
    .insert(adapterRefreshQueue)
    .values({
      adapterKind: "reddit_account",
      queueName: args.queueName,
      type: args.type,
      payload: args.payload,
      userId: args.userId ?? null,
      priority: args.priority ?? 0,
      attempts: args.attempts ?? 0,
      status: "pending",
    })
    .returning({ id: adapterRefreshQueue.id });
  return rows[0]!.id;
}

async function statusOf(id: number): Promise<string> {
  const rows = await db.execute(sql`SELECT status FROM adapter_refresh_queue WHERE id = ${id}`);
  return (rows as unknown as { rows: Array<{ status: string }> }).rows[0]?.status ?? "missing";
}

async function attemptsOf(id: number): Promise<number> {
  const rows = await db.execute(sql`SELECT attempts FROM adapter_refresh_queue WHERE id = ${id}`);
  // db.execute returns raw pg.QueryResult; integers come back as JS strings
  // in some node-pg configurations. Coerce explicitly so `.toBe(1)` matches.
  const raw = (rows as unknown as { rows: Array<{ attempts: number | string }> }).rows[0]?.attempts;
  return raw === undefined ? -1 : Number(raw);
}

async function nextAttemptAtOf(id: number): Promise<Date | null> {
  const rows = await db.execute(
    sql`SELECT next_attempt_at FROM adapter_refresh_queue WHERE id = ${id}`,
  );
  const raw = (rows as unknown as { rows: Array<{ next_attempt_at: Date | string | null }> })
    .rows[0]?.next_attempt_at;
  return raw === null || raw === undefined ? null : new Date(raw);
}

beforeEach(async () => {
  subPollCalls.length = 0;
  authorPollCalls.length = 0;
  postBatchCalls.length = 0;
  postSingleCalls.length = 0;
  subPollShouldThrow = null;
  __resetTickCounterForTest();
  await __resetRedditPacerForTest();
  await db.execute(sql`DELETE FROM adapter_refresh_queue`);
});

describe("REDDIT_SLOT_MAPPING + FALLTHROUGH_ORDER constants", () => {
  it("REDDIT_SLOT_MAPPING is the locked 8-slot sequence", () => {
    expect([...REDDIT_SLOT_MAPPING]).toEqual([
      "service_source",
      "user_source",
      "user_post",
      "user_source",
      "service_post",
      "user_post",
      "user_source",
      "user_post",
    ]);
  });

  it("FALLTHROUGH_ORDER prioritises user lanes", () => {
    expect([...FALLTHROUGH_ORDER]).toEqual([
      "user_post",
      "user_source",
      "service_post",
      "service_source",
    ]);
  });
});

describe("Reddit worker tick — claim + dispatch", () => {
  it("empty queue everywhere → returns all-nulls", async () => {
    const result = await redditWorkerTick();
    expect(result.processedQueue).toBeNull();
    expect(result.processedType).toBeNull();
    expect(result.processedId).toBeNull();
  });

  it("slot 1 (service_source) with 1 sub_poll row → dispatches handleSubPoll, marks done", async () => {
    const id = await enqueueRow({
      queueName: "service_source",
      type: "sub_poll",
      payload: { sub: "indiedev" },
    });
    __setTickCounterForTest(0); // slot 1 = service_source
    const result = await redditWorkerTick();
    expect(result.processedQueue).toBe("service_source");
    expect(result.processedType).toBe("sub_poll");
    expect(result.processedId).toBe(id);
    expect(subPollCalls).toEqual([{ sub: "indiedev", userId: null }]);
    expect(await statusOf(id)).toBe("done");
    expect(await attemptsOf(id)).toBe(1);
  });

  it("DB pacer denial leaves the row pending and does not burn attempts", async () => {
    const id = await enqueueRow({
      queueName: "service_source",
      type: "sub_poll",
      payload: { sub: "indiedev" },
    });
    await db.execute(sql`
      UPDATE reddit_pacer
      SET paused_until = NOW() + INTERVAL '10 minutes',
          last_pause_reason = 'http_429',
          next_allowed_at = NOW() + INTERVAL '10 minutes'
      WHERE id = 1
    `);
    __setTickCounterForTest(0);

    const result = await redditWorkerTick();

    expect(result.processedId).toBeNull();
    expect(subPollCalls).toEqual([]);
    expect(await statusOf(id)).toBe("pending");
    expect(await attemptsOf(id)).toBe(0);
    expect((await nextAttemptAtOf(id))!.getTime()).toBeGreaterThan(Date.now());
  });

  it("fallthrough: slot=service_post empty + user_post non-empty → claims user_post", async () => {
    // Slot 5 = service_post per mapping. Enqueue 1 user_post row; 0
    // service_post rows. Per FALLTHROUGH_ORDER, user_post is first
    // fallback (highest priority). Post-refactor: post_batch type is
    // retired — all post rows are `post_single`, the worker claim-
    // batches up to 100 per tick on the post lanes.
    const userPostId = await enqueueRow({
      queueName: "user_post",
      type: "post_single",
      payload: { post_id: "t3_a" },
      userId: "user-A",
    });
    __setTickCounterForTest(4); // slotIndex 4 → slot 5 = service_post
    const result = await redditWorkerTick();
    expect(result.processedQueue).toBe("user_post");
    expect(result.processedType).toBe("post_single");
    expect(result.processedId).toBe(userPostId);
    expect(postBatchCalls.length).toBe(1);
    expect(await statusOf(userPostId)).toBe("done");
  });

  it("mapping wins when target queue is non-empty: slot=user_post + service_source row exists → claims user_post", async () => {
    // Slot 3 = user_post; service_source exists but mapping picks user_post first.
    const userPostId = await enqueueRow({
      queueName: "user_post",
      type: "post_single",
      payload: { post_id: "t3_xyz" },
      userId: "user-B",
    });
    await enqueueRow({
      queueName: "service_source",
      type: "sub_poll",
      payload: { sub: "gamedev" },
    });
    __setTickCounterForTest(2); // slotIndex 2 → slot 3 = user_post
    const result = await redditWorkerTick();
    expect(result.processedQueue).toBe("user_post");
    expect(result.processedType).toBe("post_single");
    expect(result.processedId).toBe(userPostId);
    // Post lanes dispatch through handlePostBatch (claim-time batching
    // via /api/info). A single-row claim still flows the same code path
    // — postIds carries one entry. handlePostSingle is reserved for
    // the synchronous paste-flow caller, not the worker.
    expect(postBatchCalls).toEqual([{ postIds: ["t3_xyz"], userId: "user-B" }]);
  });

  it("transient AdapterError → row returned to pending; attempts incremented", async () => {
    subPollShouldThrow = "transient";
    const id = await enqueueRow({
      queueName: "service_source",
      type: "sub_poll",
      payload: { sub: "willerror" },
    });
    __setTickCounterForTest(0);
    await redditWorkerTick();
    expect(subPollCalls.length).toBe(1);
    expect(await statusOf(id)).toBe("pending");
    expect(await attemptsOf(id)).toBe(1);
    expect((await nextAttemptAtOf(id))!.getTime()).toBeGreaterThan(Date.now());
  });

  it("permanent AdapterError → row → dead_letter regardless of attempts", async () => {
    subPollShouldThrow = "permanent";
    const id = await enqueueRow({
      queueName: "service_source",
      type: "sub_poll",
      payload: { sub: "fatal" },
    });
    __setTickCounterForTest(0);
    await redditWorkerTick();
    expect(await statusOf(id)).toBe("dead_letter");
    expect(await attemptsOf(id)).toBe(1);
  });

  it("MAX_ATTEMPTS=5: row already at attempts=4 + transient throw → dead_letter on 5th", async () => {
    subPollShouldThrow = "transient";
    const id = await enqueueRow({
      queueName: "service_source",
      type: "sub_poll",
      payload: { sub: "exhausted" },
      attempts: 4,
    });
    __setTickCounterForTest(0);
    await redditWorkerTick();
    expect(await statusOf(id)).toBe("dead_letter");
    expect(await attemptsOf(id)).toBe(5);
  });

  it("FOR UPDATE SKIP LOCKED — two parallel ticks against the same queue claim different rows", async () => {
    // Seed two service_source rows. Run two ticks "in parallel" via
    // Promise.all; both must succeed claiming different rows
    // (FOR UPDATE SKIP LOCKED is the only safe primitive here).
    const id1 = await enqueueRow({
      queueName: "service_source",
      type: "sub_poll",
      payload: { sub: "first" },
    });
    const id2 = await enqueueRow({
      queueName: "service_source",
      type: "sub_poll",
      payload: { sub: "second" },
    });
    // Both ticks start at slot 1 = service_source. Reset counter before
    // each call; the test exercises whether two concurrent ticks split
    // the queue without racing.
    __setTickCounterForTest(0);
    const r1 = redditWorkerTick();
    __setTickCounterForTest(0);
    const r2 = redditWorkerTick();
    const [res1, res2] = await Promise.all([r1, r2]);
    const ids = new Set<number | null>();
    if (res1.processedId !== null) ids.add(res1.processedId);
    if (res2.processedId !== null) ids.add(res2.processedId);
    // At minimum: no double-claim of the same id. (Both can land or one
    // can land + the other return null if PG serialisation ordered the
    // tx that way — both shapes are acceptable. The load-bearing
    // assertion is that processedId values are distinct.)
    expect(ids.size).toBe([res1.processedId, res2.processedId].filter((x) => x !== null).length);
    // No row claimed twice — exactly one row per claim.
    const status1 = await statusOf(id1);
    const status2 = await statusOf(id2);
    const claimedCount = [status1, status2].filter((s) => s !== "pending").length;
    expect(claimedCount).toBeGreaterThanOrEqual(1);
    expect(claimedCount).toBeLessThanOrEqual(2);
  });
});

describe("Reddit worker tick — dispatch by type", () => {
  it("author_poll type dispatches to handleAuthorPoll", async () => {
    await enqueueRow({
      queueName: "service_source",
      type: "author_poll",
      payload: { handle: "rickastleyyt" },
    });
    __setTickCounterForTest(0);
    await redditWorkerTick();
    expect(authorPollCalls).toEqual([{ handle: "rickastleyyt", userId: null }]);
  });

  it("claim-time batching: 3 post_single rows on service_post → ONE handlePostBatch call", async () => {
    // Per-lane maxBatchSize=100 on the service_post lane: a single
    // worker tick claims up to 100 pending post_single rows and
    // dispatches them as ONE /api/info call (handlePostBatch with the
    // collected post_ids array). This is the YouTube-shaped claim-time
    // batching that replaced the pre-refactor `post_batch` bundled
    // payload.
    await enqueueRow({
      queueName: "service_post",
      type: "post_single",
      payload: { post_id: "t3_a" },
    });
    await enqueueRow({
      queueName: "service_post",
      type: "post_single",
      payload: { post_id: "t3_b" },
    });
    await enqueueRow({
      queueName: "service_post",
      type: "post_single",
      payload: { post_id: "t3_c" },
    });
    __setTickCounterForTest(4); // slot 5 = service_post
    await redditWorkerTick();
    expect(postBatchCalls).toEqual([{ postIds: ["t3_a", "t3_b", "t3_c"], userId: null }]);
  });

  // NOTE: a previous "unknown type dead-letters via permanent AdapterError"
  // test attempted to INSERT with type='nonsense_type'. Migration 0030
  // landed a CHECK constraint on adapter_refresh_queue.type — the bad
  // row now fails at INSERT, which is the stronger guarantee. The
  // worker's unknown-type handler remains as defensive code but the
  // scenario is unreachable from the application layer.
});
