// TikTok feed visualization (VIZ-05 + PLAT-02) — the full TikTok feed/viz
// surface proven end-to-end (flipped live by Plan 10-05) against the EXISTING
// cross-source feed + chart machinery.
//
// Path: register a tiktok_account source → a backfill tick imports a tiktok_post
// event into the /feed INBOX (source_id set, zero attached games) AND writes a
// tiktok_post_snapshots row carrying share_count (the PLAT-02 metric IG never
// had) → the /feed enrichment surfaces views/likes/comments/SHARES → attach the
// event to a game → the /games/[id] metric-series loader (getEventMetricSeries
// iterating allAdapters → tiktokFetchEventMetricSeries) returns FOUR series,
// including the share_count series (the PLAT-02 time-series criterion).
//
// Integration test — real Postgres via ./helpers.js; the provider seam is mocked
// at the tiktok tree's provider/registry getSocialProvider (NEVER the DB).
//
// Requirements: PLAT-02.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage, NormalizedPost } from "../../src/lib/sources/social-provider.js";

interface ScriptedProvider {
  pages: ProviderPage[];
}
const provider: ScriptedProvider = { pages: [] };

function emptyPage(): ProviderPage {
  return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1 };
}

vi.mock("../../src/lib/sources/tiktok/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isTikTokConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "tiktok") return null;
      return {
        name: "scrapecreators",
        async fetchPosts(): Promise<ProviderPage> {
          return provider.pages.shift() ?? emptyPage();
        },
        async resolveAccount(_platform: string, handle: string) {
          return {
            accountId: `tk-${handle}`,
            displayName: handle,
            username: handle,
            fullName: handle,
            avatarUrl: null,
            followerCount: null,
          };
        },
        async fetchPostByUrl() {
          return null;
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { eventGames } = await import("../../src/lib/server/db/schema/event-games.js");
const { createGame } = await import("../../src/lib/server/services/games.js");
const { attachEventToGames } = await import("../../src/lib/server/services/events-mutation.js");
const { getEventMetricSeries } =
  await import("../../src/lib/server/services/event-metric-series.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/tiktok/server/handlers/backfill-account.js");
const { mapEventsToDtos } = await import("../../src/lib/server/dto.js");
const { tiktokEnrichFeedDtos } =
  await import("../../src/lib/sources/tiktok/server/feed-enrichment.js");

const ACCOUNT = "tk-vizacct";

function post(id: string, daysAgo: number, kind: "video" | "carousel" = "video"): NormalizedPost {
  return {
    id,
    kind,
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
    metrics: {
      // A video carries all four metrics including SHARES (the PLAT-02 delta); a
      // photo-mode (carousel) post nulls views per metrics-by-presence.
      views: kind === "video" ? 1_200_000 : null,
      likes: 48_000,
      comments: 312,
      shares: kind === "video" ? 4974 : null,
    },
    caption: `viz caption ${id}`,
    thumbnailUrl: `https://p16.tiktokcdn-us.com/${id}.awebp`,
    permalink: `https://www.tiktok.com/@vizacct/video/${id}`,
  };
}

async function seedSource(userId: string, autoImport = true): Promise<string> {
  const [row] = await db
    .insert(dataSources)
    .values({
      userId,
      kind: "tiktok_account",
      handleUrl: "https://www.tiktok.com/@vizacct",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport,
      metadata: { handle: "vizacct", accountId: ACCOUNT },
    })
    .returning({ id: dataSources.id });
  return row!.id;
}

async function runBackfill(userId: string): Promise<void> {
  await handleBackfillAccount({
    data: {
      kind: "tiktok_account",
      channelKey: ACCOUNT,
      triggerUserId: userId,
      depthBoundIso: "1970-01-01T00:00:00Z",
      flow: "initial",
    },
  });
}

beforeEach(() => {
  provider.pages = [];
});

describe("tiktok feed inbox + metric series (VIZ-05 + PLAT-02)", () => {
  it("[10-05] a backfill tick imports a tiktok_post into the /feed inbox and enriches it with views/likes/comments/SHARES", async () => {
    const user = await seedUserDirectly({
      email: `tk-viz-inbox-${Math.random().toString(36).slice(2)}@t.io`,
    });
    const sourceId = await seedSource(user.id, true);

    provider.pages = [
      { posts: [post("viz1", 1)], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];

    await runBackfill(user.id);

    // The imported post is an inbox event: source_id set, no event_games rows.
    const [ev] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, user.id), eq(events.externalId, "viz1")))
      .limit(1);
    expect(ev).toBeDefined();
    expect(ev!.kind).toBe("tiktok_post");
    expect(ev!.sourceId).toBe(sourceId);
    const junction = await db.select().from(eventGames).where(eq(eventGames.eventId, ev!.id));
    expect(junction).toHaveLength(0); // inbox criterion

    // The /feed enrichment surfaces the snapshot the walker wrote, INCLUDING the
    // PLAT-02 shareCount (the metric IG never carried).
    const [dto] = await mapEventsToDtos(user.id, [ev!]);
    await tiktokEnrichFeedDtos(user.id, [dto!]);
    const enrichment = (
      dto as { tiktokEnrichment?: { stats: Record<string, number | null> | null } }
    ).tiktokEnrichment;
    expect(enrichment?.stats).not.toBeNull();
    expect(enrichment!.stats!.viewCount).toBe(1_200_000);
    expect(enrichment!.stats!.likeCount).toBe(48_000);
    expect(enrichment!.stats!.commentCount).toBe(312);
    // The load-bearing PLAT-02 assertion on the feed surface.
    expect(enrichment!.stats!.shareCount).toBe(4974);
  });

  it("[10-05] attach the imported post to a game → the metric series renders a SHARES series on /games/[id] (PLAT-02 time-series)", async () => {
    const user = await seedUserDirectly({
      email: `tk-viz-series-${Math.random().toString(36).slice(2)}@t.io`,
    });
    await seedSource(user.id, true);

    provider.pages = [
      { posts: [post("viz2", 2, "video")], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];
    await runBackfill(user.id);

    const [ev] = await db
      .select()
      .from(events)
      .where(
        and(eq(events.userId, user.id), eq(events.externalId, "viz2"), isNull(events.deletedAt)),
      )
      .limit(1);
    expect(ev).toBeDefined();

    // Attach to a game (the inbox → attached transition).
    const game = await createGame(user.id, { title: "My TikTok-promoted game" }, "127.0.0.1");
    await attachEventToGames(user.id, ev!.id, [game.id], "127.0.0.1");
    const junction = await db.select().from(eventGames).where(eq(eventGames.eventId, ev!.id));
    expect(junction).toHaveLength(1);
    expect(junction[0]!.gameId).toBe(game.id);

    // The /games/[id] chart path: getEventMetricSeries gates on getEventById
    // (tenant 404) then iterates allAdapters → tiktokFetchEventMetricSeries reads
    // the snapshot the backfill wrote. The video post has views + likes +
    // comments + SHARES → FOUR series (the PLAT-02 delta vs IG's three).
    const series = await getEventMetricSeries(user.id, ev!.id);
    const keys = series.map((s) => s.metricKey).sort();
    expect(keys).toEqual(["comment_count", "like_count", "share_count", "view_count"]);
    const shares = series.find((s) => s.metricKey === "share_count");
    expect(shares, "the share_count series is the PLAT-02 criterion").toBeDefined();
    expect(shares!.labelKey).toBe("chart_metric_shares");
    expect(shares!.points.at(-1)!.value).toBe(4974);
    const views = series.find((s) => s.metricKey === "view_count");
    expect(views!.points.at(-1)!.value).toBe(1_200_000);
  });

  it("[10-05] a photo-mode (carousel) post drops the all-null views series but keeps the others", async () => {
    const user = await seedUserDirectly({
      email: `tk-viz-photo-${Math.random().toString(36).slice(2)}@t.io`,
    });
    await seedSource(user.id, true);

    provider.pages = [
      { posts: [post("viz3", 1, "carousel")], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];
    await runBackfill(user.id);

    const [ev] = await db
      .select()
      .from(events)
      .where(
        and(eq(events.userId, user.id), eq(events.externalId, "viz3"), isNull(events.deletedAt)),
      )
      .limit(1);
    expect(ev).toBeDefined();

    const game = await createGame(user.id, { title: "Photo-mode game" }, "127.0.0.1");
    await attachEventToGames(user.id, ev!.id, [game.id], "127.0.0.1");

    // A photo-mode post nulls views + shares (metrics-by-presence): the all-null
    // series are dropped; likes + comments remain.
    const series = await getEventMetricSeries(user.id, ev!.id);
    const keys = series.map((s) => s.metricKey).sort();
    expect(keys).toEqual(["comment_count", "like_count"]);
  });
});
