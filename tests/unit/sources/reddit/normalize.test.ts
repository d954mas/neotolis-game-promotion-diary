// D-09 normalizer, flipped live by Plan 12-03. Ground truth = the committed spike
// fixtures (real ScrapeCreators response bodies, 12-SPIKE.md). Asserts: the
// score→likes / num_comments→comments mapping, metrics-by-presence (absent →
// null, never 0), the raw snapshot columns, thumbnail-literal→null, buildRedditTitle,
// externalId=post.name, and the union-by-presence media-type derivation.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildRedditTitle,
  normalizeRedditFeed,
  normalizeRedditPost,
} from "$lib/sources/reddit/server/normalize.js";
import { AdapterError } from "$lib/sources/errors.js";

const authorFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../fixtures/reddit/author-search-page.json", import.meta.url)),
    "utf8",
  ),
) as { pages: Array<{ posts: unknown[]; after: string | null }> };

const subredditFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../fixtures/reddit/subreddit-page.json", import.meta.url)),
    "utf8",
  ),
) as { posts: unknown[]; after: string | null };

// The first author-search post: r/gameenginedevs "Ui widgets" — score 35, 7 comments.
const firstAuthorPost = authorFixture.pages[0]!.posts[0]! as Record<string, unknown>;

describe("reddit normalize (D-09 mapping — Phase 12)", () => {
  it("[12-03] normalize maps score→likes, num_comments→comments, views=null, shares=null", () => {
    const post = normalizeRedditPost(firstAuthorPost);
    expect(post.id).toBe("t3_1ubhppn"); // externalId = post.name (the t3_ fullname)
    expect(post.metrics.likes).toBe(35); // score
    expect(post.metrics.comments).toBe(7); // num_comments
    expect(post.metrics.views).toBeNull(); // Reddit exposes none
    expect(post.metrics.shares).toBeNull(); // num_crossposts absent
    expect(post.publishedAt.toISOString()).toBe("2026-06-21T05:32:18.000Z");
  });

  it("[12-03] metrics-by-presence: both metrics absent → null (never 0)", () => {
    const post = normalizeRedditPost({
      name: "t3_absent",
      id: "absent",
      // score + num_comments deliberately absent
      created_utc: 1700000000,
      permalink: "/r/x/comments/absent/",
    });
    expect(post.metrics.likes).toBeNull();
    expect(post.metrics.comments).toBeNull();
    // never coerced to 0
    expect(post.metrics.likes).not.toBe(0);
    expect(post.metrics.comments).not.toBe(0);
  });

  it("[12-03] surfaces raw score/upvote_ratio/num_comments/num_crossposts/removed_by_category for the snapshot writer", () => {
    // subreddit fixture post 0 carries a real upvote_ratio (author-search has null).
    const withRatio = subredditFixture.posts[0]! as Record<string, unknown>;
    const post = normalizeRedditPost(withRatio);
    expect(post.raw.score).toBe(0);
    expect(post.raw.upvoteRatio).toBeCloseTo(0.19230769, 5);
    expect(post.raw.numComments).toBe(10);
    // ABSENT from the ScrapeCreators response → null (forward-compat columns).
    expect(post.raw.numCrossposts).toBeNull();
    expect(post.raw.removedByCategory).toBeNull();

    // A synthetic post WITH the (future) fields surfaces them verbatim.
    const withRemoved = normalizeRedditPost({
      name: "t3_x",
      id: "x",
      score: 12,
      num_comments: 3,
      num_crossposts: 2,
      removed_by_category: "deleted",
      created_utc: 1700000000,
    });
    expect(withRemoved.raw.numCrossposts).toBe(2);
    expect(withRemoved.raw.removedByCategory).toBe("deleted");
  });

  it("[12-03] type derivation (is_self/thumbnail ABSENT): post_hint / domain / url-vs-permalink / selftext / is_video → self|link|image|gallery", () => {
    // subreddit fixture: post_hint "text" + self.gamedev domain → self
    const selfPost = normalizeRedditPost(subredditFixture.posts[0]! as Record<string, unknown>);
    expect(selfPost.mediaType).toBe("self");

    // subreddit fixture last post: post_hint "link" + tiktok.com domain → link
    const linkPost = normalizeRedditPost(subredditFixture.posts[3]! as Record<string, unknown>);
    expect(linkPost.mediaType).toBe("link");

    // author-search post (no post_hint): selftext + reddit comments url → self
    expect(normalizeRedditPost(firstAuthorPost).mediaType).toBe("self");

    // image by url (i.redd.it) — unsampled in the spike, derived defensively
    const imagePost = normalizeRedditPost({
      name: "t3_img",
      id: "img",
      url: "https://i.redd.it/abc123.jpg",
      created_utc: 1700000000,
    });
    expect(imagePost.mediaType).toBe("image");
    expect(imagePost.thumbnailUrl).toBe("https://i.redd.it/abc123.jpg");

    // gallery by url
    const galleryPost = normalizeRedditPost({
      name: "t3_gal",
      id: "gal",
      url: "https://www.reddit.com/gallery/gal",
      created_utc: 1700000000,
    });
    expect(galleryPost.mediaType).toBe("gallery");
  });

  it("[12-03] thumbnail literals 'self'/'default'/'nsfw'/'spoiler' → null", () => {
    for (const literal of ["self", "default", "nsfw", "spoiler"]) {
      const post = normalizeRedditPost({
        name: "t3_t",
        id: "t",
        thumbnail: literal,
        url: "https://www.reddit.com/r/x/comments/t/",
        created_utc: 1700000000,
      });
      expect(post.thumbnailUrl).toBeNull();
    }
  });

  it("[12-03] buildRedditTitle: first text line, ~100 char cap", () => {
    expect(buildRedditTitle("First line\nSecond line")).toBe("First line");
    expect(buildRedditTitle("  padded  ")).toBe("padded");
    expect(buildRedditTitle(null)).toBe("");
    expect(buildRedditTitle("")).toBe("");
    const long = "x".repeat(200);
    const built = buildRedditTitle(long);
    expect(built.length).toBeLessThanOrEqual(100);
    expect(built.endsWith("…")).toBe(true);
  });

  it("[12-03] union-by-presence: reads author-search (relative_position) AND subreddit (post_hint/domain/subreddit_id) shapes", () => {
    // Author-search envelope: terminal page has after: null → endOfFeed true.
    const terminal = authorFixture.pages[2]!;
    const authorPage = normalizeRedditFeed({ success: true, posts: terminal.posts, after: null });
    expect(authorPage.endOfFeed).toBe(true);
    expect(authorPage.nextCursor).toBeNull();
    expect(authorPage.posts.length).toBeGreaterThan(0); // terminal page still carries posts

    // Non-terminal author page: after present → more pages.
    const page0 = authorFixture.pages[0]!;
    const morePage = normalizeRedditFeed({ success: true, posts: page0.posts, after: page0.after });
    expect(morePage.endOfFeed).toBe(false);
    expect(morePage.nextCursor).toBe(page0.after);
    expect(morePage.owner?.username).toBe("d954mas"); // free owner anchor

    // Subreddit envelope (post_hint/domain/subreddit_id) parses cleanly.
    const subPage = normalizeRedditFeed(subredditFixture);
    expect(subPage.posts.length).toBe(4);
    expect(subPage.nextCursor).toBe("t3_1v1w68h");
    expect(subPage.endOfFeed).toBe(false);
  });

  it("[review-P2] created_utc absent → falls back to created_at_iso (NOT epoch 1970)", () => {
    const post = normalizeRedditPost({
      name: "t3_iso",
      id: "iso",
      // created_utc deliberately absent — the schema permits it (.optional())
      created_at_iso: "2026-03-01T12:00:00Z",
    });
    expect(post.publishedAt.toISOString()).toBe("2026-03-01T12:00:00.000Z");
  });

  it("[review-P2] NO resolvable timestamp → THROWS (honest drop, not a fabricated 'now')", () => {
    // A fabricated 'now' mis-tiers the post as freshly-active, re-orders chronology, and
    // can MASK the real newest post (tier + frontier key on published_at). Throwing makes
    // mapPostsResilient DROP the row instead — safe now that a dropped page suppresses the
    // disappearance reconcile (droppedCount), so a dropped-but-alive post is never
    // false-flagged deleted. NEITHER epoch 1970 (halts the walk) NOR now (poisons tiering).
    expect(() => normalizeRedditPost({ name: "t3_none", id: "none" })).toThrow();
  });

  it("[review-P1] droppedCount reports rows the resilient map dropped (drives reconcile suppression)", () => {
    const good1 = { name: "t3_a", id: "a", created_utc: 1_700_000_000 };
    const noTs = { name: "t3_b", id: "b" }; // unresolvable published_at → dropped
    const good2 = { name: "t3_c", id: "c", created_utc: 1_700_000_100 };
    const page = normalizeRedditFeed({ success: true, posts: [good1, noTs, good2], after: "t3_x" });
    // The bad row is dropped from posts[], and the loss is reported so the walker can
    // suppress the Variant-A disappearance reconcile on this (lossy) coverage pass.
    expect(page.posts.map((p) => p.id)).toEqual(["t3_a", "t3_c"]);
    expect(page.droppedCount).toBe(1);
  });

  it("[review-P1] a clean page reports droppedCount 0 (lossless coverage)", () => {
    const page = normalizeRedditFeed({
      success: true,
      posts: [{ name: "t3_a", id: "a", created_utc: 1_700_000_000 }],
      after: null,
    });
    expect(page.droppedCount).toBe(0);
  });

  it("[review-P2] explicit success:false → AdapterError(transient), NOT a false empty feed", () => {
    let thrown: unknown;
    try {
      normalizeRedditFeed({ success: false, posts: [], after: null });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as AdapterError).category).toBe("transient");
    // success absent/null stays the ok/loose path (no throw).
    expect(() => normalizeRedditFeed({ posts: [], after: null })).not.toThrow();
  });

  it("[review-P2] empty-string `after` collapses to end-of-feed (no page-1 re-fetch loop)", () => {
    const page0 = authorFixture.pages[0]!;
    const page = normalizeRedditFeed({ success: true, posts: page0.posts, after: "" });
    expect(page.nextCursor).toBeNull();
    expect(page.endOfFeed).toBe(true);
  });

  it("[review-P3] a stray malformed post is DROPPED; the rest of the page survives (no paid-page nuke)", () => {
    const good1 = { name: "t3_a", id: "a", author: "u", created_utc: 1_700_000_000 };
    const bad = { id: "b" }; // missing the REQUIRED `name` → REDDIT_POST.parse throws
    const good2 = { name: "t3_c", id: "c", author: "u", created_utc: 1_700_000_100 };
    const good3 = { name: "t3_d", id: "d", author: "u", created_utc: 1_700_000_200 };
    const page = normalizeRedditFeed({
      success: true,
      posts: [good1, bad, good2, good3],
      after: "t3_x",
    });
    // Only the bad row is dropped; the 3 good posts survive in order.
    expect(page.posts.map((p) => p.id)).toEqual(["t3_a", "t3_c", "t3_d"]);
    expect(page.owner?.username).toBe("u"); // owner still resolves from the first VALID post
  });

  it("[review-P3] a MAJORITY-unparseable page THROWS (shape drift), not a silent partial page", () => {
    const good = { name: "t3_a", id: "a", created_utc: 1_700_000_000 };
    const bad = [{ id: "b" }, { foo: 1 }, {}]; // 3 posts with no required `name`
    let thrown: unknown;
    try {
      normalizeRedditFeed({ success: true, posts: [good, ...bad], after: null });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as AdapterError).category).toBe("transient");
  });
});
