// Phase 3.0 Plan 03 — YouTube Data API v3 service-quota tracker (D-13 + Pattern 4).
//
// Operator-side counter: YouTube quota is per-API-key, per-Pacific-day, NOT
// per-tenant. Multiple users sharing one operator API key share the same
// 10 000 unit/day budget. This module is the single accounting surface:
//
//   - `pickKeyForJob`         round-robin across SERVICE_YOUTUBE_API_KEYS
//   - `incrementUsage`        UPSERT-counter per (date_pacific, api_key_id)
//   - `getThrottleState`      at-enqueue gate: 'ok' | 'eighty' | 'ninetyfive'
//   - `markThrottleTransition` idempotent audit row when threshold first crossed
//   - `todayPacific`          'YYYY-MM-DD' in America/Los_Angeles (Google's reset boundary)
//   - `hashApiKeyId`          sha-8 of the API key string (stable identifier)
//   - `resetThrottleState`    midnight-Pacific reset hook (Plan 03.0-09 cron)
//
// Consumers (Plan 03.0-04 / 06 / 09):
//   - youtube-channel-adapter   (pickKeyForJob per HTTP call)
//   - youtube-snapshot-writer   (incrementUsage in same tx as snapshot insert)
//   - scheduler enqueue         (getThrottleState — pause Cold/auto-import at 80%)
//   - quota_reset cron          (resetThrottleState at 00:01 Pacific daily)
//
// Pitfall D — YouTube quota resets at midnight America/Los_Angeles, which floats
// across UTC 7h/8h depending on DST. We compute the "today" key with Intl in
// the LA zone so DST transitions are handled by the runtime, not by us.
//
// Threshold values (D-13):
//   - 80% (>= 8000 units on any key) → throttle 'eighty':
//       scheduler pauses Cold-tier polls + auto-import; refresh-now still works.
//   - 95% (>= 9500 units on any key) → throttle 'ninetyfive':
//       scheduler pauses everything except refresh-now; safety margin to avoid
//       the hard 10 000 ceiling that would 403 every subsequent call.
//
// Idempotent audit transition: a per-day Set in module-level state guards
// re-emission within one container lifetime; a defense-in-depth audit_log
// query handles container restarts. The cron quota_reset clears the Set at
// midnight Pacific.

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { youtubeServiceQuotaUsage } from "../db/schema/index.js";
import { auditLog } from "../db/schema/audit-log.js";
import { user } from "../db/schema/auth.js";
import { env } from "../config/env.js";

// Drizzle's transaction generic surface. Same pattern as services/quota.ts —
// avoids leaking PgTransaction's huge type parameter list across the public
// function signature.
type DbCtx = typeof db | Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

export type ThrottleState = "ok" | "eighty" | "ninetyfive";

export interface PickedKey {
  /** The actual YouTube API key string — passed to fetch(); never logged. */
  apiKey: string;
  /** sha-8 of `apiKey` — what we store in youtube_service_quota_usage and surface in /admin/quota. */
  apiKeyId: string;
}

/** D-13 threshold — 80% of YouTube's 10 000 units/key/day budget. */
export const THROTTLE_EIGHTY_THRESHOLD = 8000;

/** D-13 threshold — 95% of YouTube's 10 000 units/key/day budget (hard-pause boundary). */
export const THROTTLE_NINETYFIVE_THRESHOLD = 9500;

/**
 * D-NEW idempotency — module-level audit-emission guard. Map<date_pacific,
 * Set<state>>. Resets on container restart; cron `youtube.quota_reset` clears
 * at midnight Pacific via `resetThrottleState`. Defense-in-depth: a prior-emit
 * lookup against audit_log handles the container-restart case where the Set
 * is empty but the row was already written today.
 */
const auditedTransitions = new Map<string, Set<"eighty" | "ninetyfive">>();

/**
 * Round-robin index into env.SERVICE_YOUTUBE_API_KEYS. Module-level so cycling
 * persists across calls within one worker process. Reset by quota_reset cron.
 */
let roundRobinIdx = 0;

/**
 * Cached operator user_id resolved from ADMIN_EMAIL_ALLOWLIST[0]. `undefined`
 * = not yet resolved; `null` = resolved-and-empty (no allowlist or no matching
 * user row). Container restart re-resolves.
 */
let cachedOperatorId: string | null | undefined;

/**
 * D-13 — sha-8 of the API key string. Stable across boots; what we store as
 * the row identifier in youtube_service_quota_usage. Collision-free at indie
 * scale (operator may have 1-3 keys per day, not millions).
 */
export function hashApiKeyId(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 8);
}

/**
 * Compute the value to send on the `quotaUser` URL parameter for every
 * YouTube Data API request — Google's anti-burst rate-limiter shard key.
 *
 * NOT a per-user quota allocation. The 10000 units/day envelope is shared
 * across all our users on the operator's keys; this function is purely
 * for Google's short-burst rate limiter, NOT for our daily-budget tracking.
 *
 * What it's for: Google groups concurrent API requests by fingerprint
 * (IP + API key + optional `quotaUser`) into one short-burst token bucket.
 * Without `quotaUser`, 50 concurrent worker pollings from our single
 * backend IP look like ONE greedy client and Google 403s half of them
 * with `userRateLimitExceeded` — even though we're nowhere near the
 * daily envelope. Sending `quotaUser=<stable per-user hash>` makes
 * Google see 50 distinct fingerprints, so each user's burst is shaped
 * independently and the daily envelope is the only ceiling that matters.
 *
 * Where it's substituted: caller side. Every YouTube Data API URL we
 * build (worker handlers poll-active / poll-cold / channel-context-
 * backfill, services/youtube-metadata, integrations/youtube-channel-
 * adapter) calls this helper and sets `?quotaUser=<value>` on the URL.
 *
 * Properties:
 *   - Stable across requests for the same user (deterministic sha-256).
 *   - Privacy-safe: 8 hex of sha-256 doesn't leak the userId.
 *   - Distinct from hashApiKeyId(apiKey) which produces the row-identifier
 *     for OUR `youtube_service_quota_usage` table — same hash function,
 *     different input, different downstream system.
 */
export function youtubeQuotaUser(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 8);
}

/**
 * D-13 — round-robin pick across SERVICE_YOUTUBE_API_KEYS. Returns null if
 * the env list is empty (auto-import + scheduled polling disabled — caller
 * decides what to do; typical handling is `auto_import.deferred` audit + skip).
 */
export function pickKeyForJob(): PickedKey | null {
  const keys = env.SERVICE_YOUTUBE_API_KEYS;
  if (keys.length === 0) return null;
  const apiKey = keys[roundRobinIdx % keys.length]!;
  roundRobinIdx = (roundRobinIdx + 1) % keys.length;
  return { apiKey, apiKeyId: hashApiKeyId(apiKey) };
}

/**
 * Pitfall D — YouTube quota resets at midnight America/Los_Angeles. Returns
 * 'YYYY-MM-DD' in PT. sv-SE locale gives ISO-shape output without manual
 * formatting; Intl handles DST transitions automatically.
 */
export function todayPacific(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * D-13 — UPSERT (date_pacific, api_key_id) += units. Idempotent at the row
 * level: the composite PK plus `ON CONFLICT DO UPDATE SET estimated_units =
 * estimated_units + EXCLUDED.units` makes concurrent increments race-safe in
 * Postgres.
 *
 * Caller passes `tx` when the increment must commit/rollback with a snapshot
 * insert (Plan 03.0-04 — atomic counter increment). Standalone calls (e.g.
 * channel-context adapter) omit `tx` and run on the top-level pool.
 */
export async function incrementUsage(args: {
  apiKeyId: string;
  units: number;
  tx?: DbCtx;
}): Promise<void> {
  const datePacific = todayPacific();
  const dbCtx = args.tx ?? db;
  await dbCtx
    .insert(youtubeServiceQuotaUsage)
    .values({
      datePacific,
      apiKeyId: args.apiKeyId,
      estimatedUnits: args.units,
    })
    .onConflictDoUpdate({
      target: [youtubeServiceQuotaUsage.datePacific, youtubeServiceQuotaUsage.apiKeyId],
      set: {
        estimatedUnits: sql`${youtubeServiceQuotaUsage.estimatedUnits} + ${args.units}`,
        updatedAt: new Date(),
      },
    });
}

/**
 * D-13 — at-enqueue scheduler check. Returns the WORST state across all keys
 * for today: any key at 95% pauses everything; any key at 80% pauses Cold +
 * auto-import. The scheduler short-circuits BEFORE enqueueing the job, so
 * over-budget calls never reach pickKeyForJob.
 */
export async function getThrottleState(now: Date = new Date()): Promise<ThrottleState> {
  const datePacific = todayPacific(now);
  const rows = await db
    .select({ units: youtubeServiceQuotaUsage.estimatedUnits })
    .from(youtubeServiceQuotaUsage)
    .where(sql`${youtubeServiceQuotaUsage.datePacific} = ${datePacific}`);
  if (rows.length === 0) return "ok";
  const max = Math.max(...rows.map((r) => r.units));
  if (max >= THROTTLE_NINETYFIVE_THRESHOLD) return "ninetyfive";
  if (max >= THROTTLE_EIGHTY_THRESHOLD) return "eighty";
  return "ok";
}

/**
 * D-13 — write audit `quota.service_throttled` ONCE per (date_pacific, state).
 *
 * Idempotency layered:
 *   1. Module-level Set — fast path within container lifetime.
 *   2. audit_log lookup — handles container restart (Set is empty but the row
 *      already exists for today).
 *
 * The audit row carries a real user_id (audit_log.user_id is NOT NULL — a
 * Phase 02.2 invariant). We resolve to ADMIN_EMAIL_ALLOWLIST[0]'s user record
 * — that's the canonical operator identity for SaaS / single-admin self-host.
 * If the allowlist is empty OR the email has no user row yet (operator hasn't
 * signed in), we log a warn and skip the audit; the throttle state itself
 * still applies via getThrottleState. Self-host parity holds: operators
 * without an admin allowlist simply never see the audit row — and they
 * cannot view /admin/quota anyway, so the absence is moot.
 */
export async function markThrottleTransition(args: {
  state: "eighty" | "ninetyfive";
  // Optional: a real 8-char SHA-8 of the API key that triggered the
  // detection (worker-context — we know which key was just used).
  // The scheduler-tick path sees the threshold cross via the AGGREGATE
  // counter across all keys, so it has no single key to attribute —
  // omit the field rather than emit a synthetic placeholder. Audit
  // metadata stays honest about the source.
  apiKeyId?: string;
  estimatedUnits: number;
}): Promise<void> {
  const datePacific = todayPacific();
  const seen = auditedTransitions.get(datePacific) ?? new Set<"eighty" | "ninetyfive">();
  if (seen.has(args.state)) return;

  // Defense in depth — handles container restart where the Set is empty but
  // the row was already written earlier today.
  //
  // ESLint tenant-scope-eslint-rule: this audit_log lookup is INTENTIONALLY
  // not user-id scoped. quota.service_throttled is a system-emitted (operator)
  // audit row; the (date_pacific, state) composite is the natural idempotency
  // key — adding a userId filter here would defeat the cross-restart guard.
  // The row IS still written under a real operator user_id by writeAudit
  // below (Phase 02.2 audit_log.user_id NOT NULL contract holds).
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
    const { logger } = await import("../logger.js");
    logger.warn(
      { datePacific, state: args.state },
      "quota.service_throttled threshold crossed but no operator user_id resolvable",
    );
    seen.add(args.state);
    auditedTransitions.set(datePacific, seen);
    return;
  }

  const { writeAudit } = await import("../audit.js");
  await writeAudit({
    userId: operatorId,
    action: "quota.service_throttled",
    // No real client IP — this is a system-emitted audit (cron-context). Use
    // the loopback sentinel; consistent with other system-emitted audit rows.
    ipAddress: "127.0.0.1",
    metadata: {
      date_pacific: datePacific,
      state: args.state,
      // Omit api_key_id entirely when the caller has no specific key to
      // attribute (scheduler-tick path). A literal "scheduler-tick" string
      // would be synthetic noise — admins reading /admin/quota would
      // mistake it for a hashed key id.
      ...(args.apiKeyId !== undefined ? { api_key_id: args.apiKeyId } : {}),
      estimated_units: args.estimatedUnits,
    },
  });

  seen.add(args.state);
  auditedTransitions.set(datePacific, seen);
}

/**
 * Called by the youtube.quota_reset cron handler (Plan 03.0-09) at midnight
 * Pacific. Clears the audit-emission gate and resets the round-robin index so
 * a fresh day starts with predictable behaviour. Also drops the cached
 * operator id so a mid-day allowlist change picks up on next emission.
 */
export function resetThrottleState(): void {
  auditedTransitions.clear();
  roundRobinIdx = 0;
  cachedOperatorId = undefined;
}

/**
 * Resolve operator's user_id by email — picks ADMIN_EMAIL_ALLOWLIST[0] as
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
