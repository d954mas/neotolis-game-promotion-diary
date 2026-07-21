// Reddit metric-series reader (VIZ-05) — direct unit-of-behavior coverage restored
// after the Phase-12 razing trimmed the reddit blocks out of event-metric-series.test.ts
// (that file's remaining coverage now only exercises a SINGLE snapshot, so ASC ordering
// across MULTIPLE snapshots was unproven). Real Postgres; redditFetchEventMetricSeries is
// a pure reader (no provider), so nothing is mocked.
//
// Requirements: VIZ-05 / POLL-04 (immutable snapshot history, never a mutable column).
import { describe, it, expect } from "vitest";
import { db } from "../../src/lib/server/db/client.js";
import { redditPosts, redditPostSnapshots } from "../../src/lib/server/db/schema/index.js";
import { redditFetchEventMetricSeries } from "../../src/lib/sources/reddit/server/metric-series.js";

const uniq = (): string => Math.random().toString(36).slice(2, 8);

describe("reddit metric series (VIZ-05)", () => {
  it("[12-04] returns like + comment series ordered ASC by polled_at across MANY snapshots", async () => {
    const postId = `t3_${uniq()}`;
    await db.insert(redditPosts).values({ postId, subredditSlug: "gamedev", lastPollStatus: "ok" });
    // Insert THREE snapshots OUT OF ORDER — the reader must sort ASC by polled_at.
    const t1 = new Date("2026-06-01T10:00:00Z");
    const t2 = new Date("2026-06-02T10:00:00Z");
    const t3 = new Date("2026-06-03T10:00:00Z");
    await db.insert(redditPostSnapshots).values([
      { postId, polledAt: t2, likeCount: 20, commentCount: 5 },
      { postId, polledAt: t1, likeCount: 10, commentCount: 2 },
      { postId, polledAt: t3, likeCount: 35, commentCount: 9 },
    ]);

    const series = await redditFetchEventMetricSeries("unused-user", {
      kind: "reddit_post",
      externalId: postId,
    });

    const likes = series.find((s) => s.metricKey === "like_count");
    const comments = series.find((s) => s.metricKey === "comment_count");
    expect(likes, "a like_count series is present").toBeDefined();
    expect(comments, "a comment_count series is present").toBeDefined();

    // ASC by polled_at (t1 → t2 → t3) regardless of insert order.
    expect(likes!.points.map((p) => p.polledAt)).toEqual([
      t1.toISOString(),
      t2.toISOString(),
      t3.toISOString(),
    ]);
    expect(likes!.points.map((p) => p.value)).toEqual([10, 20, 35]);
    expect(comments!.points.map((p) => p.value)).toEqual([2, 5, 9]);
  });

  it("[12-04] self-filters: a non-reddit_post kind returns [] (caller does not pre-filter)", async () => {
    const series = await redditFetchEventMetricSeries("unused-user", {
      kind: "youtube_video",
      externalId: "yt-123",
    });
    expect(series).toEqual([]);
  });

  it("[12-04] a null externalId returns [] (no snapshot key)", async () => {
    const series = await redditFetchEventMetricSeries("unused-user", {
      kind: "reddit_post",
      externalId: null,
    });
    expect(series).toEqual([]);
  });

  it("[12-04] a post with no snapshot history returns [] (nothing to chart)", async () => {
    const postId = `t3_${uniq()}`;
    await db.insert(redditPosts).values({ postId, subredditSlug: "gamedev", lastPollStatus: "ok" });
    const series = await redditFetchEventMetricSeries("unused-user", {
      kind: "reddit_post",
      externalId: postId,
    });
    expect(series).toEqual([]);
  });
});
