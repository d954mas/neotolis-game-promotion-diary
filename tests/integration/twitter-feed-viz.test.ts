// Twitter/X feed visualization (VIZ-05 + PLAT-03) — the full Twitter feed/viz
// surface proven end-to-end (flipped live by Plan 11-04) against the EXISTING
// cross-source feed + chart machinery.
//
// Path: register a twitter_account source → a backfill tick imports a twitter_post
// event into the /feed INBOX (source_id set, zero attached games) AND writes a
// twitter_post_snapshots row carrying the DERIVED share_count (retweet+quote, D-05)
// → the /feed enrichment surfaces views/likes/comments/SHARES → attach the event to
// a game → the /games/[id] metric-series loader (getEventMetricSeries iterating
// allAdapters → twitterFetchEventMetricSeries) returns FOUR series, including the
// share_count series (the PLAT-03 time-series criterion).
//
// PLUS the D-04 filter (the central Twitter delta): a retweet + a foreign reply are
// dropped, a self-reply (the account replying to its own thread) is kept — promo
// threads import whole.
//
// Integration test — real Postgres via ./helpers.js; the walker's tree-local rich
// fetch (fetchTwitterFeedPageWithRaw) + getSocialProvider are mocked at the twitter
// tree's provider/registry (NEVER the DB).
//
// Requirements: VIZ-05 / PLAT-03.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage, NormalizedPost } from "../../src/lib/sources/social-provider.js";
import type { Tweet, TwitterFeedPage } from "../../src/lib/sources/twitter/server/normalize.js";

// The account whose feed we walk — channelId on the seeded source == this id, and
// every feed item's author.id == this id (the feed owner), so keepForAccount filters
// by it.
const ACCOUNT = "44196397";
const HANDLE = "ConcernedApe";

interface ScriptedFeed {
  pages: TwitterFeedPage[];
}
const feed: ScriptedFeed = { pages: [] };

function emptyFeedPage(): TwitterFeedPage {
  return {
    page: { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1, owner: null },
    rawTweets: [],
  };
}

vi.mock("../../src/lib/sources/twitter/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isTwitterConfigured: () => true,
    // The handler probes getSocialProvider("twitter") !== null before walking; the
    // actual page fetch goes through fetchTwitterFeedPageWithRaw below.
    getSocialProvider: (platform: string) => {
      if (platform !== "twitter") return null;
      return {
        name: "twitterapi.io",
        async fetchPosts(): Promise<ProviderPage> {
          return { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1 };
        },
        async resolveAccount() {
          return null;
        },
        async fetchPostByUrl() {
          return null;
        },
      };
    },
    // The walker's tree-local rich fetch — returns ProviderPage + index-aligned raw
    // tweets so the D-04 keepForAccount filter + the D-05 raw components apply.
    async fetchTwitterFeedPageWithRaw(): Promise<TwitterFeedPage> {
      return feed.pages.shift() ?? emptyFeedPage();
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
  await import("../../src/lib/sources/twitter/server/handlers/backfill-account.js");
const { mapEventsToDtos } = await import("../../src/lib/server/dto.js");
const { twitterEnrichFeedDtos } =
  await import("../../src/lib/sources/twitter/server/feed-enrichment.js");

// A normalized post (what the cross-source pipeline + snapshot writer see). A media
// tweet carries views + the DERIVED shares; a text-only tweet nulls views/thumbnail.
function post(id: string, daysAgo: number, media: boolean, shares: number | null): NormalizedPost {
  return {
    id,
    kind: media ? "video" : "text",
    publishedAt: new Date(Date.now() - daysAgo * 86_400_000),
    metrics: {
      views: media ? 1_200_000 : null,
      likes: 48_000,
      comments: 312,
      // The DERIVED retweet+quote sum (D-05).
      shares,
    },
    caption: `viz tweet ${id}`,
    thumbnailUrl: media ? `https://pbs.twimg.com/media/${id}.jpg` : null,
    permalink: `https://x.com/${HANDLE}/status/${id}`,
  };
}

// A raw Tweet carrying the D-04 type flags + the D-05 raw components. authorId is the
// feed owner (== ACCOUNT) so keepForAccount filters self-replies vs foreign replies.
function rawTweet(
  id: string,
  opts: {
    retweet?: boolean;
    isReply?: boolean;
    inReplyToUserId?: string | null;
    retweetCount?: number | null;
    quoteCount?: number | null;
  } = {},
): Tweet {
  return {
    id,
    url: `https://x.com/${HANDLE}/status/${id}`,
    text: `viz tweet ${id}`,
    createdAt: new Date().toISOString(),
    likeCount: 48_000,
    retweetCount: opts.retweetCount ?? null,
    replyCount: 312,
    quoteCount: opts.quoteCount ?? null,
    viewCount: 1_200_000,
    bookmarkCount: 7,
    isReply: opts.isReply ?? false,
    inReplyToId: null,
    inReplyToUserId: opts.inReplyToUserId ?? null,
    inReplyToUsername: null,
    retweeted_tweet: opts.retweet === true ? { id: "rt-src" } : null,
    quoted_tweet: null,
    extendedEntities: null,
    author: { id: ACCOUNT, userName: HANDLE, name: "Stardew Valley" },
  };
}

function feedPage(posts: NormalizedPost[], raws: Tweet[]): TwitterFeedPage {
  return {
    page: {
      posts,
      nextCursor: null,
      endOfFeed: true,
      creditsUsed: 1,
      owner: { accountId: ACCOUNT, username: HANDLE, avatarUrl: null },
    },
    rawTweets: raws,
  };
}

async function seedSource(userId: string, autoImport = true): Promise<string> {
  const [row] = await db
    .insert(dataSources)
    .values({
      userId,
      kind: "twitter_account",
      handleUrl: `https://x.com/${HANDLE}`,
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport,
      metadata: { handle: HANDLE, accountId: ACCOUNT },
    })
    .returning({ id: dataSources.id });
  return row!.id;
}

async function runBackfill(userId: string): Promise<void> {
  await handleBackfillAccount({
    data: {
      kind: "twitter_account",
      channelKey: ACCOUNT,
      triggerUserId: userId,
      depthBoundIso: "1970-01-01T00:00:00Z",
      flow: "initial",
    },
  });
}

beforeEach(() => {
  feed.pages = [];
});

describe("twitter feed inbox + metric series (VIZ-05 + PLAT-03)", () => {
  it("[11-04] a backfill tick imports a twitter_post into the /feed inbox and enriches it with views/likes/comments/SHARES", async () => {
    const user = await seedUserDirectly({
      email: `tw-viz-inbox-${Math.random().toString(36).slice(2)}@t.io`,
    });
    const sourceId = await seedSource(user.id, true);

    // shares = retweetCount(4000) + quoteCount(974) = 4974 (the DERIVED sum).
    feed.pages = [
      feedPage(
        [post("viz1", 1, true, 4974)],
        [rawTweet("viz1", { retweetCount: 4000, quoteCount: 974 })],
      ),
    ];

    await runBackfill(user.id);

    // The imported tweet is an inbox event: source_id set, no event_games rows.
    const [ev] = await db
      .select()
      .from(events)
      .where(and(eq(events.userId, user.id), eq(events.externalId, "viz1")))
      .limit(1);
    expect(ev).toBeDefined();
    expect(ev!.kind).toBe("twitter_post");
    expect(ev!.sourceId).toBe(sourceId);
    const junction = await db.select().from(eventGames).where(eq(eventGames.eventId, ev!.id));
    expect(junction).toHaveLength(0); // inbox criterion

    // The /feed enrichment surfaces the snapshot the walker wrote, INCLUDING the
    // DERIVED shareCount (the PLAT-03 metric).
    const [dto] = await mapEventsToDtos(user.id, [ev!]);
    await twitterEnrichFeedDtos(user.id, [dto!]);
    const enrichment = (
      dto as { twitterEnrichment?: { stats: Record<string, number | null> | null } }
    ).twitterEnrichment;
    expect(enrichment?.stats).not.toBeNull();
    expect(enrichment!.stats!.viewCount).toBe(1_200_000);
    expect(enrichment!.stats!.likeCount).toBe(48_000);
    expect(enrichment!.stats!.commentCount).toBe(312);
    // The load-bearing PLAT-03 assertion on the feed surface.
    expect(enrichment!.stats!.shareCount).toBe(4974);
  });

  it("[11-04] attach the imported tweet to a game → the metric series renders a SHARES series on /games/[id] (PLAT-03 time-series)", async () => {
    const user = await seedUserDirectly({
      email: `tw-viz-series-${Math.random().toString(36).slice(2)}@t.io`,
    });
    await seedSource(user.id, true);

    feed.pages = [
      feedPage(
        [post("viz2", 2, true, 4974)],
        [rawTweet("viz2", { retweetCount: 4000, quoteCount: 974 })],
      ),
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
    const game = await createGame(user.id, { title: "My Twitter-promoted game" }, "127.0.0.1");
    await attachEventToGames(user.id, ev!.id, [game.id], "127.0.0.1");
    const junction = await db.select().from(eventGames).where(eq(eventGames.eventId, ev!.id));
    expect(junction).toHaveLength(1);
    expect(junction[0]!.gameId).toBe(game.id);

    // The /games/[id] chart path: getEventMetricSeries gates on getEventById
    // (tenant 404) then iterates allAdapters → twitterFetchEventMetricSeries reads
    // the snapshot the backfill wrote. The media tweet has views + likes + comments
    // + SHARES → FOUR series (the PLAT-03 delta — incl the DERIVED shares line).
    const series = await getEventMetricSeries(user.id, ev!.id);
    const keys = series.map((s) => s.metricKey).sort();
    expect(keys).toEqual(["comment_count", "like_count", "share_count", "view_count"]);
    const shares = series.find((s) => s.metricKey === "share_count");
    expect(shares, "the share_count series is the PLAT-03 criterion").toBeDefined();
    expect(shares!.labelKey).toBe("chart_metric_shares");
    expect(shares!.points.at(-1)!.value).toBe(4974);
    const views = series.find((s) => s.metricKey === "view_count");
    expect(views!.points.at(-1)!.value).toBe(1_200_000);
  });

  it("[11-04] a text-only tweet with null views drops the all-null views series but keeps likes + comments", async () => {
    const user = await seedUserDirectly({
      email: `tw-viz-text-${Math.random().toString(36).slice(2)}@t.io`,
    });
    await seedSource(user.id, true);

    // A text-only tweet: views null, no thumbnail; shares null (no redistribution).
    feed.pages = [feedPage([post("viz3", 1, false, null)], [rawTweet("viz3")])];
    await runBackfill(user.id);

    const [ev] = await db
      .select()
      .from(events)
      .where(
        and(eq(events.userId, user.id), eq(events.externalId, "viz3"), isNull(events.deletedAt)),
      )
      .limit(1);
    expect(ev).toBeDefined();

    const game = await createGame(user.id, { title: "Text-tweet game" }, "127.0.0.1");
    await attachEventToGames(user.id, ev!.id, [game.id], "127.0.0.1");

    // metrics-by-presence: the all-null views + shares series are dropped; likes +
    // comments remain.
    const series = await getEventMetricSeries(user.id, ev!.id);
    const keys = series.map((s) => s.metricKey).sort();
    expect(keys).toEqual(["comment_count", "like_count"]);
  });

  it("[11-04] D-04 filter: a retweet + a foreign reply are dropped; a self-reply is kept (promo threads import whole)", async () => {
    const user = await seedUserDirectly({
      email: `tw-viz-d04-${Math.random().toString(36).slice(2)}@t.io`,
    });
    await seedSource(user.id, true);

    // One page: an original (kept), a retweet (dropped), a foreign reply (dropped),
    // a self-reply (kept — inReplyToUserId === ACCOUNT).
    feed.pages = [
      feedPage(
        [
          post("orig", 1, true, 100),
          post("rt", 1, true, 0),
          post("foreign-reply", 1, false, null),
          post("self-reply", 1, false, null),
        ],
        [
          rawTweet("orig", { retweetCount: 100, quoteCount: 0 }),
          rawTweet("rt", { retweet: true }),
          rawTweet("foreign-reply", { isReply: true, inReplyToUserId: "99999999" }),
          rawTweet("self-reply", { isReply: true, inReplyToUserId: ACCOUNT }),
        ],
      ),
    ];
    await runBackfill(user.id);

    const rows = await db
      .select({ externalId: events.externalId })
      .from(events)
      .where(and(eq(events.userId, user.id), eq(events.kind, "twitter_post")));
    const ids = new Set(rows.map((r) => r.externalId));
    // Kept: original + self-reply (the promo thread).
    expect(ids.has("orig")).toBe(true);
    expect(ids.has("self-reply")).toBe(true);
    // Dropped: the retweet (someone else's content) + the reply to another account.
    expect(ids.has("rt")).toBe(false);
    expect(ids.has("foreign-reply")).toBe(false);
  });
});
