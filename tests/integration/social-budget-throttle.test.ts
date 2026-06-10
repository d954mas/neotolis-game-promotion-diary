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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { seedUserDirectly } from "./helpers.js";

const { db } = await import("../../src/lib/server/db/client.js");
const { socialProviderSpend, socialProviderBalance } =
  await import("../../src/lib/server/db/schema/index.js");
const { auditLog } = await import("../../src/lib/server/db/schema/audit-log.js");
const { env } = await import("../../src/lib/server/config/env.js");
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
  // The prepaid balance is keyed by PROVIDER only now (D-01 shared ceiling) —
  // no platform predicate.
  const rows = await db
    .select({ balance: socialProviderBalance.prepaidBalanceCredits })
    .from(socialProviderBalance)
    .where(eq(socialProviderBalance.provider, PROVIDER));
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
    .values({ provider: PROVIDER, prepaidBalanceCredits: credits })
    .onConflictDoUpdate({
      target: [socialProviderBalance.provider],
      set: { prepaidBalanceCredits: credits },
    });
}

beforeEach(async () => {
  // Clear the module-level audit-emission + balance-exhausted guards so each
  // test starts from a clean slate (the afterEach TRUNCATE clears the rows).
  await resetSocialDailyCap();
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

// reserveSocialCredits wires the operator audit hooks: a reservation that
// CROSSES into the 80% / 95% daily-cap band writes social.provider_throttled; a
// reservation that exhausts the prepaid balance writes social.budget_exhausted.
// Daily cap is 100 in the test env → eighty=80, ninetyfive=95, cron pool=80,
// user pool=20.
describe("social provider budget + throttle — operator audit hooks (F4)", () => {
  // ADMIN_EMAIL_ALLOWLIST is parsed (and the operator id cached) at env-load
  // time; CI boots with an empty allowlist so the audit fns no-op without a
  // resolvable operator. Mutate the live Set + clear the resolver cache (via
  // resetSocialDailyCap) so the operator resolves to a seeded user — then the
  // audit row actually lands and the WIRING is observable.
  const allowlistMut = env as { ADMIN_EMAIL_ALLOWLIST: Set<string> };
  let originalAllowlist: Set<string>;
  const OPERATOR_EMAIL = "op-social-audit@test.local";

  async function seedOperator(): Promise<void> {
    await seedUserDirectly({ email: OPERATOR_EMAIL });
    allowlistMut.ADMIN_EMAIL_ALLOWLIST = new Set([OPERATOR_EMAIL]);
    // Clear the cached operator id + audit-emission guards so the resolver
    // re-resolves against the mutated allowlist for this test.
    await resetSocialDailyCap();
  }

  async function countAudit(action: string): Promise<number> {
    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(sql`${auditLog.action} = ${action}`);
    return rows.length;
  }

  beforeEach(() => {
    originalAllowlist = env.ADMIN_EMAIL_ALLOWLIST;
  });
  afterEach(() => {
    allowlistMut.ADMIN_EMAIL_ALLOWLIST = originalAllowlist;
  });

  it("a reservation that crosses 80% writes ONE social.provider_throttled audit row (state=eighty)", async () => {
    await seedOperator();
    // Park cron usage at 79 so a cron reservation of 1 lands total at 80 (= the
    // eighty band). Cron pool limit is 80 → 79+1=80 is allowed.
    await seedPoolUsed("cron", 79);
    await seedBalance(100000);
    expect(await countAudit("social.provider_throttled")).toBe(0);

    const permit = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "cron",
      units: 1,
    });
    expect(permit).not.toBeNull();

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        sql`${auditLog.action} = 'social.provider_throttled'
          AND ${auditLog.metadata}->>'state' = 'eighty'
          AND ${auditLog.metadata}->>'platform' = ${PLATFORM}
          AND ${auditLog.metadata}->>'provider' = ${PROVIDER}`,
      );
    expect(rows).toHaveLength(1);
    expect((rows[0]!.metadata as { date_pacific?: string }).date_pacific).toBe(todayPacific());
    expect(await getSocialThrottleState(PLATFORM, PROVIDER)).toBe("eighty");
  });

  it("a reservation that crosses 95% writes social.provider_throttled (state=ninetyfive)", async () => {
    await seedOperator();
    // Total at 94 (cron 80 + user 14); a user reservation of 1 lands total at 95
    // (the ninetyfive band). User pool 14+1=15 ≤ 20; total 94+1=95 ≤ 95 allowed.
    await seedPoolUsed("cron", 80);
    await seedPoolUsed("user", 14);
    await seedBalance(100000);

    const permit = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "user",
      units: 1,
    });
    expect(permit).not.toBeNull();

    const rows = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        sql`${auditLog.action} = 'social.provider_throttled'
          AND ${auditLog.metadata}->>'state' = 'ninetyfive'`,
      );
    expect(rows).toHaveLength(1);
  });

  it("a reservation BELOW the 80% band writes NO throttle audit (transition, not every call)", async () => {
    await seedOperator();
    await seedBalance(100000);

    const permit = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "user",
      units: 1,
    });
    expect(permit).not.toBeNull();
    expect(await countAudit("social.provider_throttled")).toBe(0);
  });

  it("a reservation that exhausts the prepaid balance writes ONE social.budget_exhausted audit row", async () => {
    await seedOperator();
    // Balance of exactly 1 → a reservation of 1 lands the balance at 0 (exhausted).
    await seedBalance(1);
    expect(await countAudit("social.budget_exhausted")).toBe(0);

    const permit = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "user",
      units: 1,
    });
    expect(permit).not.toBeNull();
    expect(await readBalance()).toBe(0);

    const rows = await db
      .select()
      .from(auditLog)
      .where(
        sql`${auditLog.action} = 'social.budget_exhausted'
          AND ${auditLog.metadata}->>'platform' = ${PLATFORM}
          AND ${auditLog.metadata}->>'provider' = ${PROVIDER}`,
      );
    expect(rows).toHaveLength(1);
    expect((rows[0]!.metadata as { date_pacific?: string }).date_pacific).toBe(todayPacific());
  });

  it("a reservation that leaves the balance above 0 writes NO budget_exhausted audit", async () => {
    await seedOperator();
    await seedBalance(5);

    const permit = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "user",
      units: 2,
    });
    expect(permit).not.toBeNull();
    expect(await readBalance()).toBe(3);
    expect(await countAudit("social.budget_exhausted")).toBe(0);
  });

  // F3: the in-memory guards must be keyed by platform/provider, not date alone.
  // A SECOND provider crossing the same threshold in the same process (no cron
  // reset between the two) must write its OWN audit row — the first's guard must
  // not suppress it.
  const PROVIDER_B = "providerb";

  it("a second provider crossing 80% in the same process is NOT suppressed by the first's guard", async () => {
    await seedOperator();
    await seedBalance(100000); // PLATFORM/PROVIDER
    await db
      .insert(socialProviderBalance)
      .values({ provider: PROVIDER_B, prepaidBalanceCredits: 100000 })
      .onConflictDoUpdate({
        target: [socialProviderBalance.provider],
        set: { prepaidBalanceCredits: 100000 },
      });
    await seedPoolUsed("cron", 79);
    // Park provider B's cron usage at 79 too (its own counter rows).
    await db
      .insert(socialProviderSpend)
      .values({
        datePacific: todayPacific(),
        platform: PLATFORM,
        provider: PROVIDER_B,
        poolKind: "cron",
        creditsUsed: 79,
      })
      .onConflictDoUpdate({
        target: [
          socialProviderSpend.datePacific,
          socialProviderSpend.platform,
          socialProviderSpend.provider,
          socialProviderSpend.poolKind,
        ],
        set: { creditsUsed: 79 },
      });

    // First provider crosses 80 → one audit row + populates its in-memory guard.
    const a = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "cron",
      units: 1,
    });
    expect(a).not.toBeNull();

    // Second provider crosses 80 in the SAME process (no resetSocialDailyCap
    // between) → must write its OWN row, not be suppressed by provider A's guard.
    const b = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER_B,
      origin: "cron",
      units: 1,
    });
    expect(b).not.toBeNull();

    const rows = await db
      .select({ provider: sql<string>`${auditLog.metadata}->>'provider'` })
      .from(auditLog)
      .where(
        sql`${auditLog.action} = 'social.provider_throttled'
          AND ${auditLog.metadata}->>'state' = 'eighty'
          AND ${auditLog.metadata}->>'platform' = ${PLATFORM}`,
      );
    const providers = new Set(rows.map((r) => r.provider));
    expect(providers.has(PROVIDER)).toBe(true);
    expect(providers.has(PROVIDER_B)).toBe(true);
  });

  it("a second provider exhausting its balance in the same process writes its OWN budget_exhausted row", async () => {
    await seedOperator();
    await seedBalance(1); // PLATFORM/PROVIDER exhausts on a unit-1 reserve
    await db
      .insert(socialProviderBalance)
      .values({ provider: PROVIDER_B, prepaidBalanceCredits: 1 })
      .onConflictDoUpdate({
        target: [socialProviderBalance.provider],
        set: { prepaidBalanceCredits: 1 },
      });

    const a = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER,
      origin: "user",
      units: 1,
    });
    expect(a).not.toBeNull();

    // Provider B exhausts in the SAME process — its own row, not suppressed.
    const b = await reserveSocialCredits({
      platform: PLATFORM,
      provider: PROVIDER_B,
      origin: "user",
      units: 1,
    });
    expect(b).not.toBeNull();

    const rows = await db
      .select({ provider: sql<string>`${auditLog.metadata}->>'provider'` })
      .from(auditLog)
      .where(
        sql`${auditLog.action} = 'social.budget_exhausted'
          AND ${auditLog.metadata}->>'platform' = ${PLATFORM}`,
      );
    const providers = new Set(rows.map((r) => r.provider));
    expect(providers.has(PROVIDER)).toBe(true);
    expect(providers.has(PROVIDER_B)).toBe(true);
  });
});
