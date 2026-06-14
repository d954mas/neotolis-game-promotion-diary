// Twitter/X per-post Refresh lane — the Plan 11 P1 fix: the global QPS pacer is
// acquired in the lane's claimGate (mirroring Reddit), NOT only at the HTTP seam.
//
// BEFORE the fix the pacer was acquired at the seam AFTER the refresh lane had already
// CLAIMED the row, so a busy slot threw rate-limited, wrote a rate_limited snapshot,
// and the lane marked the row `done` — a manual Refresh-Now silently no-opped and
// needed a re-click. AFTER the fix a busy slot DEFERS in the claimGate: the row stays
// pending (NO snapshot, NO done) and is retried on the next tick once the slot clears.
//
// When the slot is FREE the claimGate acquires it and threads pacerAlreadyAcquired so
// the seam does NOT re-acquire (no double-spend). The provider mock records whether the
// seam would have re-acquired by asserting the real twitter_pacer is consumed EXACTLY
// once per refreshed row.
//
// Integration test — real Postgres via ./helpers.js. getSocialProvider + getSocialSpendToday
// (claimGate throttle) are mocked; the twitter_pacer + adapter_refresh_queue are real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { NormalizedSinglePost } from "../../src/lib/sources/social-provider.js";

interface ScriptedSinglePost {
  next: NormalizedSinglePost | null;
  throwErr: Error | null;
  calls: Array<{ url: string; origin?: string; pacerAlreadyAcquired?: boolean }>;
}
const single: ScriptedSinglePost = { next: null, throwErr: null, calls: [] };
let spend = { creditsUsed: 0, dailyCap: 1000, prepaidBalance: 5000 };

vi.mock("../../src/lib/sources/twitter/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isTwitterConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "twitter") return null;
      return {
        name: "twitterapi.io",
        async fetchPostByUrl(
          _platform: string,
          url: string,
          opts: { origin?: string; pacerAlreadyAcquired?: boolean },
        ): Promise<NormalizedSinglePost | null> {
          single.calls.push({
            url,
            origin: opts.origin,
            pacerAlreadyAcquired: opts.pacerAlreadyAcquired,
          });
          if (single.throwErr) throw single.throwErr;
          return single.next;
        },
        async fetchPosts() {
          return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1 };
        },
        async resolveAccount() {
          return { accountId: "acct-rq", displayName: "RQ" };
        },
      };
    },
  };
});

vi.mock("../../src/lib/sources/twitter/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSocialSpendToday: async () => spend };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { twitterPosts, twitterPostSnapshots, adapterRefreshQueue } =
  await import("../../src/lib/server/db/schema/index.js");
const { createEvent } = await import("../../src/lib/server/services/events-mutation.js");
const { twitterAdapter } = await import("../../src/lib/sources/twitter/server/index.js");
const { twitterRefreshQueueTick, __resetTwitterRefreshQueueWorkerForTest } =
  await import("../../src/lib/sources/twitter/server/handlers/refresh-queue-tick.js");
const { __resetTwitterPacerForTest } =
  await import("../../src/lib/sources/twitter/server/pacer.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

// 19-digit status ids — the tweet id IS the URL slug, so external_id == tweet id.
function tweetId(): string {
  return `18${Math.floor(Math.random() * 1e17)
    .toString()
    .padStart(17, "0")}`.slice(0, 19);
}

function singleTweet(
  id: string,
  overrides: Partial<NormalizedSinglePost> = {},
): NormalizedSinglePost {
  return {
    id,
    shortcode: id,
    kind: "text",
    publishedAt: new Date("2026-06-01T12:00:00Z"),
    metrics: { views: 12000, likes: 340, comments: 12, shares: 28 },
    caption: "rq tweet",
    thumbnailUrl: null,
    ownerId: "44196397",
    ownerUsername: "promo",
    ...overrides,
  };
}

async function snapshotCount(id: string): Promise<number> {
  const rows = await db
    .select({ id: twitterPostSnapshots.id })
    .from(twitterPostSnapshots)
    .where(eq(twitterPostSnapshots.tweetId, id));
  return rows.length;
}

async function enqueue(eventId: string, userId: string, id: string): Promise<void> {
  await twitterAdapter.refreshQueue!.enqueue({
    eventId,
    userId,
    externalId: id,
    eventKind: "twitter_post",
  });
}

async function seedCachedPost(id: string, permalink: string): Promise<void> {
  await db
    .insert(twitterPosts)
    .values({ tweetId: id, accountId: "44196397", permalink, mediaType: "text" })
    .onConflictDoNothing();
}

beforeEach(async () => {
  single.next = null;
  single.throwErr = null;
  single.calls = [];
  spend = { creditsUsed: 0, dailyCap: 1000, prepaidBalance: 5000 };
  __resetTwitterRefreshQueueWorkerForTest();
  await __resetTwitterPacerForTest();
});

describe("twitter per-post refresh lane — claimGate pacer (Plan 11 P1)", () => {
  it("slot FREE: the claimGate acquires the pacer; the seam does NOT re-acquire (pacerAlreadyAcquired=true) and the row completes", async () => {
    const u = await seedUserDirectly({ email: `twrq-free-${uniq()}@t.io` });
    const id = tweetId();
    const permalink = `https://x.com/promo/status/${id}`;
    await seedCachedPost(id, permalink);
    const ev = await createEvent(
      u.id,
      {
        kind: "twitter_post",
        title: "tw",
        externalId: id,
        occurredAt: new Date("2026-06-02T00:00:00Z").toISOString(),
        gameIds: [],
      },
      "127.0.0.1",
    );
    single.next = singleTweet(id);
    await enqueue(ev.id, u.id, id);

    // Ensure the shared pacer slot is DUE right before the tick (the singleton row is
    // global; a prior test's 0ms acquire can leave next_allowed_at sub-ms in the future).
    await db.execute(
      sql`UPDATE twitter_pacer SET next_allowed_at = NOW() - interval '1 second' WHERE id = 1`,
    );
    await twitterRefreshQueueTick();

    expect(single.calls).toHaveLength(1);
    expect(single.calls[0]!.url).toBe(permalink);
    expect(single.calls[0]!.origin).toBe("user"); // user_post → user pool
    // The claimGate already holds the slot → the seam must skip its own acquire.
    expect(single.calls[0]!.pacerAlreadyAcquired).toBe(true);
    expect(await snapshotCount(id)).toBe(1);

    const [row] = await db
      .select({ status: adapterRefreshQueue.status })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.userId, u.id))
      .limit(1);
    expect(row!.status).toBe("done");
  });

  it("slot BUSY: the claimGate DEFERS — the row stays pending (no fetch, no snapshot, NOT done) and is retried", async () => {
    const u = await seedUserDirectly({ email: `twrq-busy-${uniq()}@t.io` });
    const id = tweetId();
    const permalink = `https://x.com/promo/status/${id}`;
    await seedCachedPost(id, permalink);
    const ev = await createEvent(
      u.id,
      {
        kind: "twitter_post",
        title: "tw",
        externalId: id,
        occurredAt: new Date("2026-06-02T00:00:00Z").toISOString(),
        gameIds: [],
      },
      "127.0.0.1",
    );
    single.next = singleTweet(id);
    await enqueue(ev.id, u.id, id);

    // Block the global pacer slot — emulate a concurrent caller holding it this tick.
    await db.execute(
      sql`UPDATE twitter_pacer SET next_allowed_at = NOW() + interval '5 seconds' WHERE id = 1`,
    );

    await twitterRefreshQueueTick();

    // The fix: a busy slot DEFERS in the claimGate. No provider call, no snapshot, and
    // the row stays pending (NOT marked done with a rate_limited snapshot).
    expect(single.calls).toHaveLength(0);
    expect(await snapshotCount(id)).toBe(0);

    const [row] = await db
      .select({ status: adapterRefreshQueue.status })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.userId, u.id))
      .limit(1);
    expect(row!.status).toBe("pending"); // deferred → retried, NOT consumed

    // Clear the slot AND advance the row's next_attempt_at to now (the defer set it to
    // ~now+waitMs ≈ 5s out — the scheduledWorker's interval naturally elapses that wait
    // in prod; fast-forward it here). The retried tick now refreshes (the click is not
    // lost) — proving the deferral was a retry, not a silent consume.
    await db.execute(
      sql`UPDATE twitter_pacer SET next_allowed_at = NOW() - interval '1 second' WHERE id = 1`,
    );
    await db.execute(
      sql`UPDATE adapter_refresh_queue SET next_attempt_at = NOW() - interval '1 second' WHERE user_id = ${u.id}`,
    );
    await twitterRefreshQueueTick();

    expect(single.calls).toHaveLength(1);
    expect(single.calls[0]!.pacerAlreadyAcquired).toBe(true);
    expect(await snapshotCount(id)).toBe(1);
    const [done] = await db
      .select({ status: adapterRefreshQueue.status })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.userId, u.id))
      .limit(1);
    expect(done!.status).toBe("done");
  });

  it("budget DEFER (daily cap ≥95%): the claimGate defers BEFORE the pacer — twitter_pacer.next_allowed_at is untouched (no wasted slot)", async () => {
    const u = await seedUserDirectly({ email: `twrq-budget-${uniq()}@t.io` });
    const id = tweetId();
    const permalink = `https://x.com/promo/status/${id}`;
    await seedCachedPost(id, permalink);
    const ev = await createEvent(
      u.id,
      {
        kind: "twitter_post",
        title: "tw",
        externalId: id,
        occurredAt: new Date("2026-06-02T00:00:00Z").toISOString(),
        gameIds: [],
      },
      "127.0.0.1",
    );
    single.next = singleTweet(id);
    await enqueue(ev.id, u.id, id);

    // Daily cap at 95% (balance still funded) → the budget gate DEFERS. Make the pacer
    // slot DUE so that IF the (buggy) order acquired the pacer before the budget check,
    // it would bump next_allowed_at into the future. The fix runs budget first, so the
    // pacer row must stay untouched.
    spend = { creditsUsed: 950, dailyCap: 1000, prepaidBalance: 5000 };
    await db.execute(
      sql`UPDATE twitter_pacer SET next_allowed_at = NOW() - interval '1 second' WHERE id = 1`,
    );

    await twitterRefreshQueueTick();

    // No fetch, no snapshot — the budget deferred the row.
    expect(single.calls).toHaveLength(0);
    expect(await snapshotCount(id)).toBe(0);
    const [row] = await db
      .select({ status: adapterRefreshQueue.status })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.userId, u.id))
      .limit(1);
    expect(row!.status).toBe("pending");

    // The crux: a budget-defer must not have consumed the pacer slot. next_allowed_at
    // stays in the past (the slot is still DUE), so unrelated twitter traffic is NOT
    // paced out by a slot interval.
    const [pacer] = await db
      .execute<{
        due: boolean;
      }>(sql`SELECT next_allowed_at <= NOW() AS due FROM twitter_pacer WHERE id = 1`)
      .then((r) => (r as unknown as { rows: Array<{ due: boolean }> }).rows);
    expect(pacer!.due).toBe(true);
  });
});
