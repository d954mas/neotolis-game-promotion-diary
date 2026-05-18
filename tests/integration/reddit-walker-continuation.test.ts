// Reddit listing walker — continuation flow + CAS race coverage.
//
// Two production guarantees this test pins:
//   1. Two-tick walk: first tick fetches page 1, persists cursor, and
//      enqueues a continuation row on the service_source lane;
//      second tick reads the cursor, fetches page 2, sees data.after=null
//      from Reddit, flips backfill_complete=true and does NOT enqueue
//      another continuation. Without this contract the walker would
//      either re-fetch page 1 forever (no cursor advance) or stall at
//      page 1 (no continuation enqueue).
//
//   2. CAS race: when two replicas read the same prior cursor and both
//      try to advance it, only ONE persist commits and only ONE
//      continuation row lands. Pre-CAS the second persist would silently
//      overwrite (same value, idempotent UPDATE) but the second
//      continuation INSERT would double-fire — operator-pool quota
//      would burn twice for one page. The CAS persist returns
//      `committed=false` for the loser; the helper skips the enqueue.
//
// The handler tests use a mocked globalThis.fetch (same pattern as
// reddit-paste-via-api-events.test.ts) so no real Reddit HTTP fires.
// The CAS test bypasses the handler entirely — it calls
// `commitSubredditWalkProgress` directly to isolate the race semantics.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sql, eq, and } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { adapterRefreshQueue } from "../../src/lib/server/db/schema/index.js";
import { redditSubredditsCache } from "../../src/lib/sources/reddit/server/schema/index.js";
import { handleSubPoll } from "../../src/lib/sources/reddit/server/handlers/sub-poll.js";
import { commitSubredditWalkProgress } from "../../src/lib/sources/reddit/server/walker-state.js";

interface T3FactoryArg {
  postId: string;
  subreddit: string;
  author: string;
  title: string;
  createdUtcSeconds: number;
}

function buildListingResponse(args: {
  children: T3FactoryArg[];
  after: string | null;
}): unknown {
  return {
    data: {
      after: args.after,
      children: args.children.map((c) => ({
        kind: "t3",
        data: {
          id: c.postId,
          name: `t3_${c.postId}`,
          subreddit: c.subreddit,
          subreddit_id: `t5_${c.subreddit}`,
          author: c.author,
          author_fullname: `t2_${c.author}`,
          permalink: `/r/${c.subreddit}/comments/${c.postId}/title/`,
          url: `https://www.reddit.com/r/${c.subreddit}/comments/${c.postId}/title/`,
          title: c.title,
          selftext: "",
          is_self: true,
          created_utc: c.createdUtcSeconds,
          score: 1,
          num_comments: 0,
          upvote_ratio: 1,
          total_awards_received: 0,
          over_18: false,
          spoiler: false,
          stickied: false,
          locked: false,
          archived: false,
          removed_by_category: null,
          crosspost_parent: null,
          link_flair_text: null,
        },
      })),
    },
  };
}

function mockFetchSequence(responses: Array<() => unknown>): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn();
  for (const factory of responses) {
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify(factory()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  }
  return fetchSpy;
}

beforeEach(async () => {
  await db.execute(sql`DELETE FROM adapter_refresh_queue`);
  await db.execute(sql`DELETE FROM reddit_post_snapshots`);
  await db.execute(sql`DELETE FROM reddit_posts`);
  await db.execute(sql`DELETE FROM reddit_subreddits_cache`);
  await db.execute(sql`DELETE FROM reddit_users_cache`);
  await db.execute(sql`UPDATE reddit_pacer SET next_allowed_at = NOW() - INTERVAL '1 minute'`);
});

describe("Reddit walker continuation", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("first tick — never-walked sub: persists cursor + enqueues continuation on service_source", async () => {
    const sub = "WalkerSubOne";
    const fetchSpy = mockFetchSequence([
      () =>
        buildListingResponse({
          after: "t3_page1last",
          children: [
            {
              postId: "p1",
              subreddit: sub,
              author: "u1",
              title: "post 1",
              createdUtcSeconds: 1779000000,
            },
            {
              postId: "p2",
              subreddit: sub,
              author: "u2",
              title: "post 2",
              createdUtcSeconds: 1778900000,
            },
          ],
        }),
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await handleSubPoll({ sub, userId: null });

    expect(result.postsUpserted).toBe(2);
    expect(result.walking).toBe(true);

    const [cacheRow] = await db
      .select()
      .from(redditSubredditsCache)
      .where(eq(redditSubredditsCache.name, sub));
    expect(cacheRow).toBeDefined();
    expect(cacheRow!.backfillAfterCursor).toBe("t3_page1last");
    expect(cacheRow!.backfillComplete).toBe(false);
    expect(cacheRow!.backfillDeepestAt?.getTime()).toBe(1778900000 * 1000);

    const continuationRows = await db
      .select()
      .from(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.adapterKind, "reddit_account"),
          eq(adapterRefreshQueue.type, "sub_poll"),
          eq(adapterRefreshQueue.queueName, "service_source"),
        ),
      );
    expect(continuationRows).toHaveLength(1);
    expect(continuationRows[0]!.userId).toBeNull();
    expect((continuationRows[0]!.payload as { sub?: string }).sub).toBe(sub);
  });

  it("final tick — Reddit returns data.after=null: flips backfill_complete=true and DOES NOT enqueue continuation", async () => {
    const sub = "WalkerSubTwo";
    // Pre-seed the cache row as if the walker had already advanced to a
    // mid-walk cursor. The second tick reads that cursor, fetches the
    // next page, and receives data.after=null — the listing is drained.
    await db.insert(redditSubredditsCache).values({
      name: sub,
      backfillAfterCursor: "t3_priorpage",
      backfillComplete: false,
    });

    const fetchSpy = mockFetchSequence([
      () =>
        buildListingResponse({
          after: null,
          children: [
            {
              postId: "p_last",
              subreddit: sub,
              author: "u_last",
              title: "last post",
              createdUtcSeconds: 1700000000,
            },
          ],
        }),
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await handleSubPoll({ sub, userId: null });

    expect(result.walking).toBe(false);

    const [cacheRow] = await db
      .select()
      .from(redditSubredditsCache)
      .where(eq(redditSubredditsCache.name, sub));
    expect(cacheRow!.backfillAfterCursor).toBeNull();
    expect(cacheRow!.backfillComplete).toBe(true);

    const continuationRows = await db
      .select()
      .from(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.adapterKind, "reddit_account"),
          eq(adapterRefreshQueue.type, "sub_poll"),
        ),
      );
    expect(continuationRows).toHaveLength(0);
  });

  it("incremental tick — backfill_complete=true: no cursor used, no continuation enqueued", async () => {
    const sub = "WalkerSubThree";
    await db.insert(redditSubredditsCache).values({
      name: sub,
      backfillAfterCursor: null,
      backfillComplete: true,
    });

    const fetchSpy = mockFetchSequence([
      () =>
        buildListingResponse({
          after: "t3_some_cursor",
          children: [
            {
              postId: "fresh1",
              subreddit: sub,
              author: "uF",
              title: "fresh top of /new",
              createdUtcSeconds: 1780000000,
            },
          ],
        }),
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const result = await handleSubPoll({ sub, userId: null });

    expect(result.walking).toBe(false);

    const [cacheRow] = await db
      .select()
      .from(redditSubredditsCache)
      .where(eq(redditSubredditsCache.name, sub));
    // Walker stays "complete" — incremental fetch must NOT regress
    // the terminal flag. data.after from the response is ignored
    // because backfill_complete was already true.
    expect(cacheRow!.backfillComplete).toBe(true);
    expect(cacheRow!.backfillAfterCursor).toBeNull();

    const continuationRows = await db
      .select()
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.adapterKind, "reddit_account"));
    expect(continuationRows).toHaveLength(0);
  });

  it("CAS race — two simultaneous persists with same expected cursor: only one commits + one continuation enqueued", async () => {
    const sub = "WalkerCasRace";
    await db.insert(redditSubredditsCache).values({
      name: sub,
      backfillAfterCursor: "t3_priorX",
      backfillComplete: false,
    });

    // Two replicas both read prior cursor "t3_priorX" and both compute
    // next cursor "t3_nextY" for the same page. Run both commits and
    // assert exactly one wins.
    const [a, b] = await Promise.all([
      commitSubredditWalkProgress(sub, {
        expectedAfterCursor: "t3_priorX",
        nextAfterCursor: "t3_nextY",
        backfillComplete: false,
        oldestSubmittedAt: new Date(1700000000 * 1000),
      }),
      commitSubredditWalkProgress(sub, {
        expectedAfterCursor: "t3_priorX",
        nextAfterCursor: "t3_nextY",
        backfillComplete: false,
        oldestSubmittedAt: new Date(1700000000 * 1000),
      }),
    ]);
    const wins = [a, b].filter((r) => r.committed).length;
    expect(wins).toBe(1);

    const continuationRows = await db
      .select()
      .from(adapterRefreshQueue)
      .where(
        and(
          eq(adapterRefreshQueue.adapterKind, "reddit_account"),
          eq(adapterRefreshQueue.type, "sub_poll"),
          eq(adapterRefreshQueue.queueName, "service_source"),
        ),
      );
    expect(continuationRows).toHaveLength(1);

    const [cacheRow] = await db
      .select()
      .from(redditSubredditsCache)
      .where(eq(redditSubredditsCache.name, sub));
    expect(cacheRow!.backfillAfterCursor).toBe("t3_nextY");
  });

  it("CAS race — loser tries to commit against stale expected cursor: no persist, no continuation", async () => {
    const sub = "WalkerCasStale";
    // Cache row has already moved past the cursor the caller observed.
    await db.insert(redditSubredditsCache).values({
      name: sub,
      backfillAfterCursor: "t3_currentZ",
      backfillComplete: false,
    });

    const result = await commitSubredditWalkProgress(sub, {
      expectedAfterCursor: "t3_staleY",
      nextAfterCursor: "t3_wouldBe",
      backfillComplete: false,
      oldestSubmittedAt: new Date(1700000000 * 1000),
    });
    expect(result.committed).toBe(false);

    const [cacheRow] = await db
      .select()
      .from(redditSubredditsCache)
      .where(eq(redditSubredditsCache.name, sub));
    expect(cacheRow!.backfillAfterCursor).toBe("t3_currentZ");

    const continuationRows = await db
      .select()
      .from(adapterRefreshQueue)
      .where(eq(adapterRefreshQueue.adapterKind, "reddit_account"));
    expect(continuationRows).toHaveLength(0);
  });
});
