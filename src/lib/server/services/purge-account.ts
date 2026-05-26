// GDPR Art. 17 60-day-grace hard-delete.
//
// Hard-deletes a soft-deleted user's rows in FK-respecting order in a single
// tx. Two callers:
//
//   1. Cron path (`purge.daily` worker, runs `0 4 * * *` PT after backup):
//      scans `listPurgeEligibleUsers()` and calls `purgeAccount(userId)`
//      per match. Eligibility = `user.deletedAt` older than RETENTION_DAYS.
//   2. CTA path (DELETE /api/me/account/purge from the Permanent-delete-now
//      button on AccountDeletedBanner): calls
//      `purgeAccount(userId, { ignoreRetention: true })` immediately.
//
// Cascade chain (FK-respecting order, single tx):
//   api_keys_steam → event_games → events → game_steam_listings →
//   data_sources → games → session → user
//
// Idempotent: re-running on an already-purged user is a no-op (DELETE WHERE
// finds nothing; row counts are all zero; no error). Audit row written
// OUTSIDE the tx (pool-deadlock-safe pattern from softDeleteAccount). The
// audit row is scoped to the PURGED user_id — preserves the INSERT-only
// invariant + per-tenant cursor invariant; admin sees cross-tenant audit
// list via the /admin/quota allowlist gate, NOT user_id matching.
//
// A historical migration dropped the audit_log.user_id → user(id) FK so
// this audit row survives the user delete.
//
// audit_log rows for the purged user are NOT touched by the cascade
// (preserves the "deletion event remains" contract). Better Auth `account`
// rows (OAuth tokens) are ALSO NOT cascaded — they live under user.id
// { onDelete: cascade } in the schema, so the `user` DELETE in step 8
// takes them down via Postgres FK cascade (no explicit tx step needed).

import { and, eq, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { user, session } from "../db/schema/auth.js";
import { games } from "../db/schema/games.js";
import { gameSteamListings } from "../db/schema/game-steam-listings.js";
import { dataSources } from "../db/schema/data-sources.js";
import { events } from "../db/schema/events.js";
import { eventGames } from "../db/schema/event-games.js";
import { apiKeysSteam } from "../db/schema/api-keys-steam.js";
import { outbox } from "../db/schema/outbox.js";
import { writeAudit } from "../audit.js";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

export interface PurgeOptions {
  /**
   * Bypass the RETENTION_DAYS check (Permanent-delete-now CTA path).
   * When false (cron path), `purgeAccount` returns early without doing
   * anything if `user.deletedAt` is null OR
   * `(now - deletedAt) < RETENTION_DAYS`. The default (false) is the
   * worker-safe path.
   */
  ignoreRetention?: boolean;
  /**
   * IP address to record in the audit row. Defaults to "system" when the
   * cron worker calls without a request context. The CTA route passes
   * the user's real IP from the Hono context.
   */
  ipAddress?: string;
}

export interface PurgeRowCounts {
  apiKeysSteam: number;
  events: number;
  eventGames: number;
  gameSteamListings: number;
  dataSources: number;
  games: number;
  sessions: number;
  user: number;
  /** Outbox rows that referenced the purged user via
   *  payload.triggerUserId, deleted inside the same cascade transaction.
   *  Pending rows (forwarded_at IS NULL) would otherwise be forwarded to
   *  pg-boss AFTER the user row is gone, enqueueing work for a deleted
   *  tenant and breaking the hard-delete contract. Forwarded rows
   *  (forwarded_at IS NOT NULL) are deleted too — they would retain the
   *  purged user_id for up to 7 days under the purge.daily retention
   *  window, violating GDPR Art. 17 for that period. */
  outbox: number;
}

export interface PurgeResult {
  /** false if user not eligible (cron path skip or already-purged). */
  purged: boolean;
  rowCounts?: PurgeRowCounts;
}

/**
 * Hard-delete a user's data in FK-respecting order. Idempotent.
 *
 * @param userId  the tenant whose rows to purge.
 * @param opts.ignoreRetention bypass the 60-day-grace check (CTA path).
 * @param opts.ipAddress       IP to record in the audit row (default "system").
 *
 * @returns {purged: false} if the user is not eligible (cron path: still
 *   within retention; CTA path: cannot return false because retention is
 *   ignored — but DOES return {purged: true, rowCounts: all zeros} if the
 *   user row is already gone, e.g. a re-run after a successful purge).
 */
export async function purgeAccount(userId: string, opts: PurgeOptions = {}): Promise<PurgeResult> {
  const ipAddress = opts.ipAddress ?? "system";

  // Eligibility gate (cron path only). CTA path skips this entirely.
  if (!opts.ignoreRetention) {
    const rows = await db
      .select({ deletedAt: user.deletedAt })
      .from(user)
      .where(eq(user.id, userId));
    const deletedAt = rows[0]?.deletedAt;
    if (!deletedAt) {
      // User row missing OR deletedAt is null — not eligible.
      return { purged: false };
    }
    const ageMs = Date.now() - deletedAt.getTime();
    if (ageMs < env.RETENTION_DAYS * 86_400_000) {
      // Still within the 60-day grace window.
      return { purged: false };
    }
  }

  // FK-respecting cascade DELETE in one tx. Each step is scoped to userId so
  // cross-tenant integrity is preserved by construction. .returning({ id }) is
  // used as the row-count probe (Drizzle has no `rowCount` on delete().returning()
  // — the array length is the count).
  const counts = await db.transaction(async (tx) => {
    // 1. api_keys_steam — children of user only (no events ref). Hard-delete.
    const ak = await tx
      .delete(apiKeysSteam)
      .where(eq(apiKeysSteam.userId, userId))
      .returning({ id: apiKeysSteam.id });

    // 2. event_games — junction with FK to events.id (cascade) and games.id
    //    (cascade); deleting it explicitly keeps the cascade order legible
    //    and ensures we have a real row count for the audit metadata.
    //    user_id is denormalized.
    const eg = await tx
      .delete(eventGames)
      .where(eq(eventGames.userId, userId))
      .returning({ eventId: eventGames.eventId });

    // 3. events — children of user (and of data_sources via ON DELETE SET NULL).
    const ev = await tx
      .delete(events)
      .where(eq(events.userId, userId))
      .returning({ id: events.id });

    // 4. game_steam_listings — children of games + user.
    const gsl = await tx
      .delete(gameSteamListings)
      .where(eq(gameSteamListings.userId, userId))
      .returning({ id: gameSteamListings.id });

    // 5. data_sources — children of user.
    const ds = await tx
      .delete(dataSources)
      .where(eq(dataSources.userId, userId))
      .returning({ id: dataSources.id });

    // 5b. outbox — queue intents that reference this user via
    //     payload.triggerUserId (force-deep enqueues are the only such
    //     payload today). Deleting the user without scrubbing the outbox
    //     would let the forwarder later enqueue a YOUTUBE_BACKFILL_CHANNEL
    //     job with the purged userId, which the worker then audits against
    //     a non-existent tenant. Filter via the JSON ->>'triggerUserId'
    //     accessor — rows whose payload omits the field don't match and
    //     survive.
    const ob = await tx
      .delete(outbox)
      .where(sql`${outbox.payload}->>'triggerUserId' = ${userId}`)
      .returning({ id: outbox.id });

    // 6. games — children of user.
    const g = await tx.delete(games).where(eq(games.userId, userId)).returning({ id: games.id });

    // 7. session — Better Auth (forces logout on any open device).
    const sess = await tx
      .delete(session)
      .where(eq(session.userId, userId))
      .returning({ id: session.id });

    // 8. user — final step. Better Auth's `account` rows (OAuth tokens)
    //    cascade-delete via the schema's onDelete: "cascade" FK on
    //    account.userId, so we don't need an explicit tx step for them.
    //    audit_log rows are NOT cascaded (FK previously dropped).
    const u = await tx.delete(user).where(eq(user.id, userId)).returning({ id: user.id });

    return {
      apiKeysSteam: ak.length,
      events: ev.length,
      eventGames: eg.length,
      gameSteamListings: gsl.length,
      dataSources: ds.length,
      games: g.length,
      sessions: sess.length,
      user: u.length,
      outbox: ob.length,
    } satisfies PurgeRowCounts;
  });

  // Audit OUTSIDE the tx — pool-deadlock-safe pattern. The audit_log user
  // FK was previously dropped so this INSERT succeeds even though the user
  // row is gone. Scoped to the purged user_id.
  await writeAudit({
    userId,
    action: "purge.completed",
    ipAddress,
    metadata: {
      row_counts: counts,
      ignore_retention: opts.ignoreRetention === true,
      purged_at: new Date().toISOString(),
    },
  });

  // Idempotency: re-running on an already-purged user reaches here with all
  // counts at 0. We still emit the audit row so the operator can spot a
  // double-fire in the audit stream. `purged: true` is honest about the fact
  // that the cascade ran (it just had nothing to delete).
  if (counts.user === 0) {
    logger.info(
      { userId, action: "purge.completed", row_counts: counts },
      "purge.completed no-op (idempotent re-run)",
    );
  }

  return { purged: true, rowCounts: counts };
}

/**
 * Cron helper — returns user_ids whose `deletedAt < now - RETENTION_DAYS`.
 * The `purge.daily` worker iterates this list and calls `purgeAccount`
 * per id. Active users (deletedAt IS NULL) are excluded by construction.
 */
export async function listPurgeEligibleUsers(now: Date = new Date()): Promise<string[]> {
  const cutoff = new Date(now.getTime() - env.RETENTION_DAYS * 86_400_000);
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(and(isNotNull(user.deletedAt), lt(user.deletedAt, cutoff)));
  return rows.map((r) => r.id);
}

/**
 * purgeStaleDeletedEvents — hard-deletes events whose deletedAt is older
 * than the configured retention window. Called from the existing Phase 03.0
 * purge.daily cron handler (D-20). NO new cron / queue / handler — one
 * extra step in the existing daily 04:00 PT tick lands in Plan 06.
 *
 * The `retentionDays` parameter MUST match the value used by
 * `listDeletedEvents`, `restoreEvent`, and `listFeedPage(scope="trash")`
 * (all read from `env.RETENTION_DAYS`). The cron caller reads env and
 * passes the value here so the service stays env-read-free (per AGENTS.md
 * — env reads only in config/env.ts, callers pass as parameter).
 *
 * Audit: ONE row per affected user_id (matches purge.completed's
 * "scoped to the purged user_id" pattern, preserving the per-tenant
 * cursor invariant — audit_log readers query by user_id; a cross-tenant
 * audit row would never surface to any user's /audit page and would
 * break per-user cursor pagination). When >100 events purged for a
 * single user the `affected_ids` list is omitted to keep the audit row
 * small — `affected_count` still records the total.
 *
 * Idempotent: re-running with no stale rows returns {affected_count: 0}
 * AND writes NO audit rows (mirrors createEvent / bulkEdit empty-diff
 * semantics).
 */
export async function purgeStaleDeletedEvents(
  retentionDays: number,
  now: Date = new Date(),
): Promise<{ affected_count: number }> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);

  // System-wide cross-tenant sweep — purges every tenant's stale events in
  // one tx. Per-tenant scoping happens at the audit-write layer (one row
  // per user_id below). This is the only legitimate cross-tenant query in
  // the events service surface; the inline disable is justified per
  // AGENTS.md Pitfall 7. The cron handler calls this from purge.daily;
  // no user-facing route ever reaches this code path.
  /* eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query --
     System-wide cron sweep that purges all tenants' stale events in one
     tx. Per-tenant scoping happens at the audit-write level (one row per
     user_id grouped below). Cron-only call site — no user-facing route
     reaches this code path. */
  const result = await db
    .delete(events)
    .where(and(isNotNull(events.deletedAt), lt(events.deletedAt, cutoff)))
    .returning({ id: events.id, userId: events.userId });

  if (result.length === 0) return { affected_count: 0 };

  // Group affected ids by user_id so each audit row stays per-tenant
  // (preserves per-tenant cursor invariant — see header comment above).
  const byUser = new Map<string, string[]>();
  for (const row of result) {
    const list = byUser.get(row.userId) ?? [];
    list.push(row.id);
    byUser.set(row.userId, list);
  }

  for (const [userId, eventIds] of byUser) {
    await writeAudit({
      userId,
      action: "events.purge_stale",
      ipAddress: "system",
      metadata: {
        affected_count: eventIds.length,
        purged_at: now.toISOString(),
        // Omit affected_ids when >100 to keep the audit row small. The
        // affected_count above still records the total; forensics can
        // reconstruct from logs if needed.
        ...(eventIds.length <= 100 ? { affected_ids: eventIds } : {}),
      },
    });
  }

  return { affected_count: result.length };
}
