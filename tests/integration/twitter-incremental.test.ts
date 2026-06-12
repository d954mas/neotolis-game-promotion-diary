// Twitter/X incremental (new-only) backfill — after backfill_complete, subsequent
// ticks fetch new tweets only off the resumable frontier (BACK-03). REAL
// handleBackfillAccount against real Postgres; provider seam mocked.
//
// Requirements: PLAT-03 / BACK-03.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { TwitterFeedPage, Tweet } from "../../src/lib/sources/twitter/server/normalize.js";

const provider = { pages: [] as TwitterFeedPage[], calls: [] as Array<{ cursor: string | null }> };

function emptyPage(): TwitterFeedPage {
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
    getSocialProvider: (platform: string) =>
      platform === "twitter" ? ({ name: "twitterapi.io" } as never) : null,
    fetchTwitterFeedPageWithRaw: async (_h: string, cursor: string | null): Promise<TwitterFeedPage> => {
      provider.calls.push({ cursor });
      return provider.pages.shift() ?? emptyPage();
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { normalizeTweet } = await import("../../src/lib/sources/twitter/server/normalize.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/twitter/server/handlers/backfill-account.js");

const ACCOUNT = "acct-incr-tw";

function tweet(id: string, daysAgo: number): Tweet {
  return {
    id,
    url: `https://x.com/i/status/${id}`,
    text: id,
    createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    likeCount: 1,
    retweetCount: 1,
    replyCount: 1,
    quoteCount: 0,
    viewCount: 1,
    bookmarkCount: 0,
    isReply: false,
    inReplyToId: null,
    inReplyToUserId: null,
    inReplyToUsername: null,
    retweeted_tweet: null,
    quoted_tweet: null,
    extendedEntities: {},
    author: { id: ACCOUNT, userName: "incracct", name: "Incr", profilePicture: null, followers: 1 },
  };
}

function page(tweets: Tweet[], nextCursor: string | null, endOfFeed: boolean): TwitterFeedPage {
  return {
    page: { posts: tweets.map(normalizeTweet), nextCursor, endOfFeed, creditsUsed: 1, owner: null },
    rawTweets: tweets,
  };
}

async function seedSource(): Promise<void> {
  const user = await seedUserDirectly({ email: `incr-tw-${Math.random().toString(36).slice(2)}@t.io` });
  await db.insert(dataSources).values({
    userId: user.id,
    kind: "twitter_account",
    handleUrl: "https://x.com/incracct",
    channelId: ACCOUNT,
    isOwnedByMe: true,
    autoImport: true,
    metadata: { handle: "incracct", accountId: ACCOUNT },
  });
}

beforeEach(() => {
  provider.pages = [];
  provider.calls = [];
});

describe("twitter incremental backfill (BACK-03)", () => {
  it("[11-03] after backfill_complete, a tick fetches only tweets newer than the frontier", async () => {
    await seedSource();
    // 1. Initial deep walk completes with i1, i2.
    provider.pages = [page([tweet("i1", 3), tweet("i2", 5)], null, true)];
    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    let inserted = await db.select().from(events).where(eq(events.kind, "twitter_post"));
    expect(inserted.map((e) => e.externalId).sort()).toEqual(["i1", "i2"]);

    // 2. An incremental sweep (auto_passive) re-fetches page 1, discovering one NEW
    //    tweet (i0, newer) plus the already-seen i1. The dedup pre-check skips i1.
    provider.calls = [];
    provider.pages = [page([tweet("i0", 1), tweet("i1", 3)], null, true)];
    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: new Date(Date.now() - 14 * 86_400_000).toISOString(), flow: "auto_passive" },
    });

    // The incremental branch reset to page 1 (cursor null), NOT the historical cursor.
    expect(provider.calls[0]?.cursor).toBe(null);
    inserted = await db.select().from(events).where(eq(events.kind, "twitter_post"));
    expect(inserted.map((e) => e.externalId).sort()).toEqual(["i0", "i1", "i2"]);
  });

  it("[11-03] no new tweets -> no new events", async () => {
    await seedSource();
    provider.pages = [page([tweet("n1", 2)], null, true)];
    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    // Second sweep returns the SAME single tweet → dedup → no new events.
    provider.pages = [page([tweet("n1", 2)], null, true)];
    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: new Date(Date.now() - 14 * 86_400_000).toISOString(), flow: "auto_passive" },
    });

    const inserted = await db.select().from(events).where(eq(events.kind, "twitter_post"));
    expect(inserted.map((e) => e.externalId)).toEqual(["n1"]);
  });
});
