// Social-provider prepaid-credit budget tracker (ScrapeCreators today).
//
// Mirrors youtube/server/quota.ts retargeted from "API units that reset daily"
// to "prepaid credits where ONLY the daily cap resets and the prepaid balance
// is the absolute hard ceiling" (D-16, Pitfall 3).
//
// TWO DISTINCT concepts — conflating them is the load-bearing Pitfall 3:
//
//   1. The DAILY-CAP counter (social_provider_spend.credits_used keyed by
//      date_pacific). Gates the 80/95 throttle. RESETS every Pacific day via
//      resetSocialDailyCap (the instagram.quota_reset cron, Plan 05).
//
//   2. The PREPAID BALANCE (social_provider_balance.prepaid_balance_credits, a
//      single running number per (platform, provider)). Decremented on EVERY
//      spend. NEVER reset by the cron — "cannot spend what isn't there". Seeded
//      from env.SOCIAL_PROVIDER_PREPAID_BALANCE_CREDITS on first use.
//
// Exports:
//   - reserveSocialCredits  reserve-before-HTTP, FOR UPDATE, dual-pool + balance
//   - getSocialThrottleState  'ok' | 'eighty' | 'ninetyfive' (worst-of)
//   - getSocialSpendToday   /admin/quota read (spend-vs-cap + prepaid balance)
//   - resetSocialDailyCap   midnight-Pacific cron hook — daily counter ONLY
//   - markSocialThrottleTransition  idempotent social.provider_throttled audit
//   - markSocialBudgetExhausted  one social.budget_exhausted audit on balance==0
//
// Threshold semantics mirror YouTube's 80/95 (D-15): at 'eighty' the scheduler
// pauses non-essential lanes (auto-import, cold re-poll, backfill); at
// 'ninetyfive' everything but user refresh-now pauses. Reserve increments the
// counter BEFORE the HTTP call (reserve-before-fetch) so a failed call
// over-counts our budget but never over-spends the provider — the right bias
// for an operator-owned prepaid pool.

import { and, eq, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { socialProviderSpend, socialProviderBalance } from "$lib/server/db/schema/index.js";
import { auditLog } from "$lib/server/db/schema/audit-log.js";
import { user } from "$lib/server/db/schema/auth.js";
import { env } from "$lib/server/config/env.js";
import { todayPacific } from "$lib/server/dates.js";
import { writeAudit } from "$lib/server/audit.js";
import { logger } from "$lib/server/logger.js";

export { todayPacific };

// Drizzle's transaction generic surface (same pattern as youtube/server/quota.ts).
type DbCtx = typeof db | Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export type SocialThrottleState = "ok" | "eighty" | "ninetyfive";
export type SocialQuotaPool = "cron" | "user";

export interface SocialCreditPermit {
  platform: string;
  provider: string;
  poolKind: SocialQuotaPool;
  units: number;
}

// Thresholds + pool split are derived from env.SOCIAL_PROVIDER_DAILY_CAP_CREDITS
// at CALL TIME (not as frozen module constants) so an operator setting the cap
// — and the integration test stubbing it — both take effect without a re-parse
// of the env module. The cron pool funds background work (D-17), the user pool
// funds user-initiated work; the split is 80/20 of the daily cap.
function dailyCap(): number {
  return env.SOCIAL_PROVIDER_DAILY_CAP_CREDITS;
}
function throttleEighty(): number {
  return Math.floor(dailyCap() * 0.8);
}
function throttleNinetyfive(): number {
  return Math.floor(dailyCap() * 0.95);
}
function cronPoolDaily(): number {
  return Math.floor(dailyCap() * 0.8);
}
function userPoolDaily(): number {
  return dailyCap() - cronPoolDaily();
}

/**
 * Module-level audit-emission guard. Map<date_pacific, Set<state>>. Resets on
 * container restart; the cron clears it at midnight Pacific via
 * resetSocialDailyCap. Defense-in-depth: a prior-emit lookup against audit_log
 * handles the container-restart case where the Set is empty but the row was
 * already written today.
 */
const auditedTransitions = new Map<string, Set<"eighty" | "ninetyfive">>();

/** Module-level guard so social.budget_exhausted emits at most once per process. */
let budgetExhaustedEmitted = false;

/**
 * Cached operator user_id resolved from ADMIN_EMAIL_ALLOWLIST[0]. `undefined` =
 * not yet resolved; `null` = resolved-and-empty (no allowlist or no matching
 * user row). Container restart re-resolves.
 */
let cachedOperatorId: string | null | undefined;

/**
 * Reserve prepaid credits before an upstream provider request.
 *
 * Multi-replica-safe: today's (date_pacific, platform, provider, pool_kind)
 * counter rows are seeded then locked with SELECT ... FOR UPDATE; the prepaid
 * balance row for (platform, provider) is also seeded + locked. The decision is
 * made under the lock, then the daily counter is incremented AND the prepaid
 * balance decremented in the same transaction.
 *
 * Returns `null` (degrade, no over-spend) when EITHER:
 *   - the prepaid balance is below `units` (D-16 hard ceiling), OR
 *   - the chosen pool would exceed its daily limit, OR
 *   - total daily spend would cross the 95% throttle.
 */
export async function reserveSocialCredits(args: {
  platform: string;
  provider: string;
  origin: SocialQuotaPool;
  units: number;
  now?: Date;
}): Promise<SocialCreditPermit | null> {
  if (!Number.isInteger(args.units) || args.units <= 0) {
    throw new Error("Social provider credit units must be a positive integer");
  }

  const datePacific = todayPacific(args.now ?? new Date());
  const { platform, provider, origin } = args;
  const poolLimit = origin === "cron" ? cronPoolDaily() : userPoolDaily();
  const eighty = throttleEighty();
  const ninetyfive = throttleNinetyfive();

  // Threshold-crossing signals computed UNDER the lock (real before/after of THIS
  // reservation) but EMITTED after commit (AGENTS.md item 4 — audit must not
  // block / deadlock the spend path).
  let crossedEighty = false;
  let crossedNinetyfive = false;
  let balanceExhausted = false;
  let totalAfterReserve = 0;

  const run = async (tx: DbCtx): Promise<SocialCreditPermit | null> => {
    // Seed today's counter rows (both pools) + the prepaid balance row.
    await tx
      .insert(socialProviderSpend)
      .values([
        { datePacific, platform, provider, poolKind: "cron" as const, creditsUsed: 0 },
        { datePacific, platform, provider, poolKind: "user" as const, creditsUsed: 0 },
      ])
      .onConflictDoNothing();
    await tx
      .insert(socialProviderBalance)
      .values({
        platform,
        provider,
        prepaidBalanceCredits: env.SOCIAL_PROVIDER_PREPAID_BALANCE_CREDITS,
      })
      .onConflictDoNothing();

    // Lock the prepaid balance row + the two counter rows for this
    // (platform, provider) to serialize concurrent reservations.
    const balanceLocked = await tx.execute<{ prepaid_balance_credits: number }>(sql`
      SELECT prepaid_balance_credits
      FROM ${socialProviderBalance}
      WHERE platform = ${platform} AND provider = ${provider}
      FOR UPDATE
    `);
    const balanceRows =
      (
        balanceLocked as unknown as {
          rows?: Array<{ prepaid_balance_credits: number | string | null }>;
        }
      ).rows ?? [];
    const prepaidBalance = Number(balanceRows[0]?.prepaid_balance_credits ?? 0);

    const spendLocked = await tx.execute<{ pool_kind: SocialQuotaPool; credits_used: number }>(sql`
      SELECT pool_kind, credits_used
      FROM ${socialProviderSpend}
      WHERE date_pacific = ${datePacific} AND platform = ${platform} AND provider = ${provider}
      FOR UPDATE
    `);
    const spendRows =
      (
        spendLocked as unknown as {
          rows?: Array<{ pool_kind: SocialQuotaPool; credits_used: number | string | null }>;
        }
      ).rows ?? [];
    let cronUsed = 0;
    let userUsed = 0;
    for (const row of spendRows) {
      if (row.pool_kind === "cron") cronUsed = Number(row.credits_used ?? 0);
      else if (row.pool_kind === "user") userUsed = Number(row.credits_used ?? 0);
    }
    const poolUsed = origin === "cron" ? cronUsed : userUsed;
    const totalUsed = cronUsed + userUsed;

    // Hard ceiling: never spend more than the funded prepaid balance (D-16).
    if (prepaidBalance < args.units) return null;
    // Pool envelope + 95% throttle gate (mirrors YouTube candidate filter).
    if (poolUsed + args.units > poolLimit) return null;
    if (totalUsed + args.units > ninetyfive) return null;

    // Increment the daily counter AND decrement the prepaid balance in the
    // same tx — reserve-before-HTTP.
    await tx
      .update(socialProviderSpend)
      .set({
        creditsUsed: sql`${socialProviderSpend.creditsUsed} + ${args.units}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(socialProviderSpend.datePacific, datePacific),
          eq(socialProviderSpend.platform, platform),
          eq(socialProviderSpend.provider, provider),
          eq(socialProviderSpend.poolKind, origin),
        ),
      );
    await tx
      .update(socialProviderBalance)
      .set({
        prepaidBalanceCredits: sql`${socialProviderBalance.prepaidBalanceCredits} - ${args.units}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(socialProviderBalance.platform, platform),
          eq(socialProviderBalance.provider, provider),
        ),
      );

    // Compute the daily-cap throttle band crossing + prepaid-balance exhaustion
    // for THIS reservation (before vs after). Emitted after commit below.
    const totalBefore = totalUsed;
    const totalAfter = totalUsed + args.units;
    totalAfterReserve = totalAfter;
    crossedEighty = totalBefore < eighty && totalAfter >= eighty;
    crossedNinetyfive = totalBefore < ninetyfive && totalAfter >= ninetyfive;
    balanceExhausted = prepaidBalance - args.units <= 0;

    return { platform, provider, poolKind: origin, units: args.units };
  };

  // Own transaction always (never an external tx) so the operator audit below is
  // unambiguously post-commit: a caller's tx that later rolled back would persist
  // the audit + trip the in-memory once-per-cycle guards while the spend reverted.
  const permit = await db.transaction(run);

  // Operator audit AFTER commit (a denied reservation returns null and crosses
  // nothing → no-op). Each fn is idempotent per (date, state) / (platform,
  // provider), so a re-cross within the same cycle writes no duplicate row.
  if (permit !== null) {
    if (crossedEighty) {
      await markSocialThrottleTransition({
        platform,
        provider,
        state: "eighty",
        creditsUsed: totalAfterReserve,
      });
    }
    if (crossedNinetyfive) {
      await markSocialThrottleTransition({
        platform,
        provider,
        state: "ninetyfive",
        creditsUsed: totalAfterReserve,
      });
    }
    if (balanceExhausted) {
      await markSocialBudgetExhausted({ platform, provider });
    }
  }

  return permit;
}

/**
 * At-enqueue scheduler check. Worst-of across both pools for today's
 * (platform, provider): >= 95% pauses everything but user refresh-now; >= 80%
 * pauses non-essential lanes. A prepaid balance at or below 0 is treated as a
 * full stop ('ninetyfive') regardless of the daily counter — the funded
 * ceiling is exhausted, so no spend of any origin can proceed.
 */
export async function getSocialThrottleState(
  platform: string,
  provider: string,
  now: Date = new Date(),
): Promise<SocialThrottleState> {
  const datePacific = todayPacific(now);
  const spendRows = await db
    .select({
      credits: sql<number>`SUM(${socialProviderSpend.creditsUsed})::int`,
    })
    .from(socialProviderSpend)
    .where(
      and(
        eq(socialProviderSpend.datePacific, datePacific),
        eq(socialProviderSpend.platform, platform),
        eq(socialProviderSpend.provider, provider),
      ),
    );
  const used = Number(spendRows[0]?.credits ?? 0);

  const balanceRows = await db
    .select({ balance: socialProviderBalance.prepaidBalanceCredits })
    .from(socialProviderBalance)
    .where(
      and(
        eq(socialProviderBalance.platform, platform),
        eq(socialProviderBalance.provider, provider),
      ),
    );
  // A seeded-but-spent balance at <= 0 is a hard stop. An ABSENT balance row
  // means no spend has happened yet → 'ok' (the funded ceiling kicks in on
  // first reservation, which seeds the row from env).
  if (balanceRows.length > 0 && Number(balanceRows[0]!.balance) <= 0) return "ninetyfive";

  if (used >= throttleNinetyfive()) return "ninetyfive";
  if (used >= throttleEighty()) return "eighty";
  return "ok";
}

/**
 * /admin/quota read (Plan 06). Both views are surfaced (D-23): the daily cap
 * view (creditsUsed vs dailyCap) and the funded view (prepaidBalance).
 */
export async function getSocialSpendToday(
  platform: string,
  provider: string,
  now: Date = new Date(),
): Promise<{ creditsUsed: number; dailyCap: number; prepaidBalance: number }> {
  const datePacific = todayPacific(now);
  const spendRows = await db
    .select({ credits: sql<number>`SUM(${socialProviderSpend.creditsUsed})::int` })
    .from(socialProviderSpend)
    .where(
      and(
        eq(socialProviderSpend.datePacific, datePacific),
        eq(socialProviderSpend.platform, platform),
        eq(socialProviderSpend.provider, provider),
      ),
    );
  const balanceRows = await db
    .select({ balance: socialProviderBalance.prepaidBalanceCredits })
    .from(socialProviderBalance)
    .where(
      and(
        eq(socialProviderBalance.platform, platform),
        eq(socialProviderBalance.provider, provider),
      ),
    );
  return {
    creditsUsed: Number(spendRows[0]?.credits ?? 0),
    dailyCap: dailyCap(),
    // The funded balance. Absent row => the operator's configured envelope
    // (nothing has been spent yet).
    prepaidBalance:
      balanceRows.length > 0
        ? Number(balanceRows[0]!.balance)
        : env.SOCIAL_PROVIDER_PREPAID_BALANCE_CREDITS,
  };
}

/**
 * Called by the instagram.quota_reset cron handler at midnight Pacific.
 *
 * Resets the DAILY-CAP machinery ONLY: clears the audit-emission gate so a new
 * day can re-emit throttle transitions, and seeds the new day's counter rows at
 * zero.
 *
 * MUST NOT touch social_provider_balance — the prepaid balance is the
 * monotonic hard ceiling and is NEVER refilled by the cron (Pitfall 3, D-16).
 * The integration test asserts the balance survives this call unchanged.
 */
export async function resetSocialDailyCap(now: Date = new Date()): Promise<void> {
  auditedTransitions.clear();
  budgetExhaustedEmitted = false;
  cachedOperatorId = undefined;
  const datePacific = todayPacific(now);
  // Seed today's counter rows at zero for any (platform, provider) that has a
  // balance row (i.e. has ever spent). New-day rows simply start fresh; old
  // days are left for audit. Deliberately NO write to social_provider_balance.
  const balanceRows = await db
    .select({
      platform: socialProviderBalance.platform,
      provider: socialProviderBalance.provider,
    })
    .from(socialProviderBalance);
  if (balanceRows.length === 0) return;
  await db
    .insert(socialProviderSpend)
    .values(
      balanceRows.flatMap((r) => [
        {
          datePacific,
          platform: r.platform,
          provider: r.provider,
          poolKind: "cron" as const,
          creditsUsed: 0,
        },
        {
          datePacific,
          platform: r.platform,
          provider: r.provider,
          poolKind: "user" as const,
          creditsUsed: 0,
        },
      ]),
    )
    .onConflictDoNothing();
}

/**
 * Write audit `social.provider_throttled` ONCE per (date_pacific, state).
 * Idempotency layered: module-level Set (fast path within container lifetime) +
 * audit_log lookup (handles container restart). Resolves the operator via
 * ADMIN_EMAIL_ALLOWLIST[0] (mirrors youtube markThrottleTransition).
 */
export async function markSocialThrottleTransition(args: {
  platform: string;
  provider: string;
  state: "eighty" | "ninetyfive";
  creditsUsed: number;
}): Promise<void> {
  const datePacific = todayPacific();
  const seen = auditedTransitions.get(datePacific) ?? new Set<"eighty" | "ninetyfive">();
  if (seen.has(args.state)) return;

  // Defense in depth — handles container restart where the Set is empty but
  // the row was already written earlier today.
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- system-emitted operator audit; idempotency key is (date_pacific, platform, provider, state), not user_id
  const priorRows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      sql`${auditLog.action} = 'social.provider_throttled'
        AND ${auditLog.metadata}->>'date_pacific' = ${datePacific}
        AND ${auditLog.metadata}->>'platform' = ${args.platform}
        AND ${auditLog.metadata}->>'provider' = ${args.provider}
        AND ${auditLog.metadata}->>'state' = ${args.state}`,
    )
    .limit(1);
  if (priorRows.length > 0) {
    seen.add(args.state);
    auditedTransitions.set(datePacific, seen);
    return;
  }

  const operatorId = await resolveOperatorUserId();
  if (operatorId === null) {
    logger.warn(
      { datePacific, platform: args.platform, provider: args.provider, state: args.state },
      "social.provider_throttled threshold crossed but no operator user_id resolvable",
    );
    seen.add(args.state);
    auditedTransitions.set(datePacific, seen);
    return;
  }

  await writeAudit({
    userId: operatorId,
    action: "social.provider_throttled",
    ipAddress: "127.0.0.1",
    metadata: {
      date_pacific: datePacific,
      platform: args.platform,
      provider: args.provider,
      state: args.state,
      credits_used: args.creditsUsed,
    },
  });

  seen.add(args.state);
  auditedTransitions.set(datePacific, seen);
}

/**
 * Write audit `social.budget_exhausted` ONCE when the prepaid balance first
 * hits 0. Module-level guard (process lifetime) + audit_log lookup for
 * cross-restart idempotency.
 */
export async function markSocialBudgetExhausted(args: {
  platform: string;
  provider: string;
}): Promise<void> {
  if (budgetExhaustedEmitted) return;
  const datePacific = todayPacific();

  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- system-emitted operator audit; idempotency key is (platform, provider), not user_id
  const priorRows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      sql`${auditLog.action} = 'social.budget_exhausted'
        AND ${auditLog.metadata}->>'platform' = ${args.platform}
        AND ${auditLog.metadata}->>'provider' = ${args.provider}`,
    )
    .limit(1);
  if (priorRows.length > 0) {
    budgetExhaustedEmitted = true;
    return;
  }

  const operatorId = await resolveOperatorUserId();
  if (operatorId === null) {
    logger.warn(
      { platform: args.platform, provider: args.provider },
      "social.budget_exhausted but no operator user_id resolvable",
    );
    budgetExhaustedEmitted = true;
    return;
  }

  await writeAudit({
    userId: operatorId,
    action: "social.budget_exhausted",
    ipAddress: "127.0.0.1",
    metadata: { date_pacific: datePacific, platform: args.platform, provider: args.provider },
  });
  budgetExhaustedEmitted = true;
}

/**
 * Resolve operator's user_id by email — ADMIN_EMAIL_ALLOWLIST[0] is the
 * canonical operator. Cached at module scope (container restart re-resolves).
 * Returns null if the allowlist is empty OR the email has no matching user row.
 */
async function resolveOperatorUserId(): Promise<string | null> {
  if (cachedOperatorId !== undefined) return cachedOperatorId;
  const allowlist = [...env.ADMIN_EMAIL_ALLOWLIST];
  if (allowlist.length === 0) {
    cachedOperatorId = null;
    return null;
  }
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(sql`lower(${user.email}) = ${allowlist[0]}`)
    .limit(1);
  cachedOperatorId = rows[0]?.id ?? null;
  return cachedOperatorId;
}
