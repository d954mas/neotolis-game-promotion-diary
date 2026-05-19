// Regression coverage for handlePostsRefresh missing-id handling.
//
// The bug: when Reddit returns empty children for an externalId we
// requested, the handler used to unconditionally INSERT a status='not_found'
// snapshot — but reddit_post_snapshots.post_id is FK'd to reddit_posts,
// and an event paste whose syncStats.fetch failed silently leaves the
// event row with externalId but NO parent cache row. Refresh-Now on
// that event then routed through handlePostsRefresh and 23503-faulted
// on snapshot INSERT, dead-lettering the queue row after 5 retries.
//
// Post-fix: pre-filter missing ids to those that have a parent row,
// skip orphans. Orphan paths surface as INFO log + zero side effects.

import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import {
  redditPosts,
  redditPostSnapshots,
} from "../../src/lib/sources/reddit/server/schema/index.js";
import { handlePostsRefresh } from "../../src/lib/sources/reddit/server/handlers/posts-refresh.js";
import {
  upsertRedditSubreddit,
  upsertRedditPost,
} from "../../src/lib/sources/reddit/server/upsert.js";

// Stub redditFetch's /api/info call to return a Listing with children
// = [] for every requested id. Matches Reddit's "graceful 404" shape
// for /api/info?id=t3_X where X doesn't exist.
function stubEmptyChildrenFetch(): ReturnType<typeof vi.fn> {
  const fetchSpy = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ kind: "Listing", data: { children: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

describe("handlePostsRefresh — missing-id FK safety", () => {
  it("orphan missing id (no parent reddit_posts row) does NOT INSERT snapshot — no FK fault", async () => {
    stubEmptyChildrenFetch();
    // No cache row seeded — the id is purely "claimed by an event but
    // never landed in cache". Mirrors the createEvent-with-failed-
    // syncStats production path.
    await expect(
      handlePostsRefresh({ postIds: ["t3_orphan"], userId: null, pacer: "already-acquired" }),
    ).resolves.toEqual({ presentIds: [], missingIds: ["t3_orphan"] });

    // No snapshot row written for the orphan — that's the contract.
    const snapRows = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, "t3_orphan"));
    expect(snapRows).toHaveLength(0);
  });

  it("missing id WITH parent → writes not_found snapshot as before (deletion-propagation signal)", async () => {
    stubEmptyChildrenFetch();
    // Seed parent cache row so the post is "known but now gone".
    await upsertRedditSubreddit(db, {
      name: "indiedev",
      subredditId: null,
      subscribers: null,
      accountsActive: null,
      description: null,
      publicDescription: null,
    });
    await upsertRedditPost(db, {
      postId: "t3_seen_gone",
      subreddit: "indiedev",
      author: "someone",
      authorFullname: "t2_someone",
      permalink: "/r/indiedev/comments/seen_gone/post",
      title: "Title before deletion",
      submittedAt: new Date(),
      metadata: {},
    });

    const result = await handlePostsRefresh({
      postIds: ["t3_seen_gone"],
      userId: null,
      pacer: "already-acquired",
    });
    expect(result.missingIds).toEqual(["t3_seen_gone"]);

    // not_found snapshot DID land — parent exists, FK satisfied.
    const snapRows = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, "t3_seen_gone"));
    expect(snapRows).toHaveLength(1);
    expect(snapRows[0]!.status).toBe("not_found");
  });

  it("mixed batch: one orphan + one seen → only seen gets a snapshot", async () => {
    stubEmptyChildrenFetch();
    await upsertRedditSubreddit(db, {
      name: "indiedev",
      subredditId: null,
      subscribers: null,
      accountsActive: null,
      description: null,
      publicDescription: null,
    });
    await upsertRedditPost(db, {
      postId: "t3_seen_mixed",
      subreddit: "indiedev",
      author: "someone",
      authorFullname: "t2_someone",
      permalink: "/r/indiedev/comments/seen_mixed/post",
      title: "Title",
      submittedAt: new Date(),
      metadata: {},
    });

    const result = await handlePostsRefresh({
      postIds: ["t3_seen_mixed", "t3_orphan_mixed"],
      userId: null,
      pacer: "already-acquired",
    });
    expect(result.missingIds.sort()).toEqual(["t3_orphan_mixed", "t3_seen_mixed"]);

    const seenSnap = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, "t3_seen_mixed"));
    expect(seenSnap).toHaveLength(1);

    const orphanSnap = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, "t3_orphan_mixed"));
    expect(orphanSnap).toHaveLength(0);

    // Parent cache rows: seen one stays (we don't touch present-id rows
    // on a miss), orphan never had one.
    const seenPost = await db
      .select()
      .from(redditPosts)
      .where(eq(redditPosts.postId, "t3_seen_mixed"));
    expect(seenPost).toHaveLength(1);
    const orphanPost = await db
      .select()
      .from(redditPosts)
      .where(eq(redditPosts.postId, "t3_orphan_mixed"));
    expect(orphanPost).toHaveLength(0);
  });
});
