// Operator prepaid-credit budget: reserve-before-HTTP, 80/95 throttle lanes,
// and the prepaid balance as the absolute hard ceiling that does NOT reset at
// the daily-cap reset (D-16 / Pitfall 3). Mirrors the YouTube quota model with
// retargeted (prepaid-credit) semantics. Integration test — real Postgres via
// ./helpers.js; no provider HTTP is issued (this exercises the budget engine
// directly).
//
// Requirements: BUDGET-01, BUDGET-02.
//
// Daily cap is 100 in the test env (tests/setup.ts): eighty=80, ninetyfive=95,
// cron pool=80, user pool=20. Prepaid balance defaults high (100000) so the
// pool/throttle gates fire first; the hard-ceiling test writes a small balance
// row directly to assert the "cannot spend what isn't there" path.

import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";

const { db } = await import("../../src/lib/server/db/client.js");
const { socialProviderSpend, socialProviderBalance } =
  await import("../../src/lib/server/db/schema/index.js");
const {
  reserveSocialCredits,
  getSocialThrottleState,
  getSocialSpendToday,
  resetSocialDailyCap,
  todayPacific,
} = await import("../../src/lib/sources/instagram/server/quota.js");

const PLATFORM = "instagram";
const PROVIDER = "scrapecreators";

async function readBalance(): Promise<number | null> {
  const rows = await db
    .select({ balance: socialProviderBalance.prepaidBalanceCredits })
    .from(socialProviderBalance)
    .where(
      and(
        eq(socialProviderBalance.platform, PLATFORM),
        eq(socialProviderBalance.provider, PROVIDER),
      ),
    );
  return rows.length > 0 ? Number(rows[0]!.balance) : null;
}

async function readPoolUsed(pool: "cron" | "user"): Promise<number> {
  const rows = await db
    .select({ used: socialProviderSpend.creditsUsed })
    .from(socialProviderSpend)
    .where(
      and(
        eq(socialProviderSpend.datePacific, todayPacific()),
        eq(socialProviderSpend.platform, PLATFORM),
        eq(socialProviderSpend.provider, PROVIDER),
        eq(socialProviderSpend.poolKind, pool),
      ),
    );
  return rows.length > 0 ? Number(rows[0]!.used) : 0;
}

/** Seed today's counters directly so a test can park usage at a chosen level. */
async function seedPoolUsed(pool: "cron" | "user", credits: number): Promise<void> {
  await db
    .insert(socialProviderSpend)
    .values({
      datePacific: todayPacific(),
      platform: PLATFORM,
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

/** Seed the prepaid balance row directly (the hard-ceiling tests use this). */
async function seedBalance(credits: number): Promise<void> {
  await db
    .insert(socialProviderBalance)
    .values({ platform: PLATFORM, provider: PROVIDER, prepaidBalanceCredits: credits })
    .onConflictDoUpdate({
      target: [socialProviderBalance.platform, socialProviderBalance.provider],
      set: { prepaidBalanceCredits: credits },
    });
}

beforeEach(() => {
  // Clear the module-level audit-emission + balance-exhausted guards so each
  // test starts from a clean slate (the afterEach TRUNCATE clears the rows).
  resetSocialDailyCap();
});

describe("social provider budget + throttle (prepaid credits)", () => {
  it("reserve decrements BOTH the daily counter and the prepaid balance (reserve-before-fetch)", async () => {
    const permit = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "user",
      units: 3,
    });
    expect(permit).not.toBeNull();
    expect(permit!.poolKind).toBe("user");
    expect(permit!.units).toBe(3);

    // Daily counter incremented on the user pool.
    expect(await readPoolUsed("user")).toBe(3);
    // Prepaid balance decremented from the env default (100000) by the units.
    expect(await readBalance()).toBe(100000 - 3);
  });

  it("at >= 80% the cron pool can't reserve but the user pool can", async () => {
    // Park cron usage at the cron pool limit (80) so the next cron reservation
    // exceeds it; the user pool (limit 20) is untouched.
    await seedPoolUsed("cron", 80);
    await seedBalance(100000);

    const cronDenied = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "cron",
      units: 1,
    });
    expect(cronDenied).toBeNull();

    const userAllowed = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "user",
      units: 1,
    });
    expect(userAllowed).not.toBeNull();

    // Throttle state is 'eighty' at 80/100 total.
    expect(await getSocialThrottleState(PLATFORM, PROVIDER)).toBe("eighty");
  });

  it("at >= 95% only further user-pool reservations within the cap proceed; total over 95% is refused", async () => {
    // Total daily spend at 95 → ninetyfive throttle; any reservation that would
    // push total over the 95% threshold is refused regardless of origin.
    await seedPoolUsed("cron", 80);
    await seedPoolUsed("user", 15);
    await seedBalance(100000);

    expect(await getSocialThrottleState(PLATFORM, PROVIDER)).toBe("ninetyfive");

    // A further reservation that would exceed 95 total is refused (cron pool is
    // already full AND total+units > 95).
    const denied = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "user",
      units: 1,
    });
    expect(denied).toBeNull();
  });

  it("returns null when the prepaid balance is below the units requested (hard ceiling, D-16)", async () => {
    // Fresh day, no daily-cap pressure, but the funded balance is tiny.
    await seedBalance(2);

    const denied = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "user",
      units: 5,
    });
    expect(denied).toBeNull();
    // Balance untouched — nothing was spent.
    expect(await readBalance()).toBe(2);
    // Daily counter untouched too.
    expect(await readPoolUsed("user")).toBe(0);

    // An affordable reservation still proceeds.
    const ok = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "user",
      units: 2,
    });
    expect(ok).not.toBeNull();
    expect(await readBalance()).toBe(0);
  });

  it("an exhausted prepaid balance (<= 0) reports 'ninetyfive' regardless of the daily counter", async () => {
    await seedBalance(0);
    // Daily counter is well under any threshold...
    await seedPoolUsed("cron", 1);
    // ...but a zero funded balance is a full stop.
    expect(await getSocialThrottleState(PLATFORM, PROVIDER)).toBe("ninetyfive");
  });

  it("resetSocialDailyCap zeroes the daily counter but the prepaid balance is UNCHANGED (Pitfall 3)", async () => {
    // Spend some credits → both the counter and the balance move.
    await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "cron",
      units: 10,
    });
    const balanceBefore = await readBalance();
    expect(balanceBefore).toBe(100000 - 10);
    expect(await readPoolUsed("cron")).toBe(10);

    // Simulate the midnight-Pacific cron firing the NEXT Pacific day so the
    // reset seeds a fresh zero counter for the new day (it must not refill the
    // balance).
    const tomorrow = new Date(Date.now() + 26 * 60 * 60 * 1000);
    await resetSocialDailyCap(tomorrow);

    // The prepaid balance is the monotonic hard ceiling — NEVER refilled.
    expect(await readBalance()).toBe(balanceBefore);

    // The new day's counter starts at zero (the reset seeded a fresh row).
    const tomorrowUsed = await db
      .select({ used: socialProviderSpend.creditsUsed })
      .from(socialProviderSpend)
      .where(
        and(
          eq(socialProviderSpend.datePacific, todayPacific(tomorrow)),
          eq(socialProviderSpend.platform, PLATFORM),
          eq(socialProviderSpend.provider, PROVIDER),
          eq(socialProviderSpend.poolKind, "cron"),
        ),
      );
    expect(Number(tomorrowUsed[0]!.used)).toBe(0);
  });

  it("BUDGET-02: a backfill-style cron reservation is refused once the cron pool is at the 80% throttle", async () => {
    // The cron pool funds background/backfill work (D-17). At >= 80% the cron
    // pool is full, so a backfill continuation page cannot reserve.
    await seedPoolUsed("cron", 80);
    await seedBalance(100000);

    const backfillDenied = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "cron",
      units: 1,
    });
    expect(backfillDenied).toBeNull();
  });

  it("getSocialSpendToday surfaces both the daily-cap view and the funded balance view (D-23)", async () => {
    await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "user",
      units: 7,
    });
    const view = await getSocialSpendToday(PLATFORM, PROVIDER);
    expect(view.creditsUsed).toBe(7);
    expect(view.dailyCap).toBe(100);
    expect(view.prepaidBalance).toBe(100000 - 7);
  });
});
