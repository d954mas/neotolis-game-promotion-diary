// Telegram feed + chart visualization — integration tests (real Postgres via
// tests/setup.ts; CLAUDE.md forbids DB mocks).
//
// Filled in Plan 09-06 (was a Plan 01 placeholder). Proves the D-05 feed-vs-
// chart split on the EXISTING cross-source machinery now that the Telegram
// adapter is registered (Plan 05) and the UI mapper is wired (Plan 06):
//
//   - A telegram_post WITH a view-count snapshot → the cross-source
//     getEventMetricSeries loader (iterating allAdapters →
//     telegramFetchEventMetricSeries) returns a single `view_count` series
//     carrying that point. The post also enriches with telegramEnrichment so
//     the TelegramFeedCard renders the views chip + thumbnail.
//   - A telegram_post whose ONLY snapshot has viewCount=null (or no snapshot
//     at all) → getEventMetricSeries returns NO view_count series (the chart
//     omits it — D-05: null is a GAP, never a 0/false-drop), YET the event row
//     still exists in the feed (enrichFeedDtos attaches telegramEnrichment with
//     stats=null so the card renders text/thumbnail but no views chip).
//
// These tests seed an `events` row + the snapshot cache directly (rather than
// driving the listing/backfill handlers) so they exercise ONLY the read-path
// machinery the /games/[id] chart + /feed surface use. (The handlers DO
// auto-create events now via materializeTelegramEvents — covered by the
// listing-poll / backfill-walker tests; here we isolate the read path.)

import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { telegramPosts, telegramPostSnapshots } from "../../src/lib/server/db/schema/index.js";
import { getEventMetricSeries } from "../../src/lib/server/services/event-metric-series.js";
import { telegramEnrichFeedDtos } from "../../src/lib/sources/telegram/server/feed-enrichment.js";
import { writeTelegramSnapshot } from "../../src/lib/sources/telegram/server/snapshots.js";
import type { TelegramReaction } from "../../src/lib/sources/telegram/server/schema/posts.js";
import type { EventDto } from "../../src/lib/server/dto.js";
import { seedUserDirectly } from "./helpers.js";

const uniq = (): string => Math.random().toString(36).slice(2, 10);

interface SeedPostOpts {
  userId: string;
  postId: string;
  /** null → seed NO snapshot row (the "very new / views hidden" case). */
  viewCount: number | null;
  /** Summed reaction count for the seeded snapshot row. Default null → the
   *  reactions metric is absent (D-05 GAP). */
  reactionsTotal?: number | null;
  /** Top-5 reactions current-state on telegram_posts. Default null. */
  reactionsTop?: TelegramReaction[] | null;
  mediaKind?: string | null;
  thumbnailUrl?: string | null;
}

/** Seed an events row (kind=telegram_post, externalId=postId) + the telegram_posts
 *  cache row, and — only when viewCount OR reactionsTotal is non-null — one
 *  telegram_post_snapshots row. Returns the event id. */
async function seedTelegramEvent(opts: SeedPostOpts): Promise<string> {
  const reactionsTotal = opts.reactionsTotal ?? null;
  await db.insert(telegramPosts).values({
    postId: opts.postId,
    channelKey: "1006503122",
    textSnippet: "promo snippet",
    mediaKind: opts.mediaKind ?? null,
    thumbnailUrl: opts.thumbnailUrl ?? null,
    reactionsTop: opts.reactionsTop ?? null,
    externalUrl: `https://t.me/${opts.postId}`,
    publishedAt: new Date("2026-06-01T00:00:00Z"),
    lastPolledAt: new Date(),
    lastPollStatus: "ok",
  });

  if (opts.viewCount !== null || reactionsTotal !== null) {
    await db.insert(telegramPostSnapshots).values({
      postId: opts.postId,
      polledAt: new Date("2026-06-02T12:00:00Z"),
      viewCount: opts.viewCount,
      reactionsTotal,
    });
  }

  const [ev] = await db
    .insert(events)
    .values({
      userId: opts.userId,
      kind: "telegram_post",
      occurredAt: new Date("2026-06-01T00:00:00Z"),
      title: `Telegram post ${opts.postId}`,
      url: `https://t.me/${opts.postId}`,
      externalId: opts.postId,
    })
    .returning({ id: events.id });
  return ev!.id;
}

describe("telegram feed + chart viz (Plan 09-06)", () => {
  it("a telegram_post WITH views → getEventMetricSeries returns a view_count series with that point", async () => {
    const user = await seedUserDirectly({ email: `tg-viz-views-${uniq()}@test.local` });
    const channel = `vizviews_${uniq()}`;
    const eventId = await seedTelegramEvent({
      userId: user.id,
      postId: `${channel}/12`,
      viewCount: 12300,
      mediaKind: "photo",
      thumbnailUrl: "https://cdn4.telesco.pe/file/abc.jpg",
    });

    const series = await getEventMetricSeries(user.id, eventId);
    // Telegram is views-only (D-04) → exactly one series.
    expect(series.map((s) => s.metricKey)).toEqual(["view_count"]);
    const views = series[0]!;
    expect(views.labelKey).toBe("chart_metric_views");
    expect(views.points).toHaveLength(1);
    expect(views.points[0]!.value).toBe(12300);
  });

  it("a null-views telegram_post is EXCLUDED from the chart but STILL appears in the feed (D-05)", async () => {
    const user = await seedUserDirectly({ email: `tg-viz-null-${uniq()}@test.local` });
    const channel = `viznull_${uniq()}`;
    const eventId = await seedTelegramEvent({
      userId: user.id,
      postId: `${channel}/7`,
      viewCount: null, // no snapshot row → null-only history
      mediaKind: null, // text-only post
    });

    // Chart: NO view_count series — a null-only history yields an empty array
    // (D-05: null is a GAP, never coerced to 0).
    const series = await getEventMetricSeries(user.id, eventId);
    expect(series).toEqual([]);

    // Feed: the event row still exists AND enrichFeedDtos attaches a
    // telegramEnrichment with stats=null (the card renders, but no views chip).
    const [row] = await db.select().from(events).where(eq(events.id, eventId));
    expect(row).toBeDefined();
    expect(row!.kind).toBe("telegram_post");

    const dto = {
      id: eventId,
      kind: "telegram_post",
      externalId: `${channel}/7`,
      title: row!.title,
    } as unknown as EventDto;
    await telegramEnrichFeedDtos(user.id, [dto]);
    const enriched = dto as EventDto & {
      telegramEnrichment?: {
        stats: { viewCount: number | null } | null;
        thumbnailUrl: string | null;
        mediaKind: string | null;
      };
    };
    // The post appears in the feed with enrichment present but stats=null (no
    // snapshot) → the card omits the views chip but still renders.
    expect(enriched.telegramEnrichment).toBeDefined();
    expect(enriched.telegramEnrichment!.stats).toBeNull();
    expect(enriched.telegramEnrichment!.mediaKind).toBeNull();
  });

  it("enrichFeedDtos attaches views + thumbnail for a media post so the card renders the chip", async () => {
    const user = await seedUserDirectly({ email: `tg-viz-enrich-${uniq()}@test.local` });
    const channel = `vizenrich_${uniq()}`;
    const eventId = await seedTelegramEvent({
      userId: user.id,
      postId: `${channel}/99`,
      viewCount: 4500,
      mediaKind: "video",
      thumbnailUrl: "https://cdn4.telesco.pe/file/xyz.jpg",
    });

    const dto = {
      id: eventId,
      kind: "telegram_post",
      externalId: `${channel}/99`,
      title: "Telegram media post",
    } as unknown as EventDto;
    await telegramEnrichFeedDtos(user.id, [dto]);
    const enriched = dto as EventDto & {
      telegramEnrichment?: {
        stats: { viewCount: number | null } | null;
        thumbnailUrl: string | null;
        mediaKind: string | null;
      };
    };
    expect(enriched.telegramEnrichment!.stats!.viewCount).toBe(4500);
    expect(enriched.telegramEnrichment!.thumbnailUrl).toBe("https://cdn4.telesco.pe/file/xyz.jpg");
    expect(enriched.telegramEnrichment!.mediaKind).toBe("video");
  });

  it("a telegram_post WITH views AND reactions → getEventMetricSeries returns BOTH series (E1)", async () => {
    const user = await seedUserDirectly({ email: `tg-viz-both-${uniq()}@test.local` });
    const channel = `vizboth_${uniq()}`;
    const eventId = await seedTelegramEvent({
      userId: user.id,
      postId: `${channel}/21`,
      viewCount: 50000,
      reactionsTotal: 1234,
      reactionsTop: [{ emoji: "🔥", kind: "standard", count: 1234 }],
    });

    const series = await getEventMetricSeries(user.id, eventId);
    // Multi-metric YouTube shape: view_count first, reaction_count second.
    expect(series.map((s) => s.metricKey)).toEqual(["view_count", "reaction_count"]);
    const reactions = series.find((s) => s.metricKey === "reaction_count")!;
    expect(reactions.labelKey).toBe("chart_metric_reactions");
    expect(reactions.points).toHaveLength(1);
    expect(reactions.points[0]!.value).toBe(1234);
  });

  it("a telegram_post with views but NO reactions → reaction_count series OMITTED (D-05 GAP)", async () => {
    const user = await seedUserDirectly({ email: `tg-viz-noreact-${uniq()}@test.local` });
    const channel = `viznoreact_${uniq()}`;
    const eventId = await seedTelegramEvent({
      userId: user.id,
      postId: `${channel}/22`,
      viewCount: 8000,
      reactionsTotal: null, // snapshot row has reactions_total NULL
    });

    const series = await getEventMetricSeries(user.id, eventId);
    // Only the views line — an all-null reactions metric is dropped, not a flat
    // dead legend toggle (D-05).
    expect(series.map((s) => s.metricKey)).toEqual(["view_count"]);
  });

  it("enrichFeedDtos exposes reactionsTotal (latest snapshot) + reactionsTop (current-state)", async () => {
    const user = await seedUserDirectly({ email: `tg-viz-react-enrich-${uniq()}@test.local` });
    const channel = `vizreactenrich_${uniq()}`;
    const top: TelegramReaction[] = [
      { emoji: null, kind: "paid", count: 8190 },
      { emoji: "🫡", kind: "standard", count: 8600 },
    ];
    const eventId = await seedTelegramEvent({
      userId: user.id,
      postId: `${channel}/30`,
      viewCount: 99000,
      reactionsTotal: 16790,
      reactionsTop: top,
    });

    const dto = {
      id: eventId,
      kind: "telegram_post",
      externalId: `${channel}/30`,
      title: "Telegram reactions post",
    } as unknown as EventDto;
    await telegramEnrichFeedDtos(user.id, [dto]);
    const enriched = dto as EventDto & {
      telegramEnrichment?: {
        stats: { viewCount: number | null; reactionsTotal: number | null } | null;
        reactionsTop: TelegramReaction[] | null;
      };
    };
    expect(enriched.telegramEnrichment!.stats!.reactionsTotal).toBe(16790);
    expect(enriched.telegramEnrichment!.reactionsTop).toEqual(top);
  });

  it("writeTelegramSnapshot persists reactions_total + reactions_top; COALESCE-preserves on a non-ok poll", async () => {
    const channel = `vizwrite_${uniq()}`;
    const postId = `${channel}/40`;
    const top: TelegramReaction[] = [{ emoji: "👍", kind: "standard", count: 500 }];

    // OK poll writes both the snapshot reactions_total + the current-state top-5.
    await writeTelegramSnapshot({
      postId,
      externalUrl: `https://t.me/${postId}`,
      viewCount: 1000,
      reactionsTotal: 500,
      reactionsTop: top,
      status: "ok",
    });

    const [snap] = await db
      .select()
      .from(telegramPostSnapshots)
      .where(eq(telegramPostSnapshots.postId, postId));
    expect(snap!.reactionsTotal).toBe(500);

    const [post1] = await db.select().from(telegramPosts).where(eq(telegramPosts.postId, postId));
    expect(post1!.reactionsTop).toEqual(top);

    // A non-ok poll carries no reactions → COALESCE PRESERVES the last good list
    // (a transient failure must not blank a working reactions row, same rule as
    // thumbnail_url).
    await writeTelegramSnapshot({
      postId,
      externalUrl: `https://t.me/${postId}`,
      viewCount: null,
      status: "rate_limited",
    });
    const [post2] = await db.select().from(telegramPosts).where(eq(telegramPosts.postId, postId));
    expect(post2!.reactionsTop).toEqual(top);
  });
});
