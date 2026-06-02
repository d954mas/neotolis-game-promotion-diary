// VIZ-01 — adapter-driven per-event metric series (D-14). Each source adapter
// exposes `fetchEventMetricSeries(userId, event)` returning ASC-ordered points
// read from its own public-data snapshot table by externalId. YouTube emits
// view/like/comment series; Reddit emits score/num_comments. The tenant
// guarantee comes from the caller's event SELECT (these snapshot tables are
// public-data, in the ESLint allowlist), mirroring `enrichFeedDtos`.
//
// Real Postgres via the integration service container; no mocks. Model the
// seed/assert on tests/integration/youtube-snapshot-read.test.ts and
// reddit-snapshots.test.ts.

import { describe, it, expect } from "vitest";

const { db } = await import("../../src/lib/server/db/client.js");
const { youtubeVideoSnapshots } = await import("../../src/lib/server/db/schema/index.js");
const { youtubeFetchEventMetricSeries } = await import(
  "../../src/lib/sources/youtube/server/metric-series.js"
);

const uniq = (): string => Math.random().toString(36).slice(2, 10);

// Seed N snapshot rows at distinct minute-truncated polled_at values (oldest
// first), so ASC ordering and per-point values are unambiguous.
async function seedYoutubeSnapshots(
  videoId: string,
  rows: ReadonlyArray<{ minutesAgo: number; view: number; like: number; comment: number }>,
): Promise<void> {
  await db.insert(youtubeVideoSnapshots).values(
    rows.map((r) => ({
      videoId,
      polledAt: new Date(Date.now() - r.minutesAgo * 60_000),
      viewCount: r.view,
      likeCount: r.like,
      commentCount: r.comment,
    })),
  );
}

describe("event metric series (VIZ-01)", () => {
  it("youtube adapter fetchEventMetricSeries returns ASC view/like/comment series", async () => {
    const videoId = `vid_${uniq()}`;
    await seedYoutubeSnapshots(videoId, [
      { minutesAgo: 40, view: 100, like: 5, comment: 1 },
      { minutesAgo: 30, view: 250, like: 12, comment: 3 },
      { minutesAgo: 20, view: 500, like: 25, comment: 7 },
      { minutesAgo: 10, view: 900, like: 40, comment: 11 },
    ]);

    const series = await youtubeFetchEventMetricSeries("ignored-user", {
      kind: "youtube_video",
      externalId: videoId,
    });

    // Three series total: view/like/comment.
    expect(series.map((s) => s.metricKey)).toEqual(["view_count", "like_count", "comment_count"]);
    expect(series.map((s) => s.labelKey)).toEqual([
      "chart_metric_views",
      "chart_metric_likes",
      "chart_metric_comments",
    ]);

    const views = series.find((s) => s.metricKey === "view_count")!;
    expect(views.points).toHaveLength(4);
    // ASC by polledAt — values track the seeded ascending order.
    expect(views.points.map((p) => p.value)).toEqual([100, 250, 500, 900]);
    // polledAt is a serialisable ISO string, monotonically non-decreasing.
    const isoTimes = views.points.map((p) => p.polledAt);
    expect(isoTimes).toEqual([...isoTimes].sort());
    expect(typeof views.points[0]!.polledAt).toBe("string");

    const likes = series.find((s) => s.metricKey === "like_count")!;
    expect(likes.points.map((p) => p.value)).toEqual([5, 12, 25, 40]);
    const comments = series.find((s) => s.metricKey === "comment_count")!;
    expect(comments.points.map((p) => p.value)).toEqual([1, 3, 7, 11]);
  });

  it("youtube adapter self-filters: a reddit_post event returns []", async () => {
    const out = await youtubeFetchEventMetricSeries("ignored-user", {
      kind: "reddit_post",
      externalId: "t3_whatever",
    });
    expect(out).toEqual([]);
  });

  it("fewer than 3 snapshots still returns the available points (D-07)", async () => {
    const videoId = `vid_${uniq()}`;
    await seedYoutubeSnapshots(videoId, [
      { minutesAgo: 20, view: 10, like: 1, comment: 0 },
      { minutesAgo: 10, view: 30, like: 2, comment: 1 },
    ]);

    const series = await youtubeFetchEventMetricSeries("ignored-user", {
      kind: "youtube_video",
      externalId: videoId,
    });

    // Service returns the 2 points as-is (no fabricated trend) — the
    // component decides dots+caption. Three series, each with 2 points.
    const views = series.find((s) => s.metricKey === "view_count")!;
    expect(views.points).toHaveLength(2);
    expect(views.points.map((p) => p.value)).toEqual([10, 30]);
  });

  it("youtube adapter returns [] when the video has no snapshots", async () => {
    const out = await youtubeFetchEventMetricSeries("ignored-user", {
      kind: "youtube_video",
      externalId: `vid_${uniq()}`,
    });
    expect(out).toEqual([]);
  });

  it.skip("reddit adapter fetchEventMetricSeries returns ASC score/num_comments series (Plan 04-02)");
});
