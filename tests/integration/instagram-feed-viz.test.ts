// VIZ-05 — the full Instagram feed/viz surface, proven end-to-end (flipped live
// by Plan 08-06) against the EXISTING cross-source feed + chart machinery.
//
// Path: register an instagram_account source → a backfill tick imports an
// instagram_post event into the /feed INBOX (source_id set, zero attached
// games) → attach it to a game → the /games/[id] metric-series loader
// (getEventMetricSeries iterating allAdapters → instagramFetchEventMetricSeries)
// returns the views/likes/comments series read from instagram_post_snapshots.
//
// Also covers the configured createSource path (SOC-01): a pasted IG handle URL
// resolves to the stable account_id (via canonicalizeOnCreate's provider seam)
// and lands on data_sources.channelId.
//
// Integration test — real Postgres via ./helpers.js; the provider seam is mocked
// at provider/registry's getSocialProvider (NEVER the DB).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage } from "../../src/lib/sources/social-provider.js";

interface ScriptedProvider {
  pages: { posts: ProviderPage[]; reels: ProviderPage[] };
}
const provider: ScriptedProvider = { pages: { posts: [], reels: [] } };

function emptyPage(): ProviderPage {
  return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1 };
}

vi.mock("../../src/lib/sources/instagram/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isInstagramConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "instagram") return null;
      return {
        name: "scrapecreators",
        async fetchPosts(
          _platform: string,
          _handle: string,
          _cursor: string | null,
          opts: { kindFilter?: "posts" | "reels" },
        ): Promise<ProviderPage> {
          const feed = opts.kindFilter ?? "posts";
          const next = provider.pages[feed].shift();
          return next ?? emptyPage();
        },
        async resolveAccount(_platform: string, handle: string) {
          return { accountId: `acct-${handle}`, displayName: handle };
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { eventGames } = await import("../../src/lib/server/db/schema/event-games.js");
const { createSource } = await import("../../src/lib/server/services/data-sources.js");
const { createGame } = await import("../../src/lib/server/services/games.js");
const { attachEventToGames } = await import("../../src/lib/server/services/events-mutation.js");
const { getEventMetricSeries } =
  await import("../../src/lib/server/services/event-metric-series.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/instagram/server/handlers/backfill-account.js");

const ACCOUNT = "acct-vizacct";

function post(id: string, daysAgo: number, kind: "image" | "video" = "video") {
  return {
    id,
    kind,
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
    metrics: {
      views: kind === "video" ? 5000 : null,
      likes: 321,
      comments: 17,
      shares: null,
    },
    caption: `viz caption ${id}`,
    thumbnailUrl: `https://cdn/${id}.jpg`,
    permalink: `https://www.instagram.com/p/${id}/`,
  };
}

async function seedSource(userId: string, autoImport = true): Promise<string> {
  const [row] = await db
    .insert(dataSources)
    .values({
      userId,
      kind: "instagram_account",
      handleUrl: "https://www.instagram.com/vizacct/",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport,
      metadata: { handle: "vizacct", accountId: ACCOUNT },
    })
    .returning({ id: dataSources.id });
  return row!.id;
}

beforeEach(() => {
  provider.pages = { posts: [], reels: [] };
});

describe("instagram feed inbox + metric series (VIZ-05)", () => {
  it("createSource resolves the handle → account_id onto data_sources.channelId (SOC-01)", async () => {
    const user = await seedUserDirectly({
      email: `viz-create-${Math.random().toString(36).slice(2)}@t.io`,
    });
    // autoImport:false → skip the onSourceCreated backfill enqueue (no pg-boss).
    const source = await createSource(
      user.id,
      {
        kind: "instagram_account",
        handleUrl: "https://www.instagram.com/natgeo/",
        isOwnedByMe: true,
        autoImport: false,
        metadata: { handle: "natgeo" },
      },
      "127.0.0.1",
    );
    expect(source.kind).toBe("instagram_account");
    // canonicalizeOnCreate resolved the handle → "acct-natgeo" (the mocked
    // resolveAccount), stored on channelId (the walker's channelKey).
    expect(source.channelId).toBe("acct-natgeo");
    expect((source.metadata as { handle?: string }).handle).toBe("natgeo");
  });

  it("a backfill tick imports an instagram_post event into the /feed inbox (source_id set, zero attached games)", async () => {
    const user = await seedUserDirectly({
      email: `viz-inbox-${Math.random().toString(36).slice(2)}@t.io`,
    });
    const sourceId = await seedSource(user.id, true);

    provider.pages.posts = [
      { posts: [post("viz1", 1)], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];
    provider.pages.reels = [emptyPage()];

    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        triggerUserId: user.id,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    // The imported post is an inbox event: source_id set, no event_games rows.
    const [ev] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, user.id), eq(events.externalId, "viz1")))
      .limit(1);
    expect(ev).toBeDefined();
    expect(ev!.kind).toBe("instagram_post");
    expect(ev!.sourceId).toBe(sourceId);

    const junction = await db.select().from(eventGames).where(eq(eventGames.eventId, ev!.id));
    expect(junction).toHaveLength(0); // inbox criterion: zero attached games
  });

  it("attach the imported post to a game, then the metric series renders via getEventMetricSeries", async () => {
    const user = await seedUserDirectly({
      email: `viz-series-${Math.random().toString(36).slice(2)}@t.io`,
    });
    await seedSource(user.id, true);

    provider.pages.posts = [
      { posts: [post("viz2", 2, "video")], nextCursor: null, endOfFeed: true, creditsUsed: 1 },
    ];
    provider.pages.reels = [emptyPage()];

    await handleBackfillAccount({
      data: {
        kind: "instagram_account",
        channelKey: ACCOUNT,
        triggerUserId: user.id,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const [ev] = await db
      .select()
      .from(events)
      .where(
        and(eq(events.userId, user.id), eq(events.externalId, "viz2"), isNull(events.deletedAt)),
      )
      .limit(1);
    expect(ev).toBeDefined();

    // Attach to a game (the inbox → attached transition).
    const game = await createGame(user.id, { title: "My IG-promoted game" }, "127.0.0.1");
    await attachEventToGames(user.id, ev!.id, [game.id], "127.0.0.1");
    const junction = await db.select().from(eventGames).where(eq(eventGames.eventId, ev!.id));
    expect(junction).toHaveLength(1);
    expect(junction[0]!.gameId).toBe(game.id);

    // The /games/[id] chart path: getEventMetricSeries gates on getEventById
    // (tenant 404) then iterates allAdapters → instagramFetchEventMetricSeries
    // reads the snapshot the backfill wrote (status:"ok"). The video post has
    // views + likes + comments → three series.
    const series = await getEventMetricSeries(user.id, ev!.id);
    const keys = series.map((s) => s.metricKey).sort();
    expect(keys).toEqual(["comment_count", "like_count", "view_count"]);
    const likes = series.find((s) => s.metricKey === "like_count");
    expect(likes!.points.at(-1)!.value).toBe(321);
    const views = series.find((s) => s.metricKey === "view_count");
    expect(views!.points.at(-1)!.value).toBe(5000);
    const comments = series.find((s) => s.metricKey === "comment_count");
    expect(comments!.points.at(-1)!.value).toBe(17);
  });
});
