// D-01 JOINT DAILY CAP PROOF — the daily-cap envelope (pool limits + 80/95
// throttle bands) is computed across ALL platforms on a provider COMBINED, not
// per-platform, because the prepaid balance funding them is provider-wide (one
// real ScrapeCreators account). Instagram spend therefore eats into the SAME
// daily cap a subsequent TikTok reservation checks against.
//
// This complements social-budget-provider-keyed.test.ts (which proves the shared
// prepaid BALANCE) and social-budget-throttle.test.ts (which proves the bands on
// a single platform). The gap this closes: a reviewer change that summed the cap
// per-(platform,provider) would let IG + TikTok each spend up to the full cap —
// 2x the operator's money — and the single-platform throttle tests would NOT
// catch it. The cross-platform case here is the load-bearing guard.
//
// Real Postgres via ./helpers.js; no provider HTTP is issued (the budget engine
// is exercised directly). The global afterEach in tests/setup.ts TRUNCATEs every
// table. Test env (tests/setup.ts): SOCIAL_PROVIDER_DAILY_CAP_CREDITS=100
// (eighty=80, ninetyfive=95, cron pool=80, user pool=20),
// SOCIAL_PROVIDER_PREPAID_BALANCE_CREDITS=100000 (high, so the daily-cap gates
// fire before the hard ceiling).
//
// Requirements: BUDGET-01, PLAT-02 (D-01 shared budget envelope).

import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";

const { db } = await import("../../src/lib/server/db/client.js");
const { socialProviderSpend, socialProviderBalance } =
  await import("../../src/lib/server/db/schema/index.js");
const { reserveSocialCredits, getSocialThrottleState, resetSocialDailyCap, todayPacific } =
  await import("../../src/lib/sources/instagram/server/quota.js");

const PROVIDER = "scrapecreators";

/** Seed a platform's pool counter directly so a test can park usage. */
async function seedSpend(
  platform: string,
  pool: "cron" | "user",
  credits: number,
): Promise<void> {
  await db
    .insert(socialProviderSpend)
    .values({
      datePacific: todayPacific(),
      platform,
      provider: PROVIDER,
      poolKind: pool,
      creditsUsed: credits,
    })
    .onConflictDoUpdate({
      target: [
        socialProviderSpend.datePacific,
        socialProviderSpend.platform,
        socialProviderSpend.provider,
        socialProviderSpend.poolKind,
      ],
      set: { creditsUsed: credits },
    });
}

async function seedBalance(credits: number): Promise<void> {
  await db
    .insert(socialProviderBalance)
    .values({ provider: PROVIDER, prepaidBalanceCredits: credits })
    .onConflictDoUpdate({
      target: [socialProviderBalance.provider],
      set: { prepaidBalanceCredits: credits },
    });
}

async function readPlatformPool(
  platform: string,
  pool: "cron" | "user",
): Promise<number> {
  const rows = await db
    .select({ used: socialProviderSpend.creditsUsed })
    .from(socialProviderSpend)
    .where(
      and(
        eq(socialProviderSpend.datePacific, todayPacific()),
        eq(socialProviderSpend.platform, platform),
        eq(socialProviderSpend.provider, PROVIDER),
        eq(socialProviderSpend.poolKind, pool),
      ),
    );
  return rows.length > 0 ? Number(rows[0]!.used) : 0;
}

beforeEach(async () => {
  await resetSocialDailyCap();
});

describe("D-01: ONE joint daily cap across all ScrapeCreators platforms (BUDGET-01)", () => {
  it("[review] Instagram spend at 60% of cap + TikTok at 35% denies the next TikTok reservation by the JOINT 95% gate", async () => {
    // The objective's scenario: IG already at 60 credits, TikTok at 35 → joint
    // total = 95 (the 95% band). Neither platform alone is at 95, but the SHARED
    // cap is — so a further TikTok reservation that would push the JOINT total
    // over 95 MUST be refused. A per-platform cap would (wrongly) allow it
    // because TikTok's own counter is only at 35/100.
    await seedSpend("instagram", "cron", 60);
    await seedSpend("tiktok", "cron", 35);
    await seedBalance(100000);

    // Joint throttle state reads 'ninetyfive' from TikTok's vantage point even
    // though TikTok itself only spent 35 — the band is provider-wide.
    expect(await getSocialThrottleState("tiktok", PROVIDER)).toBe("ninetyfive");
    // And Instagram sees the SAME joint state (one cap, two platforms).
    expect(await getSocialThrottleState("instagram", PROVIDER)).toBe("ninetyfive");

    // A TikTok reservation that would push the joint total to 96 is refused.
    const denied = await reserveSocialCredits({
      platform: "tiktok",
      provider: PROVIDER,
      origin: "cron",
      units: 1,
    });
    expect(denied).toBeNull();
    // TikTok's own counter is untouched — nothing was spent.
    expect(await readPlatformPool("tiktok", "cron")).toBe(35);
  });

  it("[review] a TikTok reservation is refused once Instagram spend alone fills the JOINT cron pool", async () => {
    // Instagram fills the joint cron pool (limit 80) by itself. TikTok has spent
    // nothing, yet its cron reservation is refused because the cron POOL envelope
    // is shared across platforms — IG already used it all.
    await seedSpend("instagram", "cron", 80);
    await seedBalance(100000);

    expect(await readPlatformPool("tiktok", "cron")).toBe(0);

    const tiktokCronDenied = await reserveSocialCredits({
      platform: "tiktok",
      provider: PROVIDER,
      origin: "cron",
      units: 1,
    });
    expect(tiktokCronDenied).toBeNull();

    // But TikTok can still use the (joint) USER pool — IG only consumed the cron
    // pool, so the 20-credit user pool has headroom (80/100 total → 'eighty').
    expect(await getSocialThrottleState("tiktok", PROVIDER)).toBe("eighty");
    const tiktokUserAllowed = await reserveSocialCredits({
      platform: "tiktok",
      provider: PROVIDER,
      origin: "user",
      units: 1,
    });
    expect(tiktokUserAllowed).not.toBeNull();
    // The spend lands on TikTok's OWN counter (per-platform attribution survives).
    expect(await readPlatformPool("tiktok", "user")).toBe(1);
    expect(await readPlatformPool("instagram", "user")).toBe(0);
  });

  it("[review] joint total below the bands lets both platforms reserve (no false denial)", async () => {
    // Sanity: when the COMBINED spend is well under cap, neither platform is
    // throttled and both reserve freely — the joint cap doesn't over-deny.
    await seedSpend("instagram", "user", 5);
    await seedBalance(100000);

    expect(await getSocialThrottleState("tiktok", PROVIDER)).toBe("ok");
    const tiktok = await reserveSocialCredits({
      platform: "tiktok",
      provider: PROVIDER,
      origin: "user",
      units: 3,
    });
    expect(tiktok).not.toBeNull();
    // Joint user-pool usage is now 5 (IG) + 3 (TikTok) = 8, still under the 20
    // user-pool limit and the 80 eighty band → still 'ok'.
    expect(await getSocialThrottleState("instagram", PROVIDER)).toBe("ok");
  });
});
