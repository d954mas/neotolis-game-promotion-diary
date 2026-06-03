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
import { sql } from "drizzle-orm";

const { db } = await import("../../src/lib/server/db/client.js");
const { youtubeVideoSnapshots } = await import("../../src/lib/server/db/schema/index.js");
const { youtubeFetchEventMetricSeries } =
  await import("../../src/lib/sources/youtube/server/metric-series.js");
const { redditFetchEventMetricSeries } =
  await import("../../src/lib/sources/reddit/server/metric-series.js");
const { upsertRedditPost, upsertRedditSubreddit } =
  await import("../../src/lib/sources/reddit/server/upsert.js");
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { createApp } = await import("../../src/lib/server/http/app.js");
const { seedUserDirectly } = await import("./helpers.js");
const { createEvent } = await import("../../src/lib/server/services/events.js");

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

  it("reddit adapter fetchEventMetricSeries returns ASC score/num_comments series", async () => {
    const postId = `t3_${uniq()}`;
    const sub = `sub_${uniq()}`;
    // reddit_post_snapshots.post_id FK → reddit_posts.post_id; seed the
    // parent chain (subreddit → post) before the snapshots.
    await upsertRedditSubreddit(db, {
      name: sub,
      subredditId: null,
      subscribers: null,
      accountsActive: null,
      description: null,
      publicDescription: null,
    });
    await upsertRedditPost(db, {
      postId,
      subreddit: sub,
      author: "op",
      authorFullname: "t2_op",
      permalink: `/r/${sub}/comments/${postId}`,
      title: "metric series post",
      submittedAt: new Date("2026-05-01T00:00:00Z"),
      metadata: {},
    });

    // 4 snapshots at distinct minute buckets (ascending score + comments),
    // inserted with explicit back-dated minute-truncated polled_at so the
    // (post_id, polled_at) PK admits all four rows.
    const seed: ReadonlyArray<{ minutesAgo: number; score: number; comments: number }> = [
      { minutesAgo: 40, score: 3, comments: 0 },
      { minutesAgo: 30, score: 9, comments: 2 },
      { minutesAgo: 20, score: 21, comments: 5 },
      { minutesAgo: 10, score: 40, comments: 8 },
    ];
    for (const s of seed) {
      await db.execute(sql`
        INSERT INTO reddit_post_snapshots
          (post_id, polled_at, status, score, num_comments, awards_total, upvote_ratio, removed_by_category)
        VALUES (
          ${postId},
          date_trunc('minute', NOW() - (${s.minutesAgo} || ' minutes')::interval),
          'ok', ${s.score}, ${s.comments}, 0, 0.95, NULL
        )
      `);
    }

    const series = await redditFetchEventMetricSeries("ignored-user", {
      kind: "reddit_post",
      externalId: postId,
    });

    // Two series total: score + num_comments.
    expect(series.map((s) => s.metricKey)).toEqual(["score", "num_comments"]);
    expect(series.map((s) => s.labelKey)).toEqual([
      "chart_metric_score",
      "chart_metric_num_comments",
    ]);

    const score = series.find((s) => s.metricKey === "score")!;
    expect(score.points).toHaveLength(4);
    expect(score.points.map((p) => p.value)).toEqual([3, 9, 21, 40]);
    const isoTimes = score.points.map((p) => p.polledAt);
    expect(isoTimes).toEqual([...isoTimes].sort());

    const comments = series.find((s) => s.metricKey === "num_comments")!;
    expect(comments.points.map((p) => p.value)).toEqual([0, 2, 5, 8]);
  });

  it("reddit adapter accepts the bare external id form (no t3_ prefix)", async () => {
    const bareId = uniq();
    const postId = `t3_${bareId}`;
    const sub = `sub_${uniq()}`;
    await upsertRedditSubreddit(db, {
      name: sub,
      subredditId: null,
      subscribers: null,
      accountsActive: null,
      description: null,
      publicDescription: null,
    });
    await upsertRedditPost(db, {
      postId,
      subreddit: sub,
      author: "op",
      authorFullname: "t2_op",
      permalink: `/r/${sub}/comments/${postId}`,
      title: "bare-id post",
      submittedAt: new Date("2026-05-01T00:00:00Z"),
      metadata: {},
    });
    await db.execute(sql`
      INSERT INTO reddit_post_snapshots
        (post_id, polled_at, status, score, num_comments, awards_total, upvote_ratio, removed_by_category)
      VALUES (${postId}, date_trunc('minute', NOW()), 'ok', 7, 1, 0, 0.9, NULL)
    `);

    // externalId passed WITHOUT the t3_ prefix — the reader normalizes.
    const series = await redditFetchEventMetricSeries("ignored-user", {
      kind: "reddit_post",
      externalId: bareId,
    });
    const score = series.find((s) => s.metricKey === "score")!;
    expect(score.points.map((p) => p.value)).toEqual([7]);
  });

  it("reddit adapter self-filters: a youtube_video event returns []", async () => {
    const out = await redditFetchEventMetricSeries("ignored-user", {
      kind: "youtube_video",
      externalId: "vid_whatever",
    });
    expect(out).toEqual([]);
  });
});

// GET /api/events/:id/metric-series (Plan 04-24). The EventDetailModal
// (feed + games surfaces) lazy-fetches this for the single opened event so
// VIZ-01 renders in the modal, not only on /events/[id]. Tenant-scoped:
// getEventById gates a foreign/missing id → 404 BEFORE any adapter snapshot
// read; the route loops allAdapters.fetchEventMetricSeries (adapter-driven,
// no db.select in the handler).
describe("GET /api/events/:id/metric-series endpoint (VIZ-01 modal lazy-fetch)", () => {
  const app = createApp();

  it("own youtube_video event returns the adapter view/like/comment series", async () => {
    const u = await seedUserDirectly({ email: `mseries-own-${uniq()}@test.local` });
    const videoId = `vid_${uniq()}`;
    await seedYoutubeSnapshots(videoId, [
      { minutesAgo: 30, view: 100, like: 5, comment: 1 },
      { minutesAgo: 20, view: 250, like: 12, comment: 3 },
      { minutesAgo: 10, view: 500, like: 25, comment: 7 },
    ]);
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "metric-series endpoint event",
        url: `https://www.youtube.com/watch?v=${videoId}`,
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events/${ev.id}/metric-series`, {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    const series = (await res.json()) as Array<{
      metricKey: string;
      points: Array<{ value: number }>;
    }>;
    expect(series.map((s) => s.metricKey)).toEqual(["view_count", "like_count", "comment_count"]);
    const views = series.find((s) => s.metricKey === "view_count")!;
    expect(views.points.map((p) => p.value)).toEqual([100, 250, 500]);
  });

  it("chartable event with 0 snapshots returns [] (the component renders the low-data caption)", async () => {
    const u = await seedUserDirectly({ email: `mseries-empty-${uniq()}@test.local` });
    const videoId = `vid_${uniq()}`; // no snapshots seeded
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "no-snapshot event",
        url: `https://www.youtube.com/watch?v=${videoId}`,
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events/${ev.id}/metric-series`, {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("cross-tenant event id → 404 (getEventById gate, never 403)", async () => {
    const owner = await seedUserDirectly({ email: `mseries-owner-${uniq()}@test.local` });
    const other = await seedUserDirectly({ email: `mseries-other-${uniq()}@test.local` });
    const ev = await createEvent(
      owner.id,
      {
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "owner's event",
        url: `https://www.youtube.com/watch?v=vid_${uniq()}`,
      },
      "127.0.0.1",
    );

    const res = await app.request(`/api/events/${ev.id}/metric-series`, {
      headers: { cookie: `neotolis.session_token=${other.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
    // Privacy invariant: no "forbidden"/"permission" leak for tenant-owned rows.
    expect(JSON.stringify(body)).not.toMatch(/forbidden|permission/i);
  });

  it("missing event id → 404", async () => {
    const u = await seedUserDirectly({ email: `mseries-missing-${uniq()}@test.local` });
    const res = await app.request(`/api/events/${uuidv7()}/metric-series`, {
      headers: { cookie: `neotolis.session_token=${u.signedSessionCookieValue}` },
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: "not_found" });
  });
});
