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
const { uuidv7 } = await import("../../src/lib/server/ids.js");
const { createApp } = await import("../../src/lib/server/http/app.js");
const { seedUserDirectly } = await import("./helpers.js");
const { createEvent } = await import("../../src/lib/server/services/events.js");
const { getEventMetricSeries, getEventMetricSeriesForRow } =
  await import("../../src/lib/server/services/event-metric-series.js");
const { NotFoundError } = await import("../../src/lib/server/services/errors.js");

const uniq = (): string => Math.random().toString(36).slice(2, 10);

// Seed N snapshot rows at distinct minute-truncated polled_at values (oldest
// first), so ASC ordering and per-point values are unambiguous.
async function seedYoutubeSnapshots(
  videoId: string,
  rows: ReadonlyArray<{
    minutesAgo: number;
    view: number | null;
    like: number | null;
    comment: number | null;
  }>,
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

  it("a NULL count is a gap (null), never a false 0; an all-null metric is dropped", async () => {
    // Likes hidden for the whole history → like_count NULL throughout. Comments
    // hidden for ONE poll → a single null point mid-series.
    const videoId = `vid_${uniq()}`;
    await seedYoutubeSnapshots(videoId, [
      { minutesAgo: 30, view: 100, like: null, comment: 1 },
      { minutesAgo: 20, view: 250, like: null, comment: null },
      { minutesAgo: 10, view: 500, like: null, comment: 7 },
    ]);

    const series = await youtubeFetchEventMetricSeries("ignored-user", {
      kind: "youtube_video",
      externalId: videoId,
    });

    // The all-null likes metric is gone — no dead legend toggle.
    expect(series.map((s) => s.metricKey)).toEqual(["view_count", "comment_count"]);
    // The mid-series hidden comment stays null (a GAP), not coerced to 0.
    const comments = series.find((s) => s.metricKey === "comment_count")!;
    expect(comments.points.map((p) => p.value)).toEqual([1, null, 7]);
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

// The extracted service (event-metric-series.ts) — both the API route AND the
// /events/[id] SSR loader call this now instead of duplicating the adapter loop
// (#2). getEventMetricSeries is tenant-gated by getEventById (404, never 403);
// getEventMetricSeriesForRow is the bare adapter loop for an already-vetted row.
describe("getEventMetricSeries service (VIZ-01 #2 extraction)", () => {
  it("own youtube_video event → the adapter view/like/comment series", async () => {
    const u = await seedUserDirectly({ email: `mseries-svc-own-${uniq()}@test.local` });
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
        title: "service own event",
        url: `https://www.youtube.com/watch?v=${videoId}`,
      },
      "127.0.0.1",
    );

    const series = await getEventMetricSeries(u.id, ev.id);
    expect(series.map((s) => s.metricKey)).toEqual(["view_count", "like_count", "comment_count"]);
    const views = series.find((s) => s.metricKey === "view_count")!;
    expect(views.points.map((p) => p.value)).toEqual([100, 250, 500]);
  });

  it("chartable event with 0 snapshots → [] (provided-but-empty, no 404)", async () => {
    const u = await seedUserDirectly({ email: `mseries-svc-empty-${uniq()}@test.local` });
    const ev = await createEvent(
      u.id,
      {
        gameIds: [],
        kind: "youtube_video",
        occurredAt: new Date("2026-06-01T10:00:00Z"),
        title: "service no-snapshot event",
        url: `https://www.youtube.com/watch?v=vid_${uniq()}`,
      },
      "127.0.0.1",
    );
    await expect(getEventMetricSeries(u.id, ev.id)).resolves.toEqual([]);
  });

  it("cross-tenant event id → NotFoundError (the 404 gate, never 403)", async () => {
    const owner = await seedUserDirectly({ email: `mseries-svc-owner-${uniq()}@test.local` });
    const other = await seedUserDirectly({ email: `mseries-svc-other-${uniq()}@test.local` });
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
    await expect(getEventMetricSeries(other.id, ev.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("missing event id → NotFoundError", async () => {
    const u = await seedUserDirectly({ email: `mseries-svc-missing-${uniq()}@test.local` });
    await expect(getEventMetricSeries(u.id, uuidv7())).rejects.toBeInstanceOf(NotFoundError);
  });

  it("getEventMetricSeriesForRow runs the adapter loop on a bare row (loader path)", async () => {
    const u = await seedUserDirectly({ email: `mseries-svc-row-${uniq()}@test.local` });
    const videoId = `vid_${uniq()}`;
    await seedYoutubeSnapshots(videoId, [
      { minutesAgo: 20, view: 11, like: 1, comment: 0 },
      { minutesAgo: 10, view: 22, like: 2, comment: 1 },
    ]);
    // The loader passes the already-vetted row's {kind, externalId} directly —
    // no event id, no re-SELECT. Self-filtering: a reddit_post row → [].
    const series = await getEventMetricSeriesForRow(u.id, {
      kind: "youtube_video",
      externalId: videoId,
    });
    const views = series.find((s) => s.metricKey === "view_count")!;
    expect(views.points.map((p) => p.value)).toEqual([11, 22]);

    const none = await getEventMetricSeriesForRow(u.id, {
      kind: "youtube_video",
      externalId: null,
    });
    expect(none).toEqual([]);
  });
});
