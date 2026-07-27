// Reddit per-post Refresh lane (mirrors tiktok/instagram-refresh-queue) + the P1
// deletion-grace-clobber regression.
//
// Manual "Refresh now" enqueues ONE adapter_refresh_queue row per post (queue_name
// "user_post", user_id SET); the reddit lane worker claims it, resolves the post
// TENANT-SCOPED from the event (resolveUserPostId), fetches the single post by the
// cached permalink (or recovers it from the event URL), and writeSnapshot's the result.
//
// P1 REGRESSION (the load-bearing case): before the fix, writeSnapshot cleared
// reddit_posts.deletion_detected_at on ANY non-ok poll because the clear gated on
// `!detectDeletion` (always true — ScrapeCreators never returns removed_by_category)
// instead of on status. A single manual "Refresh now" on an already-flagged-removed
// post returns not_found → wiped the 48h GDPR grace clock the purge cron acts on, and
// the auto warm lane's deletion-detect exclusion does NOT protect the manual lane.
//
// review-P2 follow-up: the write path now NEVER clears deletion_detected_at (not even
// on an "ok" poll). "deleted" is subject-relative on the shared reddit_posts row, and
// the per-post lane is subject-agnostic (it fetches via the subreddit feed), so an ok
// re-sighting here must not clobber a flag an author walk set. Clearing is now
// subject-scoped inside the walk (see reddit-subreddit-walk).
//
// Integration test — real Postgres. getSocialProvider (fetch) + getSocialProviderSpendToday
// (claimGate throttle) are mocked; writeSnapshot + the DB are REAL (so the regression
// is exercised end-to-end).
//
// Requirements: PLAT-04 / D-06.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { NormalizedSinglePost } from "../../src/lib/sources/social-provider.js";

interface ScriptedSinglePost {
  next: NormalizedSinglePost | null;
  calls: Array<{ url: string; origin?: string }>;
}
const single: ScriptedSinglePost = { next: null, calls: [] };
let spend = { creditsUsed: 0, dailyCap: 1000, prepaidBalance: 5000 };

vi.mock("../../src/lib/sources/reddit/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isRedditConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "reddit") return null;
      return {
        name: "scrapecreators-reddit",
        async fetchPostByUrl(
          _platform: string,
          url: string,
          opts: { origin?: string },
        ): Promise<NormalizedSinglePost | null> {
          single.calls.push({ url, origin: opts.origin });
          return single.next;
        },
        async fetchPosts() {
          return {
            posts: [],
            nextCursor: null,
            endOfFeed: true,
            creditsUsed: 1,
            owner: null,
            droppedCount: 0,
          };
        },
        async resolveAccount() {
          return { accountId: "acct-rq-rdt", displayName: "RQ" };
        },
      };
    },
  };
});

vi.mock("../../src/lib/sources/reddit/server/quota.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getSocialProviderSpendToday: async () => spend };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { redditPosts, redditPostSnapshots, adapterRefreshQueue } =
  await import("../../src/lib/server/db/schema/index.js");
const { createEvent } = await import("../../src/lib/server/services/events-mutation.js");
const { redditAdapter } = await import("../../src/lib/sources/reddit/server/index.js");
const { redditRefreshQueueTick, __resetRedditRefreshQueueWorkerForTest } =
  await import("../../src/lib/sources/reddit/server/handlers/refresh-queue-tick.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

function singlePost(overrides: Partial<NormalizedSinglePost> = {}): NormalizedSinglePost {
  return {
    id: "t3_over",
    shortcode: "over",
    kind: "text",
    publishedAt: new Date("2026-06-01T12:00:00Z"),
    metrics: { views: null, likes: 100, comments: 9, shares: null },
    caption: "refreshed body",
    thumbnailUrl: "https://i.redd.it/rq.png",
    ownerId: "t2_owner",
    ownerUsername: "d954mas",
    ...overrides,
  };
}

// Seed a public-data reddit_posts cache row. deletionDetectedAt is set for the
// regression cases (a post the walk flagged as disappeared).
async function seedCachedPost(
  shortId: string,
  url: string,
  overrides: Partial<typeof redditPosts.$inferInsert> = {},
): Promise<void> {
  await db
    .insert(redditPosts)
    .values({
      postId: `t3_${shortId}`,
      subredditSlug: "gamedev",
      author: "d954mas",
      authorFullname: "t2_owner",
      title: `Devlog ${shortId}`,
      permalink: url,
      publishedAt: new Date("2026-06-01T12:00:00Z"),
      lastPolledAt: new Date("2026-06-02T00:00:00Z"),
      lastPollStatus: "ok",
      ...overrides,
    })
    .onConflictDoNothing();
}

// Create a reddit_post event; external_id derives from the URL-intrinsic slug (t3_<id>).
async function seedEvent(userId: string, shortId: string, url: string): Promise<string> {
  const ev = await createEvent(
    userId,
    {
      kind: "reddit_post",
      title: `Devlog ${shortId}`,
      occurredAt: new Date("2026-06-02T00:00:00Z"),
      url,
      gameIds: [],
    },
    "127.0.0.1",
  );
  expect(ev.externalId).toBe(`t3_${shortId}`);
  return ev.id;
}

async function enqueue(eventId: string, userId: string, postId: string): Promise<void> {
  await redditAdapter.refreshQueue!.enqueue({
    eventId,
    userId,
    externalId: postId,
    eventKind: "reddit_post",
  });
}

async function readPost(shortId: string) {
  const [row] = await db
    .select()
    .from(redditPosts)
    .where(eq(redditPosts.postId, `t3_${shortId}`))
    .limit(1);
  return row;
}

async function snapshotCount(shortId: string): Promise<number> {
  const rows = await db
    .select({ id: redditPostSnapshots.id })
    .from(redditPostSnapshots)
    .where(eq(redditPostSnapshots.postId, `t3_${shortId}`));
  return rows.length;
}

beforeEach(() => {
  single.next = null;
  single.calls = [];
  spend = { creditsUsed: 0, dailyCap: 1000, prepaidBalance: 5000 };
  __resetRedditRefreshQueueWorkerForTest();
});

describe("reddit per-post refresh lane", () => {
  it("[12-05] a tick refreshes the queued post from the cached permalink (user pool)", async () => {
    const u = await seedUserDirectly({ email: `rdtrq-ok-${uniq()}@t.io` });
    const s = uniq().slice(0, 6);
    const url = `https://www.reddit.com/r/gamedev/comments/${s}/x/`;
    await seedCachedPost(s, url);
    const evId = await seedEvent(u.id, s, url);
    single.next = singlePost({ id: `t3_${s}`, shortcode: s });
    await enqueue(evId, u.id, `t3_${s}`);

    await redditRefreshQueueTick();

    expect(single.calls).toHaveLength(1);
    expect(single.calls[0]!.url).toBe(url); // fetched the cached permalink
    expect(single.calls[0]!.origin).toBe("user"); // user_post → user pool
    expect(await snapshotCount(s)).toBe(1);
    const [snap] = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, `t3_${s}`));
    expect(snap!.likeCount).toBe(100);
    expect(snap!.commentCount).toBe(9);
    // The queue row completed.
    const [row] = await db
      .select({ status: adapterRefreshQueue.status })
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.userId, u.id))
      .limit(1);
    expect(row!.status).toBe("done");
  });

  it("[review] Refresh Now clears a deleted owner without marking the post deleted", async () => {
    const u = await seedUserDirectly({ email: `rdtrq-owner-deleted-${uniq()}@t.io` });
    const s = uniq().slice(0, 6);
    const url = `https://www.reddit.com/r/gamedev/comments/${s}/x/`;
    await seedCachedPost(s, url, {
      author: "former_author",
      authorFullname: "t2_former",
      deletionDetectedAt: null,
    });
    const evId = await seedEvent(u.id, s, url);
    single.next = singlePost({
      id: `t3_${s}`,
      shortcode: s,
      ownerId: null,
      ownerUsername: null,
      ownerDeleted: true,
      metrics: { views: null, likes: 111, comments: 12, shares: null },
    });
    await enqueue(evId, u.id, `t3_${s}`);

    await redditRefreshQueueTick();

    const post = await readPost(s);
    expect(post!.author).toBeNull();
    expect(post!.authorFullname).toBeNull();
    expect(post!.deletionDetectedAt).toBeNull();
    expect(post!.lastPollStatus).toBe("ok");
    const [snapshot] = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, `t3_${s}`));
    expect(snapshot!.likeCount).toBe(111);
    expect(snapshot!.commentCount).toBe(12);
  });

  it("[12-05] is tenant-scoped: another user's event cannot be enqueued or fetched", async () => {
    const owner = await seedUserDirectly({ email: `rdtrq-owner-${uniq()}@t.io` });
    const attacker = await seedUserDirectly({ email: `rdtrq-atk-${uniq()}@t.io` });
    const s = uniq().slice(0, 6);
    const url = `https://www.reddit.com/r/gamedev/comments/${s}/x/`;
    await seedCachedPost(s, url);
    const evId = await seedEvent(owner.id, s, url);
    single.next = singlePost({ id: `t3_${s}`, shortcode: s });

    // The adapter boundary rejects before a cross-tenant queue row can exist.
    await expect(enqueue(evId, attacker.id, `t3_${s}`)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });

    expect(single.calls).toHaveLength(0);
    expect(await snapshotCount(s)).toBe(0);
  });

  it("[review] a bounded page-1 miss is inconclusive and does not write terminal not_found", async () => {
    const u = await seedUserDirectly({ email: `rdtrq-notfound-${uniq()}@t.io` });
    const s = uniq().slice(0, 6);
    const url = `https://www.reddit.com/r/gamedev/comments/${s}/x/`;
    const flaggedAt = new Date(Date.now() - 3_600_000); // flagged 1h ago, within 48h grace
    await seedCachedPost(s, url, { deletionDetectedAt: flaggedAt });
    const evId = await seedEvent(u.id, s, url);
    single.next = null; // bounded subreddit page did not contain this older post
    await enqueue(evId, u.id, `t3_${s}`);

    await redditRefreshQueueTick();

    expect(single.calls).toHaveLength(1); // the fetch happened
    const post = await readPost(s);
    expect(post!.lastPollStatus, "a bounded feed miss is not deletion evidence").toBe("ok");
    expect(post!.pollFailureCount).toBe(0);
    // The 48h GDPR grace clock is also preserved.
    expect(post!.deletionDetectedAt).not.toBeNull();
    expect(post!.deletionDetectedAt!.getTime()).toBe(flaggedAt.getTime());
    // No snapshot row on a non-ok poll.
    expect(await snapshotCount(s)).toBe(0);
  });

  it("[review-P2] an ok per-post refresh does NOT clear deletion_detected_at (no cross-mechanism clobber)", async () => {
    const u = await seedUserDirectly({ email: `rdtrq-alive-${uniq()}@t.io` });
    const s = uniq().slice(0, 6);
    const url = `https://www.reddit.com/r/gamedev/comments/${s}/x/`;
    const flaggedAt = new Date(Date.now() - 3_600_000);
    // Flag ATTRIBUTED to the author walk (channelKey "d954mas"). The per-post lane is
    // subject-agnostic AND fetches via the subreddit feed, so an alive re-sighting here
    // is NOT evidence the deleted author is back — clearing it would re-introduce the
    // cross-mechanism clobber the subject-scoped model removes. Only the flagging
    // subject's OWN walk may un-flag it (reddit-subreddit-walk covers that).
    await seedCachedPost(s, url, { deletionDetectedAt: flaggedAt, deletionDetectedBy: "d954mas" });
    const evId = await seedEvent(u.id, s, url);
    single.next = singlePost({ id: `t3_${s}`, shortcode: s }); // alive
    await enqueue(evId, u.id, `t3_${s}`);

    await redditRefreshQueueTick();

    const post = await readPost(s);
    expect(post!.lastPollStatus).toBe("ok");
    // Metrics refreshed (snapshot written)…
    expect(await snapshotCount(s)).toBe(1);
    // …but the 48h GDPR grace clock is PRESERVED — the per-post lane never clears it.
    expect(
      post!.deletionDetectedAt,
      "per-post refresh must not clobber a walk-set flag",
    ).not.toBeNull();
    expect(post!.deletionDetectedAt!.getTime()).toBe(flaggedAt.getTime());
  });

  it("[12-05] a no-cache-row event recovers the permalink from the event URL (self-heal)", async () => {
    const u = await seedUserDirectly({ email: `rdtrq-nocache-${uniq()}@t.io` });
    const s = uniq().slice(0, 6);
    const url = `https://www.reddit.com/r/gamedev/comments/${s}/x/`;
    // NO reddit_posts cache row — resolvePermalink must recover from the event URL.
    const evId = await seedEvent(u.id, s, url);
    single.next = singlePost({ id: `t3_${s}`, shortcode: s });
    await enqueue(evId, u.id, `t3_${s}`);

    await redditRefreshQueueTick();

    expect(single.calls).toHaveLength(1);
    expect(single.calls[0]!.url).toBe(url); // recovered from the event's own URL
    // The snapshot landed AND the cache row self-healed for the next refresh.
    expect(await snapshotCount(s)).toBe(1);
    const post = await readPost(s);
    expect(post!.lastPollStatus).toBe("ok");
  });

  it("[review-P0] a service row's cache miss NEVER falls back to tenant events (skip, no fetch)", async () => {
    const u = await seedUserDirectly({ email: `rdtrq-p0-${uniq()}@t.io` });
    const s = uniq().slice(0, 6);
    const url = `https://www.reddit.com/r/gamedev/comments/${s}/x/`;
    // A tenant OWNS an event with this externalId, but there is NO public cache row.
    // The service lane (user_id NULL) has no tenant to scope by — it must SKIP, not
    // recover the permalink from some tenant's events row (P0 tenant-scope invariant:
    // every events read is filtered by userId, with no public-data escape hatch).
    await seedEvent(u.id, s, url);
    single.next = singlePost({ id: `t3_${s}`, shortcode: s });
    await db.insert(adapterRefreshQueue).values({
      adapterKind: "reddit_account",
      queueName: "service_post",
      type: "post_stats",
      payload: { post_id: `t3_${s}` },
      userId: null,
      priority: 0,
      status: "pending",
    });

    await redditRefreshQueueTick();

    expect(single.calls, "no provider fetch on a tenant-blind cache miss").toHaveLength(0);
    expect(await snapshotCount(s)).toBe(0);
  });

  it("[review-P2] a refresh snapshot persists the provider-derived media_type", async () => {
    const u = await seedUserDirectly({ email: `rdtrq-mt-${uniq()}@t.io` });
    const s = uniq().slice(0, 6);
    const url = `https://www.reddit.com/r/gamedev/comments/${s}/x/`;
    await seedCachedPost(s, url, { mediaType: null });
    const evId = await seedEvent(u.id, s, url);
    single.next = singlePost({ id: `t3_${s}`, shortcode: s, kind: "image", mediaType: "image" });
    await enqueue(evId, u.id, `t3_${s}`);

    await redditRefreshQueueTick();

    const post = await readPost(s);
    expect(post!.mediaType, "refresh must not hard-null the derived FORM").toBe("image");
  });
});
