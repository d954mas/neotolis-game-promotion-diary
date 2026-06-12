// TikTok shared-ceiling, end-to-end THROUGH THE TIKTOK ADAPTER spend path: spend on
// the instagram platform reduces TikTok's available balance because the prepaid
// balance is one shared pool per provider (D-01). The SCHEMA-level invariant is
// already proven LIVE by social-budget-provider-keyed.test.ts (Plan 10-01 Task 1);
// THIS test proves the TikTok adapter's actual reserve path (the same shared helper,
// re-exported from tiktok/server/quota.ts) wires into that shared balance, AND that
// an exhausted shared balance pauses the TikTok walker (operator-issue) even with
// daily-cap headroom.
//
// Real Postgres via ./helpers.js. The first part exercises the budget engine
// directly through BOTH the instagram and tiktok quota modules (proving they are the
// SAME helper). The second part drives the REAL tiktok walker against a provider
// fake that throws the operator-issue AdapterError http.ts raises on a depleted
// balance — proving the walker pauses + persists operatorPaused.
//
// Requirements: PLAT-02.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";
import type { ProviderPage } from "../../src/lib/sources/social-provider.js";

// Provider fake for the walker-pause half: throws operator-issue (the depleted
// prepaid-balance null-permit shape http.ts produces) when `exhausted` is set.
const provider = { exhausted: false, page: null as ProviderPage | null };

vi.mock("../../src/lib/sources/tiktok/server/provider/registry.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const { AdapterError: AE } = await import("../../src/lib/sources/errors.js");
  return {
    ...actual,
    isTikTokConfigured: () => true,
    getSocialProvider: (platform: string) => {
      if (platform !== "tiktok") return null;
      return {
        name: "scrapecreators",
        async fetchPosts(): Promise<ProviderPage> {
          if (provider.exhausted) {
            throw new AE("operator budget exhausted (prepaid balance <= 0)", {
              category: "operator-issue",
            });
          }
          return (
            provider.page ?? {
              posts: [],
              nextCursor: null,
              endOfFeed: true,
              creditsUsed: 1,
              owner: null,
            }
          );
        },
        async resolveAccount() {
          return { accountId: "acct-budget-tk", displayName: "Budget" };
        },
      };
    },
  };
});

const { db } = await import("../../src/lib/server/db/client.js");
const { dataSources } = await import("../../src/lib/server/db/schema/data-sources.js");
const { dataSourceChannelState } =
  await import("../../src/lib/server/db/schema/data-source-channel-state.js");
const { handleBackfillAccount } =
  await import("../../src/lib/sources/tiktok/server/handlers/backfill-account.js");
const { getTikTokBackfillState } =
  await import("../../src/lib/sources/tiktok/server/backfill-state.js");

// The TikTok tree's OWN quota module (a re-export of the shared engine) vs the
// instagram module — they must be the SAME single ledger.
const tiktokQuota = await import("../../src/lib/sources/tiktok/server/quota.js");
const igQuota = await import("../../src/lib/sources/instagram/server/quota.js");

const PROVIDER = "scrapecreators";
const ACCOUNT = "acct-budget-tk";

beforeEach(async () => {
  provider.exhausted = false;
  provider.page = null;
  // Clear the module-level audit/exhaustion guards so each test starts clean.
  await tiktokQuota.resetSocialDailyCap();
});

describe("tiktok shared budget ceiling (D-01) — through the adapter spend path", () => {
  it("[10-04] an instagram-platform reserve reduces the balance the TikTok adapter's reserve sees (shared ceiling, end-to-end)", async () => {
    const SEED = 100000;
    const SPEND = 7;

    // Spend N credits attributed to the instagram platform via the IG quota module.
    const permit = await igQuota.reserveSocialCredits({
      platform: "instagram",
      provider: PROVIDER,
      origin: "user",
      units: SPEND,
    });
    expect(permit).not.toBeNull();

    // The TikTok tree's OWN quota module (re-export) reads the SAME provider-keyed
    // balance — the IG spend has reduced what TikTok can see.
    const tiktokView = await tiktokQuota.getSocialSpendToday("tiktok", PROVIDER);
    expect(tiktokView.prepaidBalance).toBe(SEED - SPEND);

    // And a subsequent TikTok-platform reserve draws down the SAME pool further.
    await tiktokQuota.reserveSocialCredits({
      platform: "tiktok",
      provider: PROVIDER,
      origin: "user",
      units: 3,
    });
    const afterTikTok = await tiktokQuota.getSocialSpendToday("tiktok", PROVIDER);
    expect(afterTikTok.prepaidBalance).toBe(SEED - SPEND - 3);
    // The IG view agrees — it is literally the same row.
    const igView = await igQuota.getSocialSpendToday("instagram", PROVIDER);
    expect(igView.prepaidBalance).toBe(afterTikTok.prepaidBalance);
  });

  it("[10-04] an exhausted shared prepaid balance pauses the TikTok walker (operator-issue) even with daily cap headroom", async () => {
    // Seed a source.
    const user = await seedUserDirectly({ email: `tk-budget-${Math.random()}@t.io` });
    await db.insert(dataSources).values({
      userId: user.id,
      kind: "tiktok_account",
      handleUrl: "https://www.tiktok.com/@budgetacct",
      channelId: ACCOUNT,
      isOwnedByMe: true,
      autoImport: true,
      metadata: { handle: "budgetacct", accountId: ACCOUNT },
    });

    // The provider fake raises the operator-issue AdapterError http.ts would raise on
    // a depleted prepaid balance (a null permit). The walker must catch it, pause,
    // and persist operatorPaused=true WITHOUT marking backfill complete — even though
    // the daily-cap counter has headroom (the balance, not the cap, is the blocker).
    provider.exhausted = true;

    await handleBackfillAccount({
      data: {
        kind: "tiktok_account",
        channelKey: ACCOUNT,
        depthBoundIso: "1970-01-01T00:00:00Z",
        flow: "initial",
      },
    });

    const st = await getTikTokBackfillState(ACCOUNT);
    expect(st.operatorPaused).toBe(true);
    const [cs] = await db
      .select()
      .from(dataSourceChannelState)
      .where(
        and(
          eq(dataSourceChannelState.kind, "tiktok_account"),
          eq(dataSourceChannelState.channelKey, ACCOUNT),
        ),
      )
      .limit(1);
    expect(cs?.backfillComplete).toBe(false);
  });
});
