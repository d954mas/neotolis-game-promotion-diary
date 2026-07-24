// Reddit feed-envelope belts (Phase 12 review fixes).
//
// Two provider-shape anomalies must NEVER read as an authoritative empty feed,
// because the walker treats a complete zero-post pass on an established source as
// "the subject deleted ALL posts" (reconcileAllDisappeared → the 48h GDPR purge
// clock on every tracked row):
//   1. success:true with the posts[] field ABSENT → AdapterError(transient).
//   2. a non-t3 row (t1 comment / t5 subreddit) → per-row drop (mapPostsResilient),
//      never a cached/imported post under a bogus externalId.
//
// Pure unit test — no DB, no live HTTP.
import { describe, it, expect } from "vitest";
import { normalizeRedditFeed } from "$lib/sources/reddit/server/normalize.js";
import { AdapterError } from "$lib/sources/errors.js";

function post(id: string, name = `t3_${id}`) {
  return {
    name,
    id,
    author: "d954mas",
    subreddit: "gamedev",
    title: `Devlog ${id}`,
    score: 1,
    num_comments: 0,
    created_utc: 1_750_000_000,
    permalink: `/r/gamedev/comments/${id}/x/`,
  };
}

describe("normalizeRedditFeed envelope belts (review fixes)", () => {
  it("success:true with posts[] ABSENT throws transient — never an authoritative empty feed", () => {
    for (const envelope of [
      { success: true, after: null },
      { success: true, posts: null },
    ]) {
      try {
        normalizeRedditFeed(envelope);
        expect.fail("expected AdapterError for a posts-less success envelope");
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterError);
        expect((err as AdapterError).category).toBe("transient");
      }
    }
  });

  it("a PRESENT-but-empty posts[] stays the authoritative empty feed (end-of-feed)", () => {
    const page = normalizeRedditFeed({ success: true, posts: [], after: null });
    expect(page.posts).toHaveLength(0);
    expect(page.endOfFeed).toBe(true);
    expect(page.droppedCount).toBe(0);
  });

  it("success:false still throws transient (soft-error page served as HTTP 200)", () => {
    expect(() => normalizeRedditFeed({ success: false, posts: [], after: null })).toThrowError(
      AdapterError,
    );
  });

  it("a non-t3 fullname row is DROPPED (identity belt), surviving rows keep the page lossy-marked", () => {
    const page = normalizeRedditFeed({
      success: true,
      posts: [post("aaa"), post("bbb", "t1_bbb"), post("ccc")],
      after: null,
    });
    expect(page.posts.map((p) => p.id)).toEqual(["t3_aaa", "t3_ccc"]);
    // droppedCount is the walker's lossy-pass signal — the reconcile suppressor.
    expect(page.droppedCount).toBe(1);
  });

  it("drops empty, mismatched, and non-base36 Reddit fullname identities", () => {
    const page = normalizeRedditFeed({
      success: true,
      posts: [
        post("aaa"),
        post("", "t3_"),
        post("bbb", "t3_aaa"),
        post("not-valid", "t3_not-valid"),
        post("ccc"),
        post("ddd"),
        post("eee"),
      ],
      after: null,
    });

    expect(page.posts.map((item) => item.id)).toEqual(["t3_aaa", "t3_ccc", "t3_ddd", "t3_eee"]);
    expect(page.droppedCount).toBe(3);
  });
});
