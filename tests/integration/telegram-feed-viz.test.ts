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
// Telegram has NO event auto-creation in Phase 9 (the listing/backfill handlers
// write telegram_posts / telegram_post_snapshots — a public-data snapshot
// cache — NOT events; events come from manual paste / feed surfacing). So these
// tests seed an `events` row + the snapshot cache directly, then exercise the
// read-path machinery the /games/[id] chart + /feed surface use.

import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/lib/server/db/client.js";
import { events } from "../../src/lib/server/db/schema/events.js";
import { telegramPosts, telegramPostSnapshots } from "../../src/lib/server/db/schema/index.js";
import { getEventMetricSeries } from "../../src/lib/server/services/event-metric-series.js";
import { telegramEnrichFeedDtos } from "../../src/lib/sources/telegram/server/feed-enrichment.js";
import type { EventDto } from "../../src/lib/server/dto.js";
import { seedUserDirectly } from "./helpers.js";

const uniq = (): string => Math.random().toString(36).slice(2, 10);

interface SeedPostOpts {
  userId: string;
  postId: string;
  /** null → seed NO snapshot row (the "very new / views hidden" case). */
  viewCount: number | null;
  mediaKind?: string | null;
  thumbnailUrl?: string | null;
}

/** Seed an events row (kind=telegram_post, externalId=postId) + the telegram_posts
 *  cache row, and — only when viewCount is non-null — one telegram_post_snapshots
 *  row. Returns the event id. */
async function seedTelegramEvent(opts: SeedPostOpts): Promise<string> {
  await db.insert(telegramPosts).values({
    postId: opts.postId,
    channelKey: "1006503122",
    textSnippet: "promo snippet",
    mediaKind: opts.mediaKind ?? null,
    thumbnailUrl: opts.thumbnailUrl ?? null,
    externalUrl: `https://t.me/${opts.postId}`,
    publishedAt: new Date("2026-06-01T00:00:00Z"),
    lastPolledAt: new Date(),
    lastPollStatus: "ok",
  });

  if (opts.viewCount !== null) {
    await db.insert(telegramPostSnapshots).values({
      postId: opts.postId,
      polledAt: new Date("2026-06-02T12:00:00Z"),
      viewCount: opts.viewCount,
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
});
