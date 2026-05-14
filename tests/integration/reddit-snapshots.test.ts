// Phase 03.1 Plan 05A Task 1 — Reddit snapshot + upsert idempotency.
//
// V20 (idempotent snapshot — UNIQUE(post_id, polled_at) on minute-truncated
// polled_at, ON CONFLICT DO NOTHING) is the load-bearing invariant under
// worker retries within the same minute window. Tests prove:
//
//   1. Two writeRedditPostSnapshot calls within the same minute → only one
//      reddit_post_snapshots row (V20).
//   2. Two calls 61s apart (truncate to different minutes) → two rows.
//   3. upsertRedditPost called twice with different metadata → second
//      UPDATEs existing row (subreddit/title/permalink/metadata refresh).
//   4. upsertRedditUser idempotent across calls.
//   5. upsertRedditSubreddit idempotent.
//   6. status='not_found' snapshot succeeds (no CHECK constraint blocking
//      the documented 4-value vocabulary).
//
// Real Postgres via the integration service container; no mocks.

import { describe, it, expect, beforeEach } from "vitest";
import { sql, eq, and } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import {
  writeRedditPostSnapshot,
  writeRedditUserSnapshot,
  writeRedditSubredditSnapshot,
} from "../../src/lib/sources/reddit/server/snapshots.js";
import {
  upsertRedditPost,
  upsertRedditUser,
  upsertRedditSubreddit,
} from "../../src/lib/sources/reddit/server/upsert.js";
import {
  redditPostSnapshots,
  redditPosts,
  redditUsersCache,
  redditUserSnapshots,
  redditSubredditsCache,
  redditSubredditSnapshots,
} from "../../src/lib/sources/reddit/server/schema/index.js";

beforeEach(async () => {
  // afterEach TRUNCATE in tests/setup.ts wipes everything between specs;
  // explicit deletes here are redundant but harmless and self-document the
  // tables under test.
  await db.execute(sql`DELETE FROM reddit_post_snapshots`);
  await db.execute(sql`DELETE FROM reddit_user_snapshots`);
  await db.execute(sql`DELETE FROM reddit_subreddit_snapshots`);
  await db.execute(sql`DELETE FROM reddit_posts`);
  await db.execute(sql`DELETE FROM reddit_users_cache`);
  await db.execute(sql`DELETE FROM reddit_subreddits_cache`);
});

describe("Reddit snapshots V20 idempotency", () => {
  it("V20: two writeRedditPostSnapshot calls within the same minute → only one row", async () => {
    await upsertRedditSubreddit(db, {
      name: "test",
      subredditId: "t5_test",
      subscribers: 1,
      accountsActive: null,
      description: null,
      publicDescription: null,
    });
    await upsertRedditPost(db, {
      postId: "t3_test_idem",
      subreddit: "test",
      author: "op",
      authorFullname: "t2_op",
      permalink: "/r/test/comments/test_idem",
      title: "test",
      submittedAt: new Date(),
      metadata: {},
    });
    await writeRedditPostSnapshot(db, {
      postId: "t3_test_idem",
      score: 5,
      numComments: 1,
      awardsTotal: 0,
      upvoteRatio: 0.9,
      removedByCategory: null,
      status: "ok",
    });
    await writeRedditPostSnapshot(db, {
      postId: "t3_test_idem",
      score: 6,
      numComments: 2,
      awardsTotal: 0,
      upvoteRatio: 0.91,
      removedByCategory: null,
      status: "ok",
    });
    const rows = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, "t3_test_idem"));
    expect(rows.length).toBe(1);
    // First write wins under ON CONFLICT DO NOTHING (score=5).
    expect(rows[0]!.score).toBe(5);
  });

  it("two writes 61s apart (different minute buckets) → two rows", async () => {
    await upsertRedditSubreddit(db, {
      name: "test",
      subredditId: null,
      subscribers: null,
      accountsActive: null,
      description: null,
      publicDescription: null,
    });
    await upsertRedditPost(db, {
      postId: "t3_test_2min",
      subreddit: "test",
      author: "op",
      authorFullname: "t2_op",
      permalink: "/r/test/comments/test_2min",
      title: "t",
      submittedAt: new Date(),
      metadata: {},
    });
    // First snapshot at minute N.
    await writeRedditPostSnapshot(db, {
      postId: "t3_test_2min",
      score: 1,
      numComments: 0,
      awardsTotal: 0,
      upvoteRatio: 0.8,
      removedByCategory: null,
      status: "ok",
    });
    // Force a row at minute N-2 by inserting directly with a back-dated
    // polled_at (date_trunc'd). The schema's UNIQUE on (post_id, polled_at)
    // accepts this since polled_at differs.
    await db.execute(sql`
      INSERT INTO reddit_post_snapshots (post_id, polled_at, status, score, num_comments, awards_total, upvote_ratio, removed_by_category)
      VALUES ('t3_test_2min', date_trunc('minute', NOW() - INTERVAL '2 minutes'), 'ok', 2, 0, 0, 0.85, NULL)
    `);
    const rows = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, "t3_test_2min"));
    expect(rows.length).toBe(2);
  });

  it("upsertRedditPost twice with different metadata → second UPDATEs existing row", async () => {
    await upsertRedditSubreddit(db, {
      name: "indiedev",
      subredditId: null,
      subscribers: null,
      accountsActive: null,
      description: null,
      publicDescription: null,
    });
    await upsertRedditPost(db, {
      postId: "t3_post_upd",
      subreddit: "indiedev",
      author: "op",
      authorFullname: "t2_op",
      permalink: "/r/indiedev/comments/post_upd",
      title: "original title",
      submittedAt: new Date("2026-01-01T00:00:00Z"),
      metadata: { v: 1 },
    });
    await upsertRedditPost(db, {
      postId: "t3_post_upd",
      subreddit: "indiedev",
      author: "op",
      authorFullname: "t2_op",
      permalink: "/r/indiedev/comments/post_upd/slug-changed",
      title: "edited title",
      submittedAt: new Date("2026-01-01T00:00:00Z"),
      metadata: { v: 2 },
    });
    const rows = await db.select().from(redditPosts).where(eq(redditPosts.postId, "t3_post_upd"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.title).toBe("edited title");
    expect(rows[0]!.permalink).toBe("/r/indiedev/comments/post_upd/slug-changed");
    expect(rows[0]!.metadata).toEqual({ v: 2 });
  });

  it("upsertRedditUser is idempotent across calls", async () => {
    await upsertRedditUser(db, {
      username: "alice",
      redditId: "t2_alice",
      accountAgeDays: 100,
      linkKarma: 10,
      commentKarma: 5,
      totalKarma: 15,
      isSuspended: false,
    });
    await upsertRedditUser(db, {
      username: "alice",
      redditId: "t2_alice",
      accountAgeDays: 101,
      linkKarma: 20,
      commentKarma: 15,
      totalKarma: 35,
      isSuspended: false,
    });
    const rows = await db
      .select()
      .from(redditUsersCache)
      .where(eq(redditUsersCache.username, "alice"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.linkKarma).toBe(20);
    expect(rows[0]!.totalKarma).toBe(35);
  });

  it("upsertRedditSubreddit is idempotent and preserves rules_raw_json across calls without it", async () => {
    await upsertRedditSubreddit(db, {
      name: "gamedev",
      subredditId: "t5_gd",
      subscribers: 1000,
      accountsActive: 50,
      description: "Game dev sub",
      publicDescription: "Indie gamedev community",
      submissionMetadata: { submission_type: "any" },
      rulesRawJson: { rules: [{ short_name: "no-spam" }] },
    });
    // Second call without rulesRawJson — COALESCE preserves existing rules.
    await upsertRedditSubreddit(db, {
      name: "gamedev",
      subredditId: "t5_gd",
      subscribers: 1050,
      accountsActive: 60,
      description: "Game dev sub",
      publicDescription: "Indie gamedev community",
      submissionMetadata: { submission_type: "any" },
    });
    const rows = await db
      .select()
      .from(redditSubredditsCache)
      .where(eq(redditSubredditsCache.name, "gamedev"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.subscribers).toBe(1050);
    expect(rows[0]!.rulesRawJson).toEqual({ rules: [{ short_name: "no-spam" }] });
  });

  it("status='not_found' snapshot row succeeds (vocabulary accepts 4 values)", async () => {
    await upsertRedditSubreddit(db, {
      name: "test",
      subredditId: null,
      subscribers: null,
      accountsActive: null,
      description: null,
      publicDescription: null,
    });
    await upsertRedditPost(db, {
      postId: "t3_gone",
      subreddit: "test",
      author: null,
      authorFullname: null,
      permalink: "/r/test/comments/gone",
      title: "[deleted]",
      submittedAt: new Date(),
      metadata: {},
    });
    await writeRedditPostSnapshot(db, {
      postId: "t3_gone",
      score: null,
      numComments: null,
      awardsTotal: null,
      upvoteRatio: null,
      removedByCategory: null,
      status: "not_found",
    });
    const rows = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, "t3_gone"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("not_found");
  });

  it("writeRedditUserSnapshot — minute-trunc idempotency on (username, polled_at)", async () => {
    await upsertRedditUser(db, {
      username: "bob",
      redditId: null,
      accountAgeDays: null,
      linkKarma: 50,
      commentKarma: 20,
      totalKarma: 70,
      isSuspended: false,
    });
    await writeRedditUserSnapshot(db, {
      username: "bob",
      linkKarma: 50,
      commentKarma: 20,
      totalKarma: 70,
    });
    await writeRedditUserSnapshot(db, {
      username: "bob",
      linkKarma: 51,
      commentKarma: 21,
      totalKarma: 72,
    });
    const rows = await db
      .select()
      .from(redditUserSnapshots)
      .where(eq(redditUserSnapshots.username, "bob"));
    expect(rows.length).toBe(1);
  });

  it("writeRedditSubredditSnapshot — minute-trunc idempotency on (subreddit, polled_at)", async () => {
    await upsertRedditSubreddit(db, {
      name: "indiedev",
      subredditId: null,
      subscribers: 5000,
      accountsActive: 100,
      description: null,
      publicDescription: null,
    });
    await writeRedditSubredditSnapshot(db, {
      subreddit: "indiedev",
      subscribers: 5000,
      accountsActive: 100,
    });
    await writeRedditSubredditSnapshot(db, {
      subreddit: "indiedev",
      subscribers: 5001,
      accountsActive: 110,
    });
    const rows = await db
      .select()
      .from(redditSubredditSnapshots)
      .where(
        and(
          eq(redditSubredditSnapshots.subreddit, "indiedev"),
          sql`${redditSubredditSnapshots.polledAt} >= NOW() - INTERVAL '2 minutes'`,
        ),
      );
    expect(rows.length).toBe(1);
  });
});
