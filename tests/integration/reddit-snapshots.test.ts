// Reddit snapshot writer + subject-entity upserts (Phase 12, Plan 12-04) — driven
// directly against real Postgres (only the provider is ever mocked elsewhere; this
// storage layer needs no provider). Proves:
//   - writeSnapshot UPSERTs reddit_posts + INSERTs reddit_post_snapshots with the
//     raw D-09 columns (score / upvote_ratio / num_comments / num_crossposts /
//     removed_by_category) and the D-09 metric mapping (like_count=score,
//     comment_count=num_comments; NO view/share columns).
//   - the ★write-path deletion-detect belt: removed_by_category != null sets
//     deletion_detected_at, idempotent first-detect (a second write does NOT move
//     it). NOTE: dormant with ScrapeCreators (never returns the field) — the live
//     mechanism is Variant A (disappearance-from-walk) in Plan 05; this asserts the
//     unit-level belt with a synthetic snapshot.
//   - (post_id, polled_at) idempotency (ON CONFLICT DO NOTHING).
//   - upsertRedditAccount (by lowercase username) + upsertRedditSubreddit (by slug)
//     COALESCE-preserve prior good fields on a partial parse.
//
// Requirements: PLAT-04.
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../../src/lib/server/db/client.js";
import {
  redditAccounts,
  redditPosts,
  redditPostSnapshots,
  redditSubreddits,
} from "../../src/lib/server/db/schema/index.js";
import {
  writeSnapshot,
  upsertRedditAccount,
  upsertRedditSubreddit,
} from "../../src/lib/sources/reddit/server/snapshots.js";

const uniq = (): string => Math.random().toString(36).slice(2, 10);

async function readPost(postId: string) {
  const [row] = await db.select().from(redditPosts).where(eq(redditPosts.postId, postId)).limit(1);
  return row;
}

describe("reddit snapshots write path (Phase 12)", () => {
  it("[12-04] writeSnapshot UPSERTs reddit_posts + INSERTs reddit_post_snapshots with raw D-09 columns", async () => {
    const postId = `t3_${uniq()}`;
    await writeSnapshot({
      postId,
      subredditSlug: "gamedev",
      mediaType: "self",
      title: "My devlog #3",
      caption: "Long selftext body…",
      permalink: `https://www.reddit.com/r/gamedev/comments/${uniq()}/my-devlog-3/`,
      thumbnailUrl: null,
      publishedAt: new Date("2026-06-01T12:00:00Z"),
      author: "d954mas",
      authorFullname: "t2_abc123",
      metrics: { likes: 42, comments: 7 },
      raw: {
        score: 42,
        upvoteRatio: 0.97,
        numComments: 7,
        numCrossposts: null,
        removedByCategory: null,
      },
      status: "ok",
    });

    const post = await readPost(postId);
    expect(post).toBeDefined();
    expect(post!.subredditSlug).toBe("gamedev");
    expect(post!.mediaType).toBe("self");
    expect(post!.title).toBe("My devlog #3");
    expect(post!.author).toBe("d954mas");
    expect(post!.authorFullname).toBe("t2_abc123");
    expect(post!.lastPollStatus).toBe("ok");
    expect(post!.deletionDetectedAt).toBeNull();

    const [snap] = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, postId));
    expect(snap).toBeDefined();
    // D-09 metric mapping.
    expect(snap!.likeCount).toBe(42);
    expect(snap!.commentCount).toBe(7);
    // The raw D-09 columns stored verbatim.
    expect(snap!.score).toBe(42);
    expect(snap!.upvoteRatio).toBeCloseTo(0.97, 5);
    expect(snap!.numComments).toBe(7);
    // Absent from ScrapeCreators → null-by-presence, never 0.
    expect(snap!.numCrossposts).toBeNull();
    expect(snap!.removedByCategory).toBeNull();
  });

  it("[12-04] metrics are null-by-presence — an absent metric stores null, never 0", async () => {
    const postId = `t3_${uniq()}`;
    await writeSnapshot({
      postId,
      subredditSlug: "gamedev",
      mediaType: "link",
      metrics: { likes: null, comments: null },
      raw: {
        score: null,
        upvoteRatio: null,
        numComments: null,
        numCrossposts: null,
        removedByCategory: null,
      },
      status: "ok",
    });

    const [snap] = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, postId));
    expect(snap!.likeCount).toBeNull();
    expect(snap!.commentCount).toBeNull();
    expect(snap!.score).toBeNull();
  });

  it("[12-04] a non-ok poll updates polling state, writes NO snapshot, and COALESCE-preserves prior fields", async () => {
    const postId = `t3_${uniq()}`;
    await writeSnapshot({
      postId,
      subredditSlug: "gamedev",
      mediaType: "image",
      thumbnailUrl: "https://i.redd.it/good.jpg",
      author: "d954mas",
      metrics: { likes: 5, comments: 1 },
      raw: {
        score: 5,
        upvoteRatio: 0.8,
        numComments: 1,
        numCrossposts: null,
        removedByCategory: null,
      },
      status: "ok",
    });
    // A failed refresh carries no metrics + all-null snippet fields.
    await writeSnapshot({ postId, metrics: null, status: "not_found" });

    const post = await readPost(postId);
    expect(post!.lastPollStatus).toBe("not_found");
    expect(post!.pollFailureCount).toBe(1);
    // The working values were PRESERVED (not blanked by the failed poll).
    expect(post!.thumbnailUrl).toBe("https://i.redd.it/good.jpg");
    expect(post!.author).toBe("d954mas");
    expect(post!.subredditSlug).toBe("gamedev");

    // Exactly one snapshot (the ok poll); the not_found poll wrote none.
    const snaps = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, postId));
    expect(snaps).toHaveLength(1);
  });

  it("[review-P1] a PURGED author is FROZEN — a later cross-subject snapshot never restores it", async () => {
    const postId = `t3_${uniq()}`;
    // A live post, tracked with its author.
    await writeSnapshot({
      postId,
      subredditSlug: "gamedev",
      author: "gallowboob",
      authorFullname: "t2_boob",
      metrics: { likes: 3, comments: 1 },
      raw: {
        score: 3,
        upvoteRatio: 0.9,
        numComments: 1,
        numCrossposts: null,
        removedByCategory: null,
      },
      status: "ok",
    });
    // The author-walk flagged it deleted and the Plan-05 purge cron nulled author* after
    // the 48h grace window.
    await db
      .update(redditPosts)
      .set({
        deletionDetectedAt: new Date(Date.now() - 72 * 3_600_000),
        author: null,
        authorFullname: null,
      })
      .where(eq(redditPosts.postId, postId));

    // The SAME post is STILL ALIVE in some subreddit's feed, so a cross-subject
    // writeSnapshot carries the (public) author again. Pre-fix the plain COALESCE
    // resurrected the purged identity while deletion_detected_at stayed set — a GDPR leak.
    await writeSnapshot({
      postId,
      subredditSlug: "gamedev",
      author: "gallowboob",
      authorFullname: "t2_boob",
      metrics: { likes: 4, comments: 2 },
      raw: {
        score: 4,
        upvoteRatio: 0.9,
        numComments: 2,
        numCrossposts: null,
        removedByCategory: null,
      },
      status: "ok",
    });

    const post = await readPost(postId);
    expect(post!.author, "purged author stays null while deletion_detected_at is set").toBeNull();
    expect(post!.authorFullname).toBeNull();
    // The flag itself is untouched (the write path never clears it).
    expect(post!.deletionDetectedAt).not.toBeNull();
  });

  it("[12-04] (post_id, polled_at) UNIQUE → within-the-minute retries idempotent (ON CONFLICT DO NOTHING)", async () => {
    const postId = `t3_${uniq()}`;
    const args = {
      postId,
      subredditSlug: "gamedev",
      mediaType: "self",
      metrics: { likes: 1, comments: 0 },
      raw: {
        score: 1,
        upvoteRatio: 1,
        numComments: 0,
        numCrossposts: null,
        removedByCategory: null,
      },
      status: "ok" as const,
    };
    // Two writes in the same minute (polled_at = date_trunc('minute', now())).
    await writeSnapshot(args);
    await writeSnapshot({ ...args, metrics: { likes: 999, comments: 999 } });

    const snaps = await db
      .select()
      .from(redditPostSnapshots)
      .where(eq(redditPostSnapshots.postId, postId));
    // Collapsed to one row — the second INSERT hit ON CONFLICT DO NOTHING.
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.likeCount).toBe(1);
  });

  it("[12-04] deletion-detect belt: removed_by_category != null sets deletion_detected_at idempotently (first-detect only)", async () => {
    const postId = `t3_${uniq()}`;
    // A clean poll first — no deletion signal.
    await writeSnapshot({
      postId,
      subredditSlug: "gamedev",
      mediaType: "self",
      metrics: { likes: 3, comments: 2 },
      raw: {
        score: 3,
        upvoteRatio: 0.9,
        numComments: 2,
        numCrossposts: null,
        removedByCategory: null,
      },
      status: "ok",
    });
    expect((await readPost(postId))!.deletionDetectedAt).toBeNull();

    // A synthetic snapshot carrying removed_by_category — the write-path belt fires.
    await writeSnapshot({
      postId,
      metrics: { likes: 3, comments: 2 },
      raw: {
        score: 3,
        upvoteRatio: 0.9,
        numComments: 2,
        numCrossposts: null,
        removedByCategory: "moderator",
      },
      status: "ok",
    });
    const detected = (await readPost(postId))!.deletionDetectedAt;
    expect(detected).not.toBeNull();

    // A THIRD write with the field still set must NOT move the timestamp
    // (idempotent first-detect — the grace clock never resets).
    await new Promise((r) => setTimeout(r, 5));
    await writeSnapshot({
      postId,
      metrics: { likes: 3, comments: 2 },
      raw: {
        score: 3,
        upvoteRatio: 0.9,
        numComments: 2,
        numCrossposts: null,
        removedByCategory: "moderator",
      },
      status: "ok",
    });
    expect((await readPost(postId))!.deletionDetectedAt!.getTime()).toBe(detected!.getTime());
  });

  it("[12-04] upsertRedditAccount (by lowercase username) COALESCE-preserves richer fields on partial parse", async () => {
    const username = `User_${uniq()}`;
    await upsertRedditAccount({
      username,
      title: "Indie Dev",
      iconUrl: "https://icon/good.png",
      karma: 1234,
      followerCount: 50,
    });
    const canonical = username.toLowerCase();
    const [first] = await db
      .select()
      .from(redditAccounts)
      .where(eq(redditAccounts.username, canonical));
    // Keyed on the lowercase username (rename-proof intrinsic PK).
    expect(first!.username).toBe(canonical);
    expect(first!.title).toBe("Indie Dev");

    // A transient miss (all rich fields null) must NOT blank the prior good values.
    await upsertRedditAccount({
      username,
      title: null,
      iconUrl: null,
      karma: null,
      followerCount: null,
    });
    const [second] = await db
      .select()
      .from(redditAccounts)
      .where(eq(redditAccounts.username, canonical));
    expect(second!.title).toBe("Indie Dev");
    expect(second!.iconUrl).toBe("https://icon/good.png");
    expect(second!.karma).toBe(1234);
    expect(second!.followerCount).toBe(50);
  });

  it("[12-04] upsertRedditSubreddit (by slug) COALESCE-preserves richer fields on partial parse", async () => {
    const slug = `GameDev_${uniq()}`;
    await upsertRedditSubreddit({
      slug,
      title: "Game Development",
      subscriberCount: 1_800_000,
      iconUrl: "https://icon/sub.png",
    });
    const canonical = slug.toLowerCase();
    const [first] = await db
      .select()
      .from(redditSubreddits)
      .where(eq(redditSubreddits.slug, canonical));
    expect(first!.slug).toBe(canonical);
    expect(first!.title).toBe("Game Development");

    await upsertRedditSubreddit({ slug, title: null, subscriberCount: null, iconUrl: null });
    const [second] = await db
      .select()
      .from(redditSubreddits)
      .where(eq(redditSubreddits.slug, canonical));
    expect(second!.title).toBe("Game Development");
    expect(second!.subscriberCount).toBe(1_800_000);
    expect(second!.iconUrl).toBe("https://icon/sub.png");
  });
});
