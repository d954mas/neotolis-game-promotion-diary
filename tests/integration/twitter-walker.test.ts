// Twitter/X account walker — resumable, cursor-persisted, SINGLE-FEED (mirrors the
// TikTok walker). Drives the REAL handleBackfillAccount against real Postgres; the
// twitterapi.io boundary is faked at the PROVIDER SEAM (vi.mock of provider/registry's
// getSocialProvider + fetchTwitterFeedPageWithRaw → a controllable fake), NEVER the DB.
//
// The Twitter delta vs TikTok: the walker applies the D-04 keepForAccount filter
// (drop retweets + foreign replies, keep originals/quotes/self-replies) and stores
// the D-05 raw retweet/quote/bookmark components on each snapshot.
//
// Requirements: PLAT-03 / BACK-01..03 / D-04 / D-05.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { TwitterFeedPage, Tweet } from "../../src/lib/sources/twitter/server/normalize.js";

// Single-feed scripted pages. Each fetch shifts the next page off the queue. The
// fake bypasses the HTTP seam (reserves NO credits).
interface ScriptedProvider {
  pages: TwitterFeedPage[];
  calls: Array<{ cursor: string | null }>;
  /** When set, the next fetch throws an AdapterError of this category. */
  throwOn: "rate-limited" | "operator-issue" | null;
}

const provider: ScriptedProvider = { pages: [], calls: [], throwOn: null };

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
    getSocialProvider: (platform: string) => {
      if (platform !== "twitter") return null;
      return { name: "twitterapi.io" };
    },
    fetchTwitterFeedPageWithRaw: async (
      _handle: string,
      cursor: string | null,
    ): Promise<TwitterFeedPage> => {
      provider.calls.push({ cursor });
      if (provider.throwOn !== null) {
        const { AdapterError: Err } = await import("../../src/lib/sources/errors.js");
        throw new Err("scripted budget pause", { category: provider.throwOn });
      }
      return provider.pages.shift() ?? emptyPage();
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { outbox } = await import("../../src/lib/server/db/schema/outbox.js");
const { dataSourceChannelState } =
  await import("../../src/lib/server/db/schema/data-source-channel-state.js");
const { twitterPosts, twitterAccounts, twitterPostSnapshots } =
  await import("../../src/lib/server/db/schema/index.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/twitter/server/handlers/backfill-account.js");
const { getTwitterBackfillState } =
  await import("../../src/lib/sources/twitter/server/backfill-state.js");

const ACCOUNT = "acct-walker-tw";

async function readContinuationOutbox() {
  const rows = await db.select().from(outbox).where(eq(outbox.queue, "twitter.backfill.account"));
  return rows.filter((r) => (r.payload as { channelKey?: string }).channelKey === ACCOUNT);
}

// Build a raw Tweet + its aligned NormalizedPost. flags drive the D-04 filter.
function tweet(
  id: string,
  daysAgo: number,
  opts: {
    retweetCount?: number | null;
    quoteCount?: number | null;
    bookmarkCount?: number | null;
    retweeted_tweet?: object | null;
    isReply?: boolean;
    inReplyToUserId?: string | null;
  } = {},
): Tweet {
  const created = new Date(Date.now() - daysAgo * 86_400_000);
  return {
    id,
    url: `https://x.com/walkeracct/status/${id}`,
    text: `tweet ${id}`,
    createdAt: created.toISOString(),
    likeCount: 10,
    retweetCount: opts.retweetCount ?? 40,
    replyCount: 2,
    quoteCount: opts.quoteCount ?? 2,
    viewCount: 1000,
    bookmarkCount: opts.bookmarkCount ?? 7,
    isReply: opts.isReply ?? false,
    inReplyToId: null,
    inReplyToUserId: opts.inReplyToUserId ?? null,
    inReplyToUsername: null,
    retweeted_tweet: opts.retweeted_tweet ?? null,
    quoted_tweet: null,
    extendedEntities: {},
    author: { id: ACCOUNT, userName: "walkeracct", name: "Walker", profilePicture: null, followers: 1 },
  };
}

async function pageFrom(
  tweets: Tweet[],
  nextCursor: string | null,
  endOfFeed: boolean,
): Promise<TwitterFeedPage> {
  const { normalizeTweet } = await import("../../src/lib/sources/twitter/server/normalize.js");
  return {
    page: {
      posts: tweets.map((t) => normalizeTweet(t)),
      nextCursor,
      endOfFeed,
      creditsUsed: 1,
      owner: { accountId: ACCOUNT, username: "walkeracct", avatarUrl: "https://pbs.twimg.com/a.jpg" },
    },
    rawTweets: tweets,
  };
}

async function seedSource(opts: { autoImport?: boolean } = {}): Promise<string> {
  const user = await seedUserDirectly({
    email: `walker-tw-${Math.random().toString(36).slice(2)}@t.io`,
  });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: user.id,
      kind: "twitter_account",
      handleUrl: "https://x.com/walkeracct",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport: opts.autoImport ?? true,
      metadata: { handle: "walkeracct", accountId: ACCOUNT },
    })
    .returning({ id: dataSources.id });
  return row!.id;
}

async function readChannelState() {
  const [row] = await db
    .select()
    .from(dataSourceChannelState)
    .where(
      and(
        eq(dataSourceChannelState.kind, "twitter_account"),
        eq(dataSourceChannelState.channelKey, ACCOUNT),
      ),
    )
    .limit(1);
  return row;
}

beforeEach(() => {
  provider.pages = [];
  provider.calls = [];
  provider.throwOn = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("twitter account walker (single-feed, resumable, cursor-persisted)", () => {
  it("[11-03] a single-feed walk inserts events + snapshots with share_count populated", async () => {
    await seedSource();
    // w1: retweet 40 + quote 2 = 42 shares; w2: retweet 100 + quote 3 = 103.
    provider.pages = [
      await pageFrom(
        [
          tweet("w1", 1, { retweetCount: 40, quoteCount: 2, bookmarkCount: 5 }),
          tweet("w2", 2, { retweetCount: 100, quoteCount: 3, bookmarkCount: 9 }),
        ],
        null,
        true,
      ),
    ];

    await handleBackfillAccount({
      data: {
        kind: "twitter_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const inserted = await db.select().from(events).where(eq(events.kind, "twitter_post"));
    expect(inserted.map((e) => e.externalId).sort()).toEqual(["w1", "w2"]);

    const cached = await db.select().from(twitterPosts);
    expect(cached.map((p) => p.tweetId).sort()).toEqual(["w1", "w2"]);
    expect(cached.every((p) => p.accountId === ACCOUNT)).toBe(true);

    // The DERIVED share_count (retweet+quote) was stored in the snapshot rows.
    const snaps = await db.select().from(twitterPostSnapshots);
    const byTweet = new Map(snaps.map((s) => [s.tweetId, s.shareCount]));
    expect(byTweet.get("w1")).toBe(42);
    expect(byTweet.get("w2")).toBe(103);

    // The FREE feed owner UPSERTed the subject entity with NO extra call.
    const [acct] = await db
      .select()
      .from(twitterAccounts)
      .where(eq(twitterAccounts.accountId, ACCOUNT));
    expect(acct).toBeDefined();
    expect(acct!.username).toBe("walkeracct");
    // Only ONE provider call (the single feed) — no posts/reels two-feed split.
    expect(provider.calls).toHaveLength(1);
  });

  it("[11-03] snapshot rows carry the D-05 raw retweet/quote/bookmark components", async () => {
    await seedSource();
    provider.pages = [
      await pageFrom([tweet("r1", 1, { retweetCount: 40, quoteCount: 2, bookmarkCount: 17 })], null, true),
    ];

    await handleBackfillAccount({
      data: {
        kind: "twitter_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const [snap] = await db
      .select()
      .from(twitterPostSnapshots)
      .where(eq(twitterPostSnapshots.tweetId, "r1"));
    expect(snap).toBeDefined();
    // The raw components are retained alongside the derived shares sum (D-05).
    expect(snap!.retweetCount).toBe(40);
    expect(snap!.quoteCount).toBe(2);
    expect(snap!.bookmarkCount).toBe(17);
    expect(snap!.shareCount).toBe(42);
  });

  it("[11-03] the D-04 filter drops a retweet + a foreign reply, keeps a self-reply", async () => {
    await seedSource();
    provider.pages = [
      await pageFrom(
        [
          tweet("orig", 1), // original → kept
          tweet("rt", 2, { retweeted_tweet: { id: "x" } }), // retweet → dropped
          tweet("foreign", 3, { isReply: true, inReplyToUserId: "999-other" }), // foreign reply → dropped
          tweet("selfreply", 4, { isReply: true, inReplyToUserId: ACCOUNT }), // self-reply → kept
        ],
        null,
        true,
      ),
    ];

    await handleBackfillAccount({
      data: {
        kind: "twitter_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const inserted = await db.select().from(events).where(eq(events.kind, "twitter_post"));
    // Originals + self-reply threads survive; retweets + foreign replies drop (D-04).
    expect(inserted.map((e) => e.externalId).sort()).toEqual(["orig", "selfreply"]);
  });

  it("[11-03] re-walking the same feed is idempotent (pre-INSERT SELECT, no dup events)", async () => {
    await seedSource();
    const makePage = async () => pageFrom([tweet("d1", 1), tweet("d2", 2)], null, true);

    provider.pages = [await makePage()];
    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });
    // Reset channel state so the second walk re-fetches page 1 (incremental sweep).
    provider.pages = [await makePage()];
    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "auto_passive" },
    });

    const inserted = await db.select().from(events).where(eq(events.kind, "twitter_post"));
    expect(inserted.map((e) => e.externalId).sort()).toEqual(["d1", "d2"]);
  });

  it("[11-03] the walker advances the frontier so the next tick resumes where it stopped", async () => {
    await seedSource();
    // Tick 1: a page with a cursor (more available).
    provider.pages = [await pageFrom([tweet("p1", 1), tweet("p2", 2)], "CURSOR_A", false)];

    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    const st1 = await getTwitterBackfillState(ACCOUNT);
    expect(st1.cursor).toBe("CURSOR_A");
    expect(st1.complete).toBe(false);

    // Tick 2 resumes from the persisted cursor.
    provider.pages = [await pageFrom([tweet("p3", 3)], null, true)];
    provider.calls = [];

    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    expect(provider.calls[0]?.cursor).toBe("CURSOR_A");
    const cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(true);

    const inserted = await db.select().from(events).where(eq(events.kind, "twitter_post"));
    expect(inserted.map((e) => e.externalId).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("[11-03] an empty first page on a brand-new source flips not_found, NOT backfill_complete (Pitfall 4)", async () => {
    const sourceId = await seedSource();
    provider.pages = [emptyPage()];

    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    const [src] = await db.select().from(dataSources).where(eq(dataSources.id, sourceId)).limit(1);
    expect(src?.needsReconnect).toBe(true);
    expect(src?.lastErrorKind).toBe("not-found");

    const cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(false);
  });

  it('[11-03] the backfill audit row carries platform: "twitter_account" (the user-quota keyspace)', async () => {
    const user = await seedUserDirectly({
      email: `walker-tw-audit-${Math.random().toString(36).slice(2)}@t.io`,
    });
    await db.insert(dataSources).values({
      userId: user.id,
      kind: "twitter_account",
      handleUrl: "https://x.com/walkeracct",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle: "walkeracct", accountId: ACCOUNT },
    });
    provider.pages = [await pageFrom([tweet("a1", 1)], null, true)];

    await handleBackfillAccount({
      data: {
        kind: "twitter_account",
        channelKey: ACCOUNT,
        triggerUserId: user.id,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "incremental",
      },
    });

    const rows = await db.select().from(auditLog).where(eq(auditLog.userId, user.id));
    const backfillRows = rows.filter(
      (r) => (r.metadata as { platform?: string }).platform === "twitter_account",
    );
    expect(backfillRows.length).toBeGreaterThanOrEqual(1);
    expect((backfillRows[0]!.metadata as { requests_used?: number }).requests_used).toBe(1);
    // The social-budget label "twitter" must NOT appear on a user-quota row.
    expect(
      rows.filter((r) => (r.metadata as { platform?: string }).platform === "twitter"),
    ).toHaveLength(0);
  });
});

describe("twitter account walker — self-enqueued continuation", () => {
  it("[11-03] a 2-page deep backfill enqueues a continuation on tick 1, completes on tick 2", async () => {
    await seedSource();
    provider.pages = [await pageFrom([tweet("c1", 1), tweet("c2", 2)], "PAGE2", false)];

    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    let cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(false);
    let continuations = await readContinuationOutbox();
    expect(continuations).toHaveLength(1);
    const payload = continuations[0]!.payload as { channelKey: string; triggerUserId?: string };
    expect(payload.channelKey).toBe(ACCOUNT);
    expect(payload.triggerUserId).toBeUndefined();

    provider.pages = [await pageFrom([tweet("c3", 3)], null, true)];
    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(true);
    continuations = await readContinuationOutbox();
    expect(continuations).toHaveLength(1);

    const inserted = await db.select().from(events).where(eq(events.kind, "twitter_post"));
    expect(inserted.map((e) => e.externalId).sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("[11-03] a QPS-429 (rate-limited) paused tick RE-ENQUEUES a paced continuation and persists operatorPaused=true", async () => {
    await seedSource();
    provider.throwOn = "rate-limited";

    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    const cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(false);
    const st = await getTwitterBackfillState(ACCOUNT);
    expect(st.operatorPaused).toBe(true);
    // THE FIX: a transient 429 must resume after the limit clears (not strand until the
    // daily poll-cron) — exactly one continuation, paced ≥5s out (the 0.2-QPS floor).
    const continuations = await readContinuationOutbox();
    expect(continuations).toHaveLength(1);
    expect(
      Number((continuations[0]!.options as { startAfter?: number }).startAfter),
    ).toBeGreaterThanOrEqual(5);
  });

  it("[11-03] an operator-issue (budget) paused tick enqueues NO continuation (strands for the daily cron)", async () => {
    await seedSource();
    provider.throwOn = "operator-issue";

    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    const cs = await readChannelState();
    expect(cs?.backfillComplete).toBe(false);
    const st = await getTwitterBackfillState(ACCOUNT);
    expect(st.operatorPaused).toBe(true);
    // A prepaid-balance/daily-cap pause genuinely needs the daily reset — retrying in
    // 5s is pointless, so NO continuation (current behavior preserved).
    const continuations = await readContinuationOutbox();
    expect(continuations).toHaveLength(0);
  });
});
