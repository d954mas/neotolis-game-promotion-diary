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
import { and, eq, sql } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import { AdapterError } from "../../src/lib/sources/errors.js";
import type { NormalizedSinglePost } from "../../src/lib/sources/social-provider.js";

interface ScriptedSinglePost {
  next: NormalizedSinglePost | null;
  throwErr: Error | null;
  calls: Array<{ url: string; origin?: string }>;
}
const single: ScriptedSinglePost = { next: null, throwErr: null, calls: [] };
// Controls the claimGate (getSocialSpendToday): default = funded + under cap → run.
let spend = { creditsUsed: 0, dailyCap: 1000, prepaidBalance: 5000 };

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
          if (single.throwErr) throw single.throwErr;
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
  return { ...actual, getSocialSpendToday: async () => spend };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { instagramPosts, instagramPostSnapshots, adapterRefreshQueue } =
  await import("../../src/lib/server/db/schema/index.js");
const { createEvent } = await import("../../src/lib/server/services/events-mutation.js");
const { instagramAdapter } = await import("../../src/lib/sources/instagram/server/index.js");
const { instagramRefreshQueueTick, __resetInstagramRefreshQueueWorkerForTest } =
  await import("../../src/lib/sources/instagram/server/handlers/refresh-queue-tick.js");
const { enqueueServiceInstagramPostStats } =
  await import("../../src/lib/sources/instagram/server/handlers/enqueue-service-post-stats.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

function post(overrides: Partial<NormalizedSinglePost> = {}): NormalizedSinglePost {
  return {
    id: "3912161556549155524_24549572243",
    shortcode: "ABC",
    kind: "carousel",
    publishedAt: new Date("2026-06-01T12:00:00Z"),
    metrics: { views: null, likes: 99, comments: 3, shares: null },
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
  single.throwErr = null;
  single.calls = [];
  spend = { creditsUsed: 0, dailyCap: 1000, prepaidBalance: 5000 };
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

  it("claimGate DEFERS at daily-cap 95% (balance funded → recovers at reset)", async () => {
    const u = await seedUserDirectly({ email: `igrq-throttle-${uniq()}@t.io` });
    const tgt = await seedIgEvent(u.id, `3201_${uniq()}`);
    await enqueue(tgt.eventId, u.id, tgt.postId);
    spend = { creditsUsed: 950, dailyCap: 1000, prepaidBalance: 5000 }; // 95% of cap, funded

    await instagramRefreshQueueTick();

    expect(single.calls).toHaveLength(0); // never fetched — deferred at the gate
    expect(await snapshotCount(tgt.postId)).toBe(0);
    const [row] = await db
      .select({ status: adapterRefreshQueue.status })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.userId, u.id))
      .limit(1);
    expect(row!.status).toBe("pending"); // deferred → still pending, retries after reset
  });

  it("claimGate RUNS at balance-exhausted (no defer-forever; row completes, button settles) (P1-B)", async () => {
    const u = await seedUserDirectly({ email: `igrq-bal0-${uniq()}@t.io` });
    const tgt = await seedIgEvent(u.id, `3251_${uniq()}`);
    await enqueue(tgt.eventId, u.id, tgt.postId);
    // Prepaid balance is the MONOTONIC hard ceiling — it never resets, so the
    // claimGate must NOT defer-forever here. It RUNS; in prod the in-fetch reserve
    // would then fail → non-ok snapshot. (Provider mocked here, so the row simply
    // completes — the point is it is NOT left pending indefinitely.)
    spend = { creditsUsed: 0, dailyCap: 1000, prepaidBalance: 0 };

    await instagramRefreshQueueTick();

    expect(single.calls.length).toBeGreaterThan(0); // ran, did not defer
    const [row] = await db
      .select({ status: adapterRefreshQueue.status })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.userId, u.id))
      .limit(1);
    expect(row!.status).toBe("done"); // completed — NOT stuck pending forever
  });

  it("a failed refresh PRESERVES the prior thumbnail (no blanking) (P1-A)", async () => {
    const u = await seedUserDirectly({ email: `igrq-thumb-${uniq()}@t.io` });
    const tgt = await seedIgEvent(u.id, `3271_${uniq()}`);
    // Give it a known-good thumbnail (simulating a prior successful poll).
    await db
      .update(instagramPosts)
      .set({ thumbnailUrl: "https://scontent.cdninstagram.com/good.jpg" })
      .where(eq(instagramPosts.postId, tgt.postId));
    await enqueue(tgt.eventId, u.id, tgt.postId);
    single.throwErr = new AdapterError("rate limited", { category: "rate-limited" });

    await instagramRefreshQueueTick();

    const [postRow] = await db
      .select({ thumb: instagramPosts.thumbnailUrl, status: instagramPosts.lastPollStatus })
      .from(instagramPosts)
      .where(eq(instagramPosts.postId, tgt.postId))
      .limit(1);
    expect(postRow!.status).toBe("rate_limited"); // failure recorded…
    expect(postRow!.thumb).toBe("https://scontent.cdninstagram.com/good.jpg"); // …but cover preserved
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

  it("provider error writes a VISIBLE non-ok snapshot (no silent drop), row done (P2-A)", async () => {
    const u = await seedUserDirectly({ email: `igrq-err-${uniq()}@t.io` });
    const tgt = await seedIgEvent(u.id, `3601_${uniq()}`);
    await enqueue(tgt.eventId, u.id, tgt.postId);
    single.throwErr = new AdapterError("rate limited", { category: "rate-limited" });

    await instagramRefreshQueueTick();

    expect(single.calls).toHaveLength(1);
    expect(await snapshotCount(tgt.postId)).toBe(0); // non-ok → no metrics row…
    const [postRow] = await db
      .select({ status: instagramPosts.lastPollStatus })
      .from(instagramPosts)
      .where(eq(instagramPosts.postId, tgt.postId))
      .limit(1);
    expect(postRow!.status).toBe("rate_limited"); // …but the failure IS recorded (stamps last_polled_at)
    const [row] = await db
      .select({ status: adapterRefreshQueue.status })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.userId, u.id))
      .limit(1);
    expect(row!.status).toBe("done"); // per-row: marked done, not a batch-wide retry
  });

  it("a service_post (cron warm) row refreshes by post_id with origin=cron — no event, no userId (#70)", async () => {
    const u = await seedUserDirectly({ email: `igrq-svc-${uniq()}@t.io` });
    // seedIgEvent populates the public-data instagram_posts cache (the warm lane
    // needs the permalink) + an event; the service_post row keys off post_id ONLY.
    const tgt = await seedIgEvent(u.id, `3701_${uniq()}`);
    const enqueued = await enqueueServiceInstagramPostStats([tgt.postId]);
    expect(enqueued).toBe(1);

    await instagramRefreshQueueTick();

    expect(single.calls).toHaveLength(1);
    expect(single.calls[0]!.origin).toBe("cron"); // operator pool, NOT the user's cap
    expect(await snapshotCount(tgt.postId)).toBe(1);
    const [row] = await db
      .select({ status: adapterRefreshQueue.status, userId: adapterRefreshQueue.userId })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.queueName, "service_post"))
      .limit(1);
    expect(row!.status).toBe("done");
    expect(row!.userId).toBeNull(); // cross-tenant public-data lane
  });

  it("enqueueServiceInstagramPostStats DEDUPS against a pending/processing service_post row (#70)", async () => {
    await seedUserDirectly({ email: `igrq-svcdedup-${uniq()}@t.io` });
    const postId = `3801_${uniq()}`;
    const first = await enqueueServiceInstagramPostStats([postId]);
    const second = await enqueueServiceInstagramPostStats([postId]); // still pending
    expect(first).toBe(1);
    expect(second).toBe(0); // skip-if-pending — no duplicate row
    const rows = await db
      .select({ id: adapterRefreshQueue.id })
      .from(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.adapterKind, "instagram_account"),
          eq(adapterRefreshQueue.queueName, "service_post"),
          eq(sql`${adapterRefreshQueue.payload}->>'post_id'`, postId),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
