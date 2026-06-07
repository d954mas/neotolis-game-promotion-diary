// Instagram per-post Refresh lane (#69 follow-on).
//
// Manual "Refresh now" for IG now enqueues ONE adapter_refresh_queue row per post
// (queue_name "user_post"); the IG lane worker (handlers/refresh-queue-tick.ts)
// claims up to N rows/tick (concurrent, global) and refreshes EXACTLY those posts
// via the single-post endpoint — not the old account-level walk.
//
// Integration test — real Postgres via ./helpers.js. Two seams are mocked: the
// provider's getSocialProvider (the upstream HTTP) and getSocialThrottleState
// (the claimGate's throttle band, so the test controls it deterministically
// instead of depending on the operator-budget env). NEVER mocks the DB.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { NormalizedSinglePost } from "../../src/lib/sources/social-provider.js";

interface ScriptedSinglePost {
  next: NormalizedSinglePost | null;
  calls: Array<{ url: string; origin?: string }>;
}
const single: ScriptedSinglePost = { next: null, calls: [] };
let throttleState: "ok" | "eighty" | "ninetyfive" = "ok";

vi.mock("../../src/lib/sources/instagram/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isInstagramConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "instagram") return null;
      return {
        name: "scrapecreators",
        async fetchPostByUrl(
          _platform: string,
          url: string,
          opts: { origin?: string },
        ): Promise<NormalizedSinglePost | null> {
          single.calls.push({ url, origin: opts.origin });
          return single.next;
        },
        async fetchPosts() {
          return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1 };
        },
        async resolveAccount() {
          return { accountId: "acct", displayName: "X" };
        },
      };
    },
  };
});

vi.mock("../../src/lib/sources/instagram/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSocialThrottleState: async () => throttleState };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { events, instagramPosts, instagramPostSnapshots, adapterRefreshQueue } =
  await import("../../src/lib/server/db/schema/index.js");
const { createEvent } = await import("../../src/lib/server/services/events-mutation.js");
const { instagramAdapter } = await import("../../src/lib/sources/instagram/server/index.js");
const { instagramRefreshQueueTick, __resetInstagramRefreshQueueWorkerForTest } =
  await import("../../src/lib/sources/instagram/server/handlers/refresh-queue-tick.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

function post(overrides: Partial<NormalizedSinglePost> = {}): NormalizedSinglePost {
  return {
    id: "3912161556549155524_24549572243",
    shortcode: "ABC",
    kind: "carousel",
    publishedAt: new Date("2026-06-01T12:00:00Z"),
    metrics: { views: null, likes: 99, comments: 3 },
    caption: "cap",
    thumbnailUrl: "https://scontent.cdninstagram.com/x.jpg",
    ownerId: "24549572243",
    ownerUsername: "d954mas",
    ...overrides,
  };
}

/** Seed an IG event (+ its public-data instagram_posts cache row with a permalink)
 *  for `userId`, returning the media id used as external_id + the event id. */
async function seedIgEvent(
  userId: string,
  postId: string,
): Promise<{ postId: string; eventId: string }> {
  await db
    .insert(instagramPosts)
    .values({
      postId,
      accountId: "24549572243",
      permalink: `https://www.instagram.com/p/${postId.slice(0, 6)}/`,
      mediaType: "carousel",
    })
    .onConflictDoNothing();
  const ev = await createEvent(
    userId,
    {
      kind: "instagram_post",
      title: "ig",
      externalId: postId,
      occurredAt: new Date("2026-06-02T00:00:00Z").toISOString(),
      gameIds: [],
    },
    "127.0.0.1",
  );
  return { postId, eventId: ev.id };
}

async function snapshotCount(postId: string): Promise<number> {
  const rows = await db
    .select({ id: instagramPostSnapshots.id })
    .from(instagramPostSnapshots)
    .where(eq(instagramPostSnapshots.postId, postId));
  return rows.length;
}

async function enqueue(eventId: string, userId: string, postId: string): Promise<void> {
  await instagramAdapter.refreshQueue!.enqueue({
    eventId,
    userId,
    externalId: postId,
    eventKind: "instagram_post",
  });
}

beforeEach(() => {
  single.next = post();
  single.calls = [];
  throttleState = "ok";
  __resetInstagramRefreshQueueWorkerForTest();
});

describe("instagram per-post refresh lane (#69)", () => {
  it("enqueueRefreshNow inserts a per-post adapter_refresh_queue row (no boss job)", async () => {
    const u = await seedUserDirectly({ email: `igrq-enq-${uniq()}@t.io` });
    const postId = `3001_${uniq()}`;
    const result = await instagramAdapter.refreshQueue!.enqueue({
      eventId: `evt-${uniq()}`,
      userId: u.id,
      externalId: postId,
      eventKind: "instagram_post",
    });
    expect(result.queue).toBe("adapter_refresh_queue:instagram_account:user_post");
    const rows = await db
      .select()
      .from(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.adapterKind, "instagram_account"),
          eq(adapterRefreshQueue.userId, u.id),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.queueName).toBe("user_post");
    expect(rows[0]!.status).toBe("pending");
    expect((rows[0]!.payload as { post_id?: string }).post_id).toBe(postId);
  });

  it("a tick refreshes EXACTLY the queued post (single-post fetch + snapshot), marks the row done", async () => {
    const u = await seedUserDirectly({ email: `igrq-one-${uniq()}@t.io` });
    const tgt = await seedIgEvent(u.id, `3101_${uniq()}`);
    const neighbour = await seedIgEvent(u.id, `3102_${uniq()}`); // same account, NOT queued
    await enqueue(tgt.eventId, u.id, tgt.postId);

    await instagramRefreshQueueTick();

    expect(single.calls).toHaveLength(1); // ONE single-post fetch — not an account walk
    expect(await snapshotCount(tgt.postId)).toBe(1);
    expect(await snapshotCount(neighbour.postId)).toBe(0); // neighbour untouched
    const [row] = await db
      .select({ status: adapterRefreshQueue.status })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.userId, u.id))
      .limit(1);
    expect(row!.status).toBe("done");
  });

  it("claimGate defers the tick when the operator budget is at 95%", async () => {
    const u = await seedUserDirectly({ email: `igrq-throttle-${uniq()}@t.io` });
    const tgt = await seedIgEvent(u.id, `3201_${uniq()}`);
    await enqueue(tgt.eventId, u.id, tgt.postId);
    throttleState = "ninetyfive";

    await instagramRefreshQueueTick();

    expect(single.calls).toHaveLength(0); // never fetched — deferred at the gate
    expect(await snapshotCount(tgt.postId)).toBe(0);
    const [row] = await db
      .select({ status: adapterRefreshQueue.status })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.userId, u.id))
      .limit(1);
    expect(row!.status).toBe("pending"); // still pending, retried later
  });

  it("is tenant-scoped: a row whose event belongs to another user is skipped (no snapshot)", async () => {
    const owner = await seedUserDirectly({ email: `igrq-owner-${uniq()}@t.io` });
    const attacker = await seedUserDirectly({ email: `igrq-atk-${uniq()}@t.io` });
    const tgt = await seedIgEvent(owner.id, `3301_${uniq()}`);
    // Enqueue under the ATTACKER's userId but pointing at the owner's event.
    await enqueue(tgt.eventId, attacker.id, tgt.postId);

    await instagramRefreshQueueTick();

    expect(single.calls).toHaveLength(0); // event not resolvable under attacker → no fetch
    expect(await snapshotCount(tgt.postId)).toBe(0);
  });

  it("batchScope global: one tick processes queued posts from DIFFERENT users", async () => {
    const a = await seedUserDirectly({ email: `igrq-a-${uniq()}@t.io` });
    const b = await seedUserDirectly({ email: `igrq-b-${uniq()}@t.io` });
    const pa = await seedIgEvent(a.id, `3401_${uniq()}`);
    const pb = await seedIgEvent(b.id, `3402_${uniq()}`);
    await enqueue(pa.eventId, a.id, pa.postId);
    await enqueue(pb.eventId, b.id, pb.postId);

    await instagramRefreshQueueTick(); // default concurrency 10 ≥ 2 → both in one tick

    expect(single.calls.length).toBe(2);
    expect(await snapshotCount(pa.postId)).toBe(1);
    expect(await snapshotCount(pb.postId)).toBe(1);
  });

  it("deleted/private post (null body) writes a not_found status, no metrics row", async () => {
    const u = await seedUserDirectly({ email: `igrq-gone-${uniq()}@t.io` });
    const tgt = await seedIgEvent(u.id, `3501_${uniq()}`);
    await enqueue(tgt.eventId, u.id, tgt.postId);
    single.next = null; // provider returns null → deleted/private

    await instagramRefreshQueueTick();

    expect(single.calls).toHaveLength(1);
    expect(await snapshotCount(tgt.postId)).toBe(0); // not_found → no metrics snapshot
    const [postRow] = await db
      .select({ status: instagramPosts.lastPollStatus })
      .from(instagramPosts)
      .where(eq(instagramPosts.postId, tgt.postId))
      .limit(1);
    expect(postRow!.status).toBe("not_found");
  });
});
