// YouTube Data API v3 service-quota tracker.
//
// Operator-side counter: YouTube quota is per-API-key, per-Pacific-day, NOT
// per-tenant. Multiple users sharing one operator API key share the same
// 10 000 unit/day budget. This module is the single accounting surface:
//
//   - `reserveYoutubeQuota`   DB-backed pre-flight quota reservation
//   - `incrementUsage`        legacy UPSERT-counter for caller-side accounting
//   - `getThrottleState`      at-enqueue gate: 'ok' | 'eighty' | 'ninetyfive'
//   - `markThrottleTransition` idempotent audit row when threshold first crossed
//   - `todayPacific`          'YYYY-MM-DD' in America/Los_Angeles (Google's reset boundary)
//   - `hashApiKeyId`          sha-8 of the API key string (stable identifier)
//   - `resetThrottleState`    midnight-Pacific reset hook
//
// Consumers:
//   - $lib/sources/youtube/server/http.ts       (reserveYoutubeQuota before HTTP)
//   - $lib/sources/youtube/server/snapshots.ts  (optional incrementUsage fallback)
//   - src/scheduler/enqueue.ts                   (getThrottleState вЂ” pause Cold/auto-import at 80%)
//   - $lib/sources/youtube/server/handlers/quota-reset.ts (resetThrottleState at 00:01 Pacific daily)
//
// YouTube quota resets at midnight America/Los_Angeles, which floats
// across UTC 7h/8h depending on DST. We compute the "today" key with Intl
// in the LA zone so DST transitions are handled by the runtime, not by
// us.
//
// Threshold values:
//   - 80% (>= 8000 units on any key) в†’ throttle 'eighty':
//       scheduler pauses Cold-tier polls + auto-import; refresh-now still works.
//   - 95% (>= 9500 units on any key) в†’ throttle 'ninetyfive':
//       scheduler pauses everything except refresh-now; safety margin to avoid
//       the hard 10 000 ceiling that would 403 every subsequent call.
//
// Idempotent audit transition: a per-day Set in module-level state guards
// re-emission within one container lifetime; a defense-in-depth audit_log
// query handles container restarts. The cron quota_reset clears the Set at
// midnight Pacific.

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { youtubeServiceQuotaUsage } from "$lib/server/db/schema/index.js";
import { auditLog } from "$lib/server/db/schema/audit-log.js";
import { user } from "$lib/server/db/schema/auth.js";
import { env } from "$lib/server/config/env.js";
import { todayPacific } from "$lib/server/dates.js";
import { writeAudit } from "$lib/server/audit.js";
import { logger } from "$lib/server/logger.js";

export { todayPacific };

// Drizzle's transaction generic surface. Same pattern as services/quota.ts вЂ”
// avoids leaking PgTransaction's huge type parameter list across the public
// function signature.
type DbCtx = typeof db | Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export type ThrottleState = "ok" | "eighty" | "ninetyfive";

export interface PickedKey {
  /** The actual YouTube API key string вЂ” passed to fetch(); never logged. */
  apiKey: string;
  /** sha-8 of `apiKey` вЂ” what we store in youtube_service_quota_usage and surface in /admin/quota. */
  apiKeyId: string;
}

export type YoutubeQuotaPool = "cron" | "user";

export interface YoutubeQuotaPermit extends PickedKey {
  poolKind: YoutubeQuotaPool;
  units: number;
}

/** Threshold вЂ” 80% of YouTube's 10 000 units/key/day budget. */
export const THROTTLE_EIGHTY_THRESHOLD = 8000;

/** Threshold вЂ” 95% of YouTube's 10 000 units/key/day budget (hard-pause boundary). */
export const THROTTLE_NINETYFIVE_THRESHOLD = 9500;

export const YOUTUBE_CRON_POOL_DAILY_LIMIT = 8000;
export const YOUTUBE_USER_POOL_DAILY_LIMIT = 2000;

/**
 * Module-level audit-emission guard. Map<date_pacific, Set<state>>.
 * Resets on container restart; cron `youtube.quota_reset` clears at
 * midnight Pacific via `resetThrottleState`. Defense-in-depth: a
 * prior-emit lookup against audit_log handles the container-restart case
 * where the Set is empty but the row was already written today.
 */
const auditedTransitions = new Map<string, Set<"eighty" | "ninetyfive">>();

/**
 * Cached operator user_id resolved from ADMIN_EMAIL_ALLOWLIST[0]. `undefined`
 * = not yet resolved; `null` = resolved-and-empty (no allowlist or no matching
 * user row). Container restart re-resolves.
 */
let cachedOperatorId: string | null | undefined;

/**
 * sha-8 of the API key string. Stable across boots; what we store as the
 * row identifier in youtube_service_quota_usage. Collision-free at indie
 * scale (operator may have 1-3 keys per day, not millions).
 */
export function hashApiKeyId(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 8);
}

/**
 * Compute the value to send on the `quotaUser` URL parameter for every
 * YouTube Data API request вЂ” Google's anti-burst rate-limiter shard key.
 *
 * NOT a per-user quota allocation. The 10000 units/day envelope is shared
 * across all our users on the operator's keys; this function is purely
 * for Google's short-burst rate limiter, NOT for our daily-budget tracking.
 *
 * What it's for: Google groups concurrent API requests by fingerprint
 * (IP + API key + optional `quotaUser`) into one short-burst token bucket.
 * Without `quotaUser`, 50 concurrent worker pollings from our single
 * backend IP look like ONE greedy client and Google 403s half of them
 * with `userRateLimitExceeded` вЂ” even though we're nowhere near the
 * daily envelope. Sending `quotaUser=<stable per-user hash>` makes
 * Google see 50 distinct fingerprints, so each user's burst is shaped
 * independently and the daily envelope is the only ceiling that matters.
 *
 * Where it's substituted: caller side. Every YouTube Data API URL we
 * build (worker handlers poll-active / poll-cold / channel-context-
 * backfill, $lib/sources/youtube/server/metadata.ts,
 * $lib/sources/youtube/server/adapter.ts) calls this helper and sets
 * `?quotaUser=<value>` on the URL.
 *
 * Properties:
 *   - Stable across requests for the same user (deterministic sha-256).
 *   - Privacy-safe: 8 hex of sha-256 doesn't leak the userId.
 *   - Distinct from hashApiKeyId(apiKey) which produces the row-identifier
 *     for OUR `youtube_service_quota_usage` table вЂ” same hash function,
 *     different input, different downstream system.
 */
export function youtubeQuotaUser(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

export function hasYoutubeApiKeys(): boolean {
  return env.SERVICE_YOUTUBE_API_KEYS.length > 0;
}

function configuredKeys(): PickedKey[] {
  return env.SERVICE_YOUTUBE_API_KEYS.map((apiKey) => ({
    apiKey,
    apiKeyId: hashApiKeyId(apiKey),
  }));
}

/**
 * Reserve quota before an upstream YouTube request.
 *
 * This is the multi-replica-safe budget gate: rows for today's
 * (api_key_id, pool_kind) counters are locked with SELECT ... FOR UPDATE,
 * the best available key is chosen, and the counter is incremented before
 * HTTP starts. Failed network calls may therefore over-count our internal
 * budget, but they never over-burn Google's quota. That is the right bias
 * for an operator-owned shared API envelope.
 */
export async function reserveYoutubeQuota(args: {
  origin: YoutubeQuotaPool;
  units: number;
  now?: Date;
  tx?: DbCtx;
}): Promise<YoutubeQuotaPermit | null> {
  if (!Number.isInteger(args.units) || args.units <= 0) {
    throw new Error("YouTube quota units must be a positive integer");
  }
  const keys = configuredKeys();
  if (keys.length === 0) return null;

  const datePacific = todayPacific(args.now ?? new Date());
  const poolLimit =
    args.origin === "cron" ? YOUTUBE_CRON_POOL_DAILY_LIMIT : YOUTUBE_USER_POOL_DAILY_LIMIT;

  const run = async (tx: DbCtx): Promise<YoutubeQuotaPermit | null> => {
    await tx
      .insert(youtubeServiceQuotaUsage)
      .values(
        keys.flatMap((key) => [
          {
            datePacific,
            apiKeyId: key.apiKeyId,
            poolKind: "cron" as const,
            estimatedUnits: 0,
          },
          {
            datePacific,
            apiKeyId: key.apiKeyId,
            poolKind: "user" as const,
            estimatedUnits: 0,
          },
        ]),
      )
      .onConflictDoNothing();

    const keyIdsSql = sql.join(
      keys.map((key) => sql`${key.apiKeyId}`),
      sql`, `,
    );
    const locked = await tx.execute<{
      api_key_id: string;
      pool_kind: YoutubeQuotaPool;
      estimated_units: number;
    }>(sql`
      SELECT api_key_id, pool_kind, estimated_units
      FROM ${youtubeServiceQuotaUsage}
      WHERE date_pacific = ${datePacific}
        AND api_key_id IN (${keyIdsSql})
      FOR UPDATE
    `);
    const rows =
      (
        locked as unknown as {
          rows?: Array<{
            api_key_id: string;
            pool_kind: YoutubeQuotaPool;
            estimated_units: number | string | null;
          }>;
        }
      ).rows ?? [];

    const usageByKey = new Map<string, { cron: number; user: number }>();
    for (const key of keys) usageByKey.set(key.apiKeyId, { cron: 0, user: 0 });
    for (const row of rows) {
      const usage = usageByKey.get(row.api_key_id);
      if (!usage) continue;
      usage[row.pool_kind] = Number(row.estimated_units ?? 0);
    }

    const candidates = keys
      .map((key) => {
        const usage = usageByKey.get(key.apiKeyId) ?? { cron: 0, user: 0 };
        const poolUsed = usage[args.origin];
        const totalUsed = usage.cron + usage.user;
        return { key, poolUsed, totalUsed };
      })
      .filter(
        (candidate) =>
          candidate.poolUsed + args.units <= poolLimit &&
          candidate.totalUsed + args.units <= THROTTLE_NINETYFIVE_THRESHOLD,
      )
      .sort(
        (a, b) =>
          a.totalUsed - b.totalUsed ||
          a.poolUsed - b.poolUsed ||
          a.key.apiKeyId.localeCompare(b.key.apiKeyId),
      );

    const chosen = candidates[0]?.key;
    if (!chosen) return null;

    await tx
      .update(youtubeServiceQuotaUsage)
      .set({
        estimatedUnits: sql`${youtubeServiceQuotaUsage.estimatedUnits} + ${args.units}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(youtubeServiceQuotaUsage.datePacific, datePacific),
          eq(youtubeServiceQuotaUsage.apiKeyId, chosen.apiKeyId),
          eq(youtubeServiceQuotaUsage.poolKind, args.origin),
        ),
      );

    return {
      ...chosen,
      poolKind: args.origin,
      units: args.units,
    };
  };

  return args.tx ? run(args.tx) : db.transaction(run);
}

/**
 * UPSERT (date_pacific, api_key_id) += units. Idempotent at the row
 * level: the composite PK plus `ON CONFLICT DO UPDATE SET estimated_units =
 * estimated_units + EXCLUDED.units` makes concurrent increments race-safe
 * in Postgres.
 *
 * Caller passes `tx` when the increment must commit/rollback with a
 * snapshot insert (atomic counter increment). Standalone calls (e.g.
 * channel-context adapter) omit `tx` and run on the top-level pool.
 */
export async function incrementUsage(args: {
  apiKeyId: string;
  units: number;
  /**
   * Which origin pool burned the units. Required (no default) so every
   * caller has to choose user-driven or cron-driven accounting explicitly.
   */
  poolKind: "cron" | "user";
  tx?: DbCtx;
}): Promise<void> {
  const datePacific = todayPacific();
  const dbCtx = args.tx ?? db;
  await dbCtx
    .insert(youtubeServiceQuotaUsage)
    .values({
      datePacific,
      apiKeyId: args.apiKeyId,
      poolKind: args.poolKind,
      estimatedUnits: args.units,
    })
    .onConflictDoUpdate({
      target: [
        youtubeServiceQuotaUsage.datePacific,
        youtubeServiceQuotaUsage.apiKeyId,
        youtubeServiceQuotaUsage.poolKind,
      ],
      set: {
        estimatedUnits: sql`${youtubeServiceQuotaUsage.estimatedUnits} + ${args.units}`,
        updatedAt: new Date(),
      },
    });
}

/**
 * At-enqueue scheduler check. Returns the WORST state across all keys for
 * today: any key at 95% pauses everything; any key at 80% pauses Cold +
 * auto-import. The scheduler short-circuits BEFORE enqueueing the job, so
 * over-budget calls never reach upstream HTTP.
 */
export async function getThrottleState(now: Date = new Date()): Promise<ThrottleState> {
  const datePacific = todayPacific(now);
  // Sum across pool_kind per api_key_id. Threshold is per-key daily
  // envelope (10000 units); pool split is an internal budget attribution
  // detail, not a throttle gate. WORST-key (max
  // sum) wins per pre-existing semantics.
  const rows = await db
    .select({
      apiKeyId: youtubeServiceQuotaUsage.apiKeyId,
      units: sql<number>`SUM(${youtubeServiceQuotaUsage.estimatedUnits})::int`,
    })
    .from(youtubeServiceQuotaUsage)
    .where(sql`${youtubeServiceQuotaUsage.datePacific} = ${datePacific}`)
    .groupBy(youtubeServiceQuotaUsage.apiKeyId);
  if (rows.length === 0) return "ok";
  const max = Math.max(...rows.map((r) => Number(r.units ?? 0)));
  if (max >= THROTTLE_NINETYFIVE_THRESHOLD) return "ninetyfive";
  if (max >= THROTTLE_EIGHTY_THRESHOLD) return "eighty";
  return "ok";
}

/**
 * Milliseconds until the next midnight Pacific, YouTube's daily quota reset
 * boundary. Used by queue guards and HTTP error mapping to avoid hammering
 * after the operator budget is exhausted.
 */
export function msUntilMidnightPacific(now = new Date()): number {
  const todayPT = todayPacific(now);
  for (let i = 1; i <= 25; i++) {
    const candidate = new Date(now.getTime() + i * 3_600_000);
    const candidatePT = todayPacific(candidate);
    if (candidatePT !== todayPT) {
      const boundary = new Date(candidate.getTime());
      boundary.setUTCMinutes(0, 0, 0);
      return Math.max(60_000, boundary.getTime() - now.getTime());
    }
  }
  return 3_600_000;
}

/**
 * Write audit `quota.service_throttled` ONCE per (date_pacific, state).
 *
 * Idempotency layered:
 *   1. Module-level Set вЂ” fast path within container lifetime.
 *   2. audit_log lookup вЂ” handles container restart (Set is empty but the row
 *      already exists for today).
 *
 * The audit row carries a real user_id (audit_log.user_id is NOT NULL).
 * We resolve to ADMIN_EMAIL_ALLOWLIST[0]'s user record вЂ” that's the
 * canonical operator identity for SaaS / single-admin self-host.
 * If the allowlist is empty OR the email has no user row yet (operator hasn't
 * signed in), we log a warn and skip the audit; the throttle state itself
 * still applies via getThrottleState. Self-host parity holds: operators
 * without an admin allowlist simply never see the audit row вЂ” and they
 * cannot view /admin/quota anyway, so the absence is moot.
 */
export async function markThrottleTransition(args: {
  state: "eighty" | "ninetyfive";
  // Optional: a real 8-char SHA-8 of the API key that triggered the
  // detection (worker-context вЂ” we know which key was just used).
  // The scheduler-tick path sees the threshold cross via the AGGREGATE
  // counter across all keys, so it has no single key to attribute вЂ”
  // omit the field rather than emit a synthetic placeholder. Audit
  // metadata stays honest about the source.
  apiKeyId?: string;
  estimatedUnits: number;
}): Promise<void> {
  const datePacific = todayPacific();
  const seen = auditedTransitions.get(datePacific) ?? new Set<"eighty" | "ninetyfive">();
  if (seen.has(args.state)) return;

  // Defense in depth вЂ” handles container restart where the Set is empty but
  // the row was already written earlier today.
  //
  // ESLint tenant-scope-eslint-rule: this audit_log lookup is INTENTIONALLY
  // not user-id scoped. quota.service_throttled is a system-emitted (operator)
  // audit row; the (date_pacific, state) composite is the natural idempotency
  // key вЂ” adding a userId filter here would defeat the cross-restart guard.
  // The row IS still written under a real operator user_id by writeAudit
  // below (audit_log.user_id NOT NULL contract holds).
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query
  const priorRows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      sql`${auditLog.action} = 'quota.service_throttled'
        AND ${auditLog.metadata}->>'date_pacific' = ${datePacific}
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
      { datePacific, state: args.state },
      "quota.service_throttled threshold crossed but no operator user_id resolvable",
    );
    seen.add(args.state);
    auditedTransitions.set(datePacific, seen);
    return;
  }

  await writeAudit({
    userId: operatorId,
    action: "quota.service_throttled",
    // No real client IP вЂ” this is a system-emitted audit (cron-context). Use
    // the loopback sentinel; consistent with other system-emitted audit rows.
    ipAddress: "127.0.0.1",
    metadata: {
      date_pacific: datePacific,
      state: args.state,
      // Omit api_key_id entirely when the caller has no specific key to
      // attribute (scheduler-tick path). A literal "scheduler-tick" string
      // would be synthetic noise вЂ” admins reading /admin/quota would
      // mistake it for a hashed key id.
      ...(args.apiKeyId !== undefined ? { api_key_id: args.apiKeyId } : {}),
      estimated_units: args.estimatedUnits,
    },
  });

  seen.add(args.state);
  auditedTransitions.set(datePacific, seen);
}

/**
 * Called by the youtube.quota_reset cron handler at midnight Pacific.
 * Clears the audit-emission gate and resets the round-robin index so
 * a fresh day starts with predictable behaviour. Also drops the cached
 * operator id so a mid-day allowlist change picks up on next emission.
 */
export function resetThrottleState(): void {
  auditedTransitions.clear();
  cachedOperatorId = undefined;
}

/**
 * Resolve operator's user_id by email вЂ” picks ADMIN_EMAIL_ALLOWLIST[0] as
 * canonical operator. Cached at module scope (one-time lookup; container
 * restart re-resolves). Returns null if allowlist is empty OR the email
 * has no matching user row yet.
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
