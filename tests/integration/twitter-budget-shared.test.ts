// Twitter/X provider budget isolation (D-02): twitterapi.io is a SEPARATE prepaid
// balance from ScrapeCreators. Twitter spend draws the twitterapi.io provider balance
// row; IG/TikTok (scrapecreators) spend does NOT reduce it (the per-provider
// social_provider_balance re-key from Plan 10-01). Same shared SOCIAL_PROVIDER_*
// daily-cap envelope, SEPARATE balance ledger per provider.
//
// Real Postgres via ./helpers.js. The first part exercises the budget engine through
// BOTH the twitter and instagram quota modules (same shared helper, DIFFERENT
// provider rows). The second part drives the REAL twitter walker against a provider
// fake that throws the operator-issue AdapterError on a depleted balance — proving
// the walker pauses + persists operatorPaused.
//
// Requirements: BUDGET-01 / D-02.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { TwitterFeedPage } from "../../src/lib/sources/twitter/server/normalize.js";

// Provider fake for the walker-pause half: throws operator-issue (the depleted
// prepaid-balance null-permit shape http.ts produces) when `exhausted` is set.
const provider = { exhausted: false };

vi.mock("../../src/lib/sources/twitter/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const { AdapterError: AE } = await import("../../src/lib/sources/errors.js");
  return {
    ...actual,
    isTwitterConfigured: () => true,
    getSocialProvider: (platform: string) =>
      platform === "twitter" ? ({ name: "twitterapi.io" } as never) : null,
    fetchTwitterFeedPageWithRaw: async (): Promise<TwitterFeedPage> => {
      if (provider.exhausted) {
        throw new AE("operator budget exhausted (prepaid balance <= 0)", {
          category: "operator-issue",
        });
      }
      return {
        page: { posts: [], nextCursor: null, endOfFeed: true, creditsUsed: 1, owner: null },
        rawTweets: [],
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { dataSourceChannelState } =
  await import("../../src/lib/server/db/schema/data-source-channel-state.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/twitter/server/handlers/backfill-account.js");
const { getTwitterBackfillState } =
  await import("../../src/lib/sources/twitter/server/backfill-state.js");

// The twitter tree's OWN quota module (a re-export of the shared engine) vs the
// instagram module — they are the SAME single ledger but keyed by DIFFERENT providers.
const twitterQuota = await import("../../src/lib/sources/twitter/server/quota.js");
const igQuota = await import("../../src/lib/sources/instagram/server/quota.js");

const SCRAPECREATORS = "scrapecreators";
const TWITTERAPIIO = "twitterapi.io";
const ACCOUNT = "acct-budget-tw";

beforeEach(async () => {
  provider.exhausted = false;
  await twitterQuota.resetSocialDailyCap();
});

describe("twitter provider budget isolation (D-02)", () => {
  it("[11-03] spend via the twitter adapter draws from the twitterapi.io provider balance row", async () => {
    const SPEND = 5;
    // A twitter-platform reserve against the twitterapi.io provider.
    const permit = await twitterQuota.reserveSocialCredits({
      platform: "twitter",
      provider: TWITTERAPIIO,
      origin: "user",
      units: SPEND,
    });
    expect(permit).not.toBeNull();

    const twView = await twitterQuota.getSocialSpendToday("twitter", TWITTERAPIIO);
    expect(twView.creditsUsed).toBe(SPEND);
  });

  it("[11-03] instagram/tiktok (scrapecreators) spend does NOT reduce the twitterapi.io balance (D-02)", async () => {
    // Read the twitterapi.io balance.
    const before = await twitterQuota.getSocialSpendToday("twitter", TWITTERAPIIO);

    // Spend a chunk on the scrapecreators provider (the IG/TikTok pool).
    const permit = await igQuota.reserveSocialCredits({
      platform: "instagram",
      provider: SCRAPECREATORS,
      origin: "user",
      units: 11,
    });
    expect(permit).not.toBeNull();

    // The twitterapi.io balance is UNTOUCHED — different provider row.
    const after = await twitterQuota.getSocialSpendToday("twitter", TWITTERAPIIO);
    expect(after.prepaidBalance).toBe(before.prepaidBalance);
    // And the scrapecreators balance moved (proving the IG spend landed somewhere).
    const sc = await igQuota.getSocialSpendToday("instagram", SCRAPECREATORS);
    expect(sc.creditsUsed).toBeGreaterThanOrEqual(11);
  });

  it("[11-03] twitter spend reuses the shared SOCIAL_PROVIDER_* daily-cap envelope (no new budget vars)", async () => {
    // The daily cap value is the SAME shared env figure both providers seed from.
    const tw = await twitterQuota.getSocialSpendToday("twitter", TWITTERAPIIO);
    const ig = await igQuota.getSocialSpendToday("instagram", SCRAPECREATORS);
    expect(tw.dailyCap).toBe(ig.dailyCap);
    expect(tw.dailyCap).toBeGreaterThan(0);
  });

  it("[11-03] an exhausted twitterapi.io prepaid balance pauses the twitter walker (operator-issue)", async () => {
    const user = await seedUserDirectly({ email: `tw-budget-${Math.random()}@t.io` });
    await db.insert(dataSources).values({
      userId: user.id,
      kind: "twitter_account",
      handleUrl: "https://x.com/budgetacct",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle: "budgetacct", accountId: ACCOUNT },
    });

    provider.exhausted = true;

    await handleBackfillAccount({
      data: {
        kind: "twitter_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const st = await getTwitterBackfillState(ACCOUNT);
    expect(st.operatorPaused).toBe(true);
    const [cs] = await db
      .select()
      .from(dataSourceChannelState)
      .where(
        and(
          eq(dataSourceChannelState.kind, "twitter_account"),
          eq(dataSourceChannelState.channelKey, ACCOUNT),
        ),
      )
      .limit(1);
    expect(cs?.backfillComplete).toBe(false);
  });
});
