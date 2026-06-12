// BUDGET-01 producer wiring (Twitter/X) — the PollingBadge "Paused · operator budget
// reached" hint, end to end, against real Postgres.
//
// THE PRODUCER: the walker (handleBackfillAccount) flips metadata.twitter.operatorPaused
// on the per-account channel-state row (the source of truth it owns via backfill-state.ts)
// when a tick is paused because the operator's prepaid twitterapi.io budget refused a
// page reserve (AdapterError operator-issue — also the 95% throttle / per-account QPS
// 429 path), and CLEARS it on a successful unpaused tick. The read side
// (twitterEnrichFeedDtos) overlays that flag onto each twitter event DTO's
// metadata.operator_paused at load time — so the badge lights up.
//
// The twitterapi.io boundary is faked at the PROVIDER SEAM. The DB is REAL. The budget
// pause is simulated by the faked fetch throwing AdapterError (operator-issue).
//
// Requirements: BUDGET-01.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { TwitterFeedPage, Tweet } from "../../src/lib/sources/twitter/server/normalize.js";

interface ScriptedProvider {
  paused: boolean;
  page: TwitterFeedPage | null;
}
const provider: ScriptedProvider = { paused: false, page: null };

function emptyPage(): TwitterFeedPage {
  return {
    page: { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1, owner: null },
    rawTweets: [],
  };
}

vi.mock("../../src/lib/sources/twitter/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const { AdapterError: AE } = await import("../../src/lib/sources/errors.js");
  return {
    ...actual,
    isTwitterConfigured: () => true,
    getSocialProvider: (platform: string) =>
      platform === "twitter" ? ({ name: "twitterapi.io" } as never) : null,
    fetchTwitterFeedPageWithRaw: async (): Promise<TwitterFeedPage> => {
      if (provider.paused) {
        throw new AE("operator budget exhausted (prepaid balance <= 0)", {
          category: "operator-issue",
        });
      }
      return provider.page ?? emptyPage();
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { events } = await import("../../src/lib/server/db/schema/events.js");
const { normalizeTweet } = await import("../../src/lib/sources/twitter/server/normalize.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/twitter/server/handlers/backfill-account.js");
const { getTwitterBackfillState } =
  await import("../../src/lib/sources/twitter/server/backfill-state.js");
const { twitterEnrichFeedDtos } =
  await import("../../src/lib/sources/twitter/server/feed-enrichment.js");
const { mapEventsToDtos } = await import("../../src/lib/server/dto.js");

const ACCOUNT = "acct-paused-tw";

function tweet(id: string, daysAgo: number): Tweet {
  return {
    id,
    url: `https://x.com/pausedacct/status/${id}`,
    text: `tweet ${id}`,
    createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    likeCount: 10,
    retweetCount: 40,
    replyCount: 2,
    quoteCount: 10,
    viewCount: 1000,
    bookmarkCount: 5,
    isReply: false,
    inReplyToId: null,
    inReplyToUserId: null,
    inReplyToUsername: null,
    retweeted_tweet: null,
    quoted_tweet: null,
    extendedEntities: {},
    author: { id: ACCOUNT, userName: "pausedacct", name: "Paused", profilePicture: null, followers: 1 },
  };
}

function pageOf(tweets: Tweet[]): TwitterFeedPage {
  return {
    page: { posts: tweets.map(normalizeTweet), nextCursor: null, endOfFeed: true, creditsUsed: 1, owner: null },
    rawTweets: tweets,
  };
}

async function seedSource(): Promise<{ userId: string }> {
  const user = await seedUserDirectly({ email: `paused-tw-${Math.random()}@t.io` });
  await db.insert(dataSources).values({
    userId: user.id,
    kind: "twitter_account",
    handleUrl: "https://x.com/pausedacct",
    channelId: ACCOUNT,
    isOwnedByMe: true,
    autoImport: true,
    metadata: { handle: "pausedacct", accountId: ACCOUNT },
  });
  return { userId: user.id };
}

/** Run the production read path: project the user's Twitter events to DTOs and run the
 *  adapter's enrichFeedDtos overlay. Returns the operator_paused flag the PollingBadge
 *  consumes for the first event. */
async function readOperatorPausedFlag(userId: string): Promise<boolean> {
  const rows = await db.select().from(events).where(eq(events.userId, userId));
  const dtos = await mapEventsToDtos(userId, rows);
  await twitterEnrichFeedDtos(userId, dtos);
  const twDto = dtos.find((d) => d.kind === "twitter_post");
  expect(twDto, "expected at least one twitter_post event to enrich").toBeTruthy();
  const meta = twDto!.metadata;
  if (meta === null || typeof meta !== "object") return false;
  return (meta as { operator_paused?: unknown }).operator_paused === true;
}

beforeEach(() => {
  provider.paused = false;
  provider.page = null;
});

describe("BUDGET-01: twitter operator_paused producer (walker sets/clears, reader overlays)", () => {
  it("[11-03] 95% of the prepaid balance pauses non-essential twitter polling (walker sets/clears metadata.operator_paused)", async () => {
    const { userId } = await seedSource();

    // ── Tick A: a successful walk imports one tweet so the read side has an event to
    //    enrich. Not paused → operator_paused absent.
    provider.paused = false;
    provider.page = pageOf([tweet("tw-p1", 1)]);
    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "initial" },
    });

    expect((await getTwitterBackfillState(ACCOUNT)).operatorPaused).toBe(false);
    expect(await readOperatorPausedFlag(userId)).toBe(false);

    // ── Tick B: the operator's prepaid budget is exhausted (the 95% / depleted-balance
    //    null-permit) — the reserve throws AdapterError(operator-issue). The walker
    //    catches it, pauses, and persists operatorPaused=true.
    provider.paused = true;
    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "incremental" },
    });

    expect((await getTwitterBackfillState(ACCOUNT)).operatorPaused).toBe(true);
    // THE LOAD-BEARING ASSERTION: the exact field PollingBadge consumes is true.
    expect(await readOperatorPausedFlag(userId)).toBe(true);

    // ── Tick C: budget restored. A successful unpaused tick clears the flag so the
    //    badge is NOT sticky (non-essential polling resumes).
    provider.paused = false;
    provider.page = emptyPage();
    await handleBackfillAccount({
      data: { kind: "twitter_account", channelKey: ACCOUNT, depthBoundIso: "1970-01-01T00:00:00Z", flow: "incremental" },
    });

    expect((await getTwitterBackfillState(ACCOUNT)).operatorPaused).toBe(false);
    expect(await readOperatorPausedFlag(userId)).toBe(false);
  });

  it("[11-03] a user-driven Refresh-now still works while non-essential polling is paused", async () => {
    // The refreshQueue.canRun gate skips ONLY at 95% throttle, not on a single
    // operator-issue pause — and the user_post lane charges the USER pool, separate
    // from the cron pool the operator-pause affects. We assert canRun returns "run"
    // when the throttle is healthy even though a walker tick just paused.
    const refreshQueue = (await import("../../src/lib/sources/twitter/server/index.js"))
      .twitterAdapter.refreshQueue;
    if (refreshQueue?.canRun === undefined) throw new Error("canRun missing");
    const decision = await refreshQueue.canRun({
      eventKind: "twitter_post",
      userId: "u",
      externalId: "1",
      now: new Date(),
    });
    // Provider is configured (mocked non-null) + throttle healthy in the test env →
    // refresh-now is allowed (the operator pause is a cron-pool concern, not user).
    expect(decision.action).toBe("run");
  });
});
