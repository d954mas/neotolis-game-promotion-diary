// Twitter/X backfill bound — the single-feed walker stops at SOCIAL_BACKFILL_MAX_POSTS
// OR the date window, whichever first, so cost is independent of archive size
// (BACK-01/02). REAL handleBackfillAccount against real Postgres; provider seam mocked.
//
// Requirements: PLAT-03 / BACK-01 / BACK-02.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { TwitterFeedPage, Tweet } from "../../src/lib/sources/twitter/server/normalize.js";

const provider = {
  pages: [] as TwitterFeedPage[],
  /** When set, the next fetch throws this AdapterError instead of returning a page
   *  (simulates the per-account QPS 429 / operator-issue pause). */
  throwError: null as Error | null,
};

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
    fetchTwitterFeedPageWithRaw: async (): Promise<TwitterFeedPage> => {
      if (provider.throwError !== null) throw provider.throwError;
      return provider.pages.shift() ?? emptyPage();
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { env } = await import("../../src/lib/server/config/env.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { outbox } = await import("../../src/lib/server/db/schema/outbox.js");
const { normalizeTweet } = await import("../../src/lib/sources/twitter/server/normalize.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/twitter/server/handlers/backfill-account.js");
const { getTwitterBackfillState } =
  await import("../../src/lib/sources/twitter/server/backfill-state.js");
const { getChannelState } = await import("../../src/lib/server/services/channel-state.js");
const { twitterAdapter } = await import("../../src/lib/sources/twitter/server/index.js");
const { AdapterError } = await import("../../src/lib/sources/errors.js");

const ACCOUNT = "acct-bound-tw";
const envMut = env as { SOCIAL_BACKFILL_MAX_POSTS: number };
let originalMaxPosts: number;

function tweet(id: string, daysAgo: number): Tweet {
  return {
    id,
    url: `https://x.com/b/status/${id}`,
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
    author: {
      id: ACCOUNT,
      userName: "boundacct",
      name: "Bound",
      profilePicture: null,
      followers: 1,
    },
  };
}

/** A "still more available" page of 12 fresh tweets (all within 1d). */
function fullPage(seed: number): TwitterFeedPage {
  const tweets = Array.from({ length: 12 }, (_, i) => tweet(`c${seed}_${i}`, 1));
  return {
    page: {
      posts: tweets.map(normalizeTweet),
      nextCursor: `CURSOR_${seed}`,
      endOfFeed: false,
      creditsUsed: 1,
      owner: null,
    },
    rawTweets: tweets,
  };
}

async function seedSource(): Promise<string> {
  const user = await seedUserDirectly({
    email: `bound-tw-${Math.random().toString(36).slice(2)}@t.io`,
  });
  const [row] = await db
    .insert(dataSources)
    .values({
      userId: user.id,
      kind: "twitter_account",
      handleUrl: "https://x.com/boundacct",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle: "boundacct", accountId: ACCOUNT },
    })
    .returning({ id: dataSources.id });
  return row!.id;
}

beforeEach(() => {
  provider.pages = [];
  provider.throwError = null;
  originalMaxPosts = env.SOCIAL_BACKFILL_MAX_POSTS;
});
afterEach(() => {
  envMut.SOCIAL_BACKFILL_MAX_POSTS = originalMaxPosts;
});

describe("twitter backfill bounding", () => {
  it("[11-03] stops at SOCIAL_BACKFILL_MAX_POSTS (BACK-01)", async () => {
    envMut.SOCIAL_BACKFILL_MAX_POSTS = 24;
    await seedSource();

    // The provider ALWAYS returns a full 12-tweet page with a non-null cursor
    // (has_next_page forever). With cap=24 the deep walk must halt after 24 tweets.
    provider.pages = [fullPage(1), fullPage(2), fullPage(3), fullPage(4)];

    for (let tick = 0; tick < 4; tick++) {
      const st = await getTwitterBackfillState(ACCOUNT);
      if (st.complete) break;
      await handleBackfillAccount({
        data: {
          kind: "twitter_account",
          channelKey: ACCOUNT,
          depthBoundIso: "1970-01-01T00:00:00Z",
          flow: "initial",
        },
      });
    }

    const st = await getTwitterBackfillState(ACCOUNT);
    expect(st.complete).toBe(true);
    expect(st.collected).toBe(24); // exactly the cap — not more

    const imported = await db.select().from(events).where(eq(events.kind, "twitter_post"));
    expect(imported.length).toBe(24);
  });

  it("[11-03] stops at the backfill date window (BACK-02)", async () => {
    await seedSource();

    // Newest-first: two tweets inside 7d, then one beyond — stop at the boundary.
    const tweets = [tweet("w1", 1), tweet("w2", 5), tweet("w3", 30)];
    provider.pages = [
      {
        page: {
          posts: tweets.map(normalizeTweet),
          nextCursor: "MORE",
          endOfFeed: false,
          creditsUsed: 1,
          owner: null,
        },
        rawTweets: tweets,
      },
    ];

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    await handleBackfillAccount({
      data: {
        kind: "twitter_account",
        channelKey: ACCOUNT,
        depthBoundIso: sevenDaysAgo,
        flow: "initial",
      },
    });

    const imported = await db.select().from(events).where(eq(events.kind, "twitter_post"));
    expect(imported.map((e) => e.externalId).sort()).toEqual(["w1", "w2"]);
    const st = await getTwitterBackfillState(ACCOUNT);
    expect(st.complete).toBe(true);
  });

  it("[11-03] marks backfill_complete when the feed is exhausted before the cap", async () => {
    await seedSource();
    const tweets = [tweet("e1", 1), tweet("e2", 2)];
    provider.pages = [
      {
        page: {
          posts: tweets.map(normalizeTweet),
          nextCursor: null,
          endOfFeed: true,
          creditsUsed: 1,
          owner: null,
        },
        rawTweets: tweets,
      },
    ];

    await handleBackfillAccount({
      data: {
        kind: "twitter_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const st = await getTwitterBackfillState(ACCOUNT);
    expect(st.complete).toBe(true);
    expect(st.collected).toBe(2);
  });
});

// ── QPS-429 self-resume + continuation pacing (the strand-until-cron fix). The
//    backfill must NOT self-enqueue the next page with zero delay (consecutive pages
//    would burst past the 0.2-QPS floor → 429 every page), and a transient 429 must
//    re-enqueue a paced continuation rather than stranding until the daily poll-cron.
describe("twitter backfill QPS-429 resume + pacing", () => {
  /** Seed a deep-backfill source under a distinct account so the global outbox table
   *  reads back exactly this test's continuation. */
  async function seedSourceFor(account: string): Promise<void> {
    const user = await seedUserDirectly({
      email: `qps-tw-${Math.random().toString(36).slice(2)}@t.io`,
    });
    await db.insert(dataSources).values({
      userId: user.id,
      kind: "twitter_account",
      handleUrl: `https://x.com/${account}`,
      channelId: account,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle: account, accountId: account },
    });
  }

  /** The backfill-account continuation outbox row for this channelKey, if any. */
  async function continuationRow(
    account: string,
  ): Promise<{ payload: Record<string, unknown>; options: Record<string, unknown> } | null> {
    const rows = await db
      .select({ payload: outbox.payload, options: outbox.options, queue: outbox.queue })
      .from(outbox)
      .where(eq(outbox.queue, "twitter.backfill.account"));
    const mine = rows.find((r) => (r.payload as { channelKey?: string }).channelKey === account);
    return mine ? { payload: mine.payload, options: mine.options } : null;
  }

  it("[11-03] a deep multi-page continuation carries options.startAfter >= 5 (paces the 0.2-QPS floor)", async () => {
    const account = `acct-pace-${Math.random().toString(36).slice(2)}`;
    await seedSourceFor(account);

    // A full page with a non-null cursor + feed-not-exhausted → the walker self-enqueues
    // the next deep page. It MUST be delayed ≥5s, never fired back-to-back.
    const tweets = Array.from({ length: 3 }, (_, i) => tweet(`p_${i}`, 1));
    provider.pages = [
      {
        page: {
          posts: tweets.map(normalizeTweet),
          nextCursor: "NEXT",
          endOfFeed: false,
          creditsUsed: 1,
          owner: null,
        },
        rawTweets: tweets,
      },
    ];

    await handleBackfillAccount({
      data: {
        kind: "twitter_account",
        channelKey: account,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const cont = await continuationRow(account);
    expect(cont, "expected a deep continuation outbox row").toBeTruthy();
    expect(cont!.payload.channelKey).toBe(account);
    expect(Number(cont!.options.startAfter)).toBeGreaterThanOrEqual(5);
  });

  it("[11-03] a rate-limited (429) deep page re-enqueues a paced continuation (no strand-until-cron)", async () => {
    const account = `acct-429-${Math.random().toString(36).slice(2)}`;
    await seedSourceFor(account);

    // The first deep page throws the per-account QPS 429 with the honored Retry-After.
    // The feed is NOT exhausted (cursor still null = first page never fetched), so the
    // walker must persist the cursor + re-enqueue a paced continuation.
    provider.throwError = new AdapterError("twitterapi.io rate-limited (429)", {
      category: "rate-limited",
      retryAfterMs: 5000,
    });

    await handleBackfillAccount({
      data: {
        kind: "twitter_account",
        channelKey: account,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    // No events imported, cursor persisted, NOT marked complete (paused mid-walk).
    const imported = await db.select().from(events).where(eq(events.externalId, "irrelevant"));
    expect(imported.length).toBe(0);
    const st = await getTwitterBackfillState(account);
    expect(st.complete).toBe(false);
    // A transient QPS slot wait is NOT operator-budget exhaustion — the badge stays off
    // (only the operator-issue pause below sets it).
    expect(st.operatorPaused).toBe(false);

    // THE FIX: a continuation row exists, paced ≥5s out (so it resumes after the limit
    // clears instead of stranding until the next 06:00 poll-cron).
    const cont = await continuationRow(account);
    expect(cont, "rate-limit pause must re-enqueue a continuation").toBeTruthy();
    expect(cont!.payload.channelKey).toBe(account);
    expect(Number(cont!.options.startAfter)).toBeGreaterThanOrEqual(5);
  });

  it("[11-03] an operator-issue (budget) pause does NOT re-enqueue (strands for the daily cron)", async () => {
    const account = `acct-oi-${Math.random().toString(36).slice(2)}`;
    await seedSourceFor(account);

    // Prepaid balance depleted — retrying in 5s is pointless; the daily reset is the
    // only fix. Current behavior preserved: NO continuation row.
    provider.throwError = new AdapterError("operator budget exhausted", {
      category: "operator-issue",
    });

    await handleBackfillAccount({
      data: {
        kind: "twitter_account",
        channelKey: account,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const st = await getTwitterBackfillState(account);
    expect(st.operatorPaused).toBe(true);
    expect(st.complete).toBe(false);

    const cont = await continuationRow(account);
    expect(cont, "operator-issue pause must NOT re-enqueue").toBeNull();
  });
});

// ── P1-A: an all-older-than-window first deep page must still write a NON-null frontier
//    so a later date-range WIDEN can reopen the history (instead of early-exiting on a
//    null backfillOldestAt and stranding the older archive forever).
describe("twitter backfill frontier on out-of-window first page (widen reopen)", () => {
  async function seedSourceFor(account: string): Promise<string> {
    const user = await seedUserDirectly({
      email: `frontier-tw-${Math.random().toString(36).slice(2)}@t.io`,
    });
    const [row] = await db
      .insert(dataSources)
      .values({
        userId: user.id,
        kind: "twitter_account",
        handleUrl: `https://x.com/${account}`,
        channelId: account,
        isOwnedByMe: true,
        autoImport: true,
        metadata: { handle: account, accountId: account },
      })
      .returning({ id: dataSources.id });
    return row!.id;
  }

  it("[11-P1A] a deep first page entirely older than the window records a non-null frontier and a widen reopens it", async () => {
    const account = `acct-frontier-${Math.random().toString(36).slice(2)}`;
    const sourceId = await seedSourceFor(account);

    // The ONLY page is all-older-than-window (every tweet 30/45/60d old) AND end-of-feed.
    // Window is 7d → every tweet crosses the window on the FIRST tweet, so zero feed
    // events are collected. Before the fix oldestFetchedOccurredAt stayed null and the
    // frontier was never written; after the fix the fetched tweets set it.
    const oldTweets = [tweet("o1", 30), tweet("o2", 45), tweet("o3", 60)];
    provider.pages = [
      {
        page: {
          posts: oldTweets.map(normalizeTweet),
          nextCursor: null,
          endOfFeed: true,
          creditsUsed: 1,
          owner: null,
        },
        rawTweets: oldTweets,
      },
    ];

    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000);
    await handleBackfillAccount({
      data: {
        kind: "twitter_account",
        channelKey: account,
        // Deep walk toward 7d ago — the page is entirely older, so it all crosses.
        depthBoundIso: sevenDaysAgo.toISOString(),
        flow: "initial",
        forceDeep: true,
      },
    });

    // No in-window feed events (all older than the 7d window) for this account's tweets.
    const importedByExt = await db.select().from(events).where(eq(events.kind, "twitter_post"));
    expect(
      importedByExt.filter((e) => ["o1", "o2", "o3"].includes(e.externalId ?? "")).length,
    ).toBe(0);

    // THE FIX: the deep walk wrote a NON-null frontier and marked the account complete.
    // The frontier = o1 @ 30d: the loop breaks at the FIRST out-of-window tweet (the page
    // is newest-first), so o1 is the oldest tweet fetched-and-snapshotted before the
    // break. Pre-fix the frontier stayed null (update ran AFTER the break).
    const state = await getChannelState("twitter_account", account);
    expect(state?.backfillComplete).toBe(true);
    expect(
      state?.backfillOldestAt,
      "frontier must be non-null after an all-older page",
    ).not.toBeNull();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
    expect(Math.abs(state!.backfillOldestAt!.getTime() - thirtyDaysAgo.getTime())).toBeLessThan(
      86_400_000,
    );

    // A subsequent WIDEN to 90d must REOPEN (re-enqueue a forceDeep walk) — the null
    // frontier early-exit no longer strands the older history.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
    await db.transaction(async (tx) => {
      await twitterAdapter.resetWalkerStateOnWidening!(
        {
          id: sourceId,
          userId: "ignored",
          kind: "twitter_account",
          channelId: account,
          autoImport: true,
          isOwnedByMe: true,
          backfillTargetSince: ninetyDaysAgo,
          metadata: { accountId: account, handle: account },
        } as never,
        {
          previousTarget: sevenDaysAgo,
          newTarget: ninetyDaysAgo,
          triggerUserId: "widen-user",
          ipAddress: "0.0.0.0",
          tx,
        },
      );
    });

    const rows = await db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(eq(outbox.queue, "twitter.backfill.account"));
    const reopen = rows.find(
      (r) =>
        (r.payload as { channelKey?: string; forceDeep?: boolean }).channelKey === account &&
        (r.payload as { forceDeep?: boolean }).forceDeep === true,
    );
    expect(
      reopen,
      "widen must re-enqueue a forceDeep walk (not early-exit on null frontier)",
    ).toBeTruthy();
  });
});
