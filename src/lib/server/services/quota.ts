// Phase 02.2 D-11: per-user abuse quotas.
//
// Canonical entry point for the 3 create paths most subject to abuse:
//   - createGame   -> withQuotaGuard(userId, "games", ipAddress, async tx => INSERT)
//   - createSource -> withQuotaGuard(userId, "data_sources", ipAddress, async tx => INSERT)
//   - createEvent  -> withQuotaGuard(userId, "events_per_day", ipAddress, async tx => INSERT)
//
// Race-free contract (Codex P2.1):
//   withQuotaGuard wraps takeUserQuotaLock + count + caller-INSERT in one
//   db.transaction. Same-user concurrent requests serialize on the per-user
//   pg_advisory_xact_lock; cross-user concurrency is unaffected (lock key is
//   hashtext(userId)).
//
// Pool-deadlock-safe audit (Codex post-fix review):
//   When the quota fires, the AppError throw bubbles out of the transaction.
//   ROLLBACK runs, the connection returns to the pool, and ONLY THEN does the
//   `finally` block write the audit row via the top-level `db`. If audit were
//   written from inside the transaction (via `db`, not `tx`), it would need a
//   second pool connection while the tx still holds its first; with pool
//   max=10, ten concurrent over-limit same-user requests would each hold one
//   tx connection waiting for the audit connection that the pool can never
//   provide → permanent deadlock. The finally pattern releases first, audits
//   second.
//
// Why audit survives rollback anyway: writeAudit runs OUTSIDE the rolled-back
// transaction on a fresh connection, so the audit row is committed
// independently. The abuse-detection signal isn't lost.
//
// Reset semantics for events_per_day: rolling 24h (NOT calendar-day-server-time).
// Avoids midnight cliff: a user posting 499 at 23:59 + 1 at 00:01 still hits
// the cap. Locked in RESEARCH §1.
//
// Soft-deleted rows are EXCLUDED from games/data_sources counts (CONTEXT D-11).
// Events are NOT excluded — events_per_day is a rate cap, not a footprint cap.
//
// Tenant-scope contract: every Drizzle query inside this module filters
// `eq(<table>.userId, userId)` (AGENTS.md §1). The custom ESLint rule
// eslint-plugin-tenant-scope/no-unfiltered-tenant-query flags drift.

import { and, eq, isNull, gte, count, sql } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "../db/client.js";
import { games } from "../db/schema/games.js";
import { dataSources } from "../db/schema/data-sources.js";
import { events } from "../db/schema/events.js";
import { writeAudit } from "../audit.js";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";
import { allAdapters } from "$lib/sources/registry.js";
import { pacificDayStart, nextPacificMidnight, todayPacific } from "../dates.js";

export { pacificDayStart, nextPacificMidnight, todayPacific };

/**
 * Phase 03.0.1 architecture cleanup — adapter-driven quota counters.
 *
 * Cross-source quotas (games, data_sources, events_per_day) live here as
 * the abuse-quota authority of record. Per-source counters
 * (youtube_metadata_fetches_per_day, reddit_metadata_fetches_per_day in
 * Phase 03.1, etc.) are declared by each adapter via
 * `observability.quotaCounters[]` and looked up via
 * `findAdapterCounter(kind)`. Adding a new per-source counter means
 * declaring it on the adapter — quota.ts code stays unchanged.
 */
export type QuotaKind =
  | "games"
  | "data_sources"
  | "events_per_day"
  | "youtube_metadata_fetches_per_day";

const LIMITS: Record<QuotaKind, number> = {
  games: env.LIMIT_GAMES_PER_USER,
  data_sources: env.LIMIT_SOURCES_PER_USER,
  events_per_day: env.LIMIT_EVENTS_PER_DAY,
  // Per-user 24h cap on cache-miss YouTube metadata fetches (the
  // "Get from YouTube" button on /events/new). Closes the operator-quota
  // burn-loop a scripted-loop caller could otherwise exploit on the
  // /api/youtube/fetch-metadata route. 50/day is the same indie-friendly
  // shape as games / data_sources caps; cache hits don't count.
  // The COUNT logic for this kind lives in the youtube adapter's
  // observability.quotaCounters; this LIMITS entry just declares the cap.
  youtube_metadata_fetches_per_day: env.LIMIT_YOUTUBE_METADATA_FETCHES_PER_DAY,
};

function findAdapterCounter(kind: string): {
  count(dbCtx: DbOrTx, userId: string, since: Date): Promise<number>;
} | null {
  for (const adapter of allAdapters) {
    const counters = adapter.observability.quotaCounters ?? [];
    for (const counter of counters) {
      if (counter.kind === kind) return counter;
    }
  }
  return null;
}

async function currentCount(dbCtx: DbOrTx, userId: string, kind: QuotaKind): Promise<number> {
  if (kind === "games") {
    const [r] = await dbCtx
      .select({ c: count() })
      .from(games)
      .where(and(eq(games.userId, userId), isNull(games.deletedAt)));
    return Number(r?.c ?? 0);
  }
  if (kind === "data_sources") {
    const [r] = await dbCtx
      .select({ c: count() })
      .from(dataSources)
      .where(and(eq(dataSources.userId, userId), isNull(dataSources.deletedAt)));
    return Number(r?.c ?? 0);
  }
  // Phase 03.0.1 architecture cleanup — per-source counters live on the
  // adapter (e.g. youtube_metadata_fetches_per_day → youtube adapter's
  // observability.quotaCounters). Cross-source code never knows the table.
  // Adding Reddit's metadata-fetches counter in Phase 03.1 = declare it on
  // the Reddit adapter; this iteration finds it without a quota.ts edit.
  const adapterCounter = findAdapterCounter(kind);
  if (adapterCounter !== null) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return adapterCounter.count(dbCtx, userId, since);
  }
  // events_per_day — rolling 24h count.
  //
  // Phase 3.0 Plan 04 — DV-5: the events_per_day cap models the human-time
  // budget for manual creates. Auto-import (rows where source_id IS NOT NULL)
  // is excluded from the count entirely; a registered YouTube channel that
  // posts 50 videos in one day must not burn the user's manual-paste budget.
  // The auto-import worker (Plan 03.0-09) bypasses withQuotaGuard altogether;
  // this filter is the defense-in-depth guarantee that ANY service that DOES
  // route an auto-import write through withQuotaGuard still excludes those
  // rows from the rate cap.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [r] = await dbCtx
    .select({ c: count() })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        gte(events.createdAt, since),
        isNull(events.sourceId), // DV-5: human-driven creates only
      ),
    );
  return Number(r?.c ?? 0);
}

/**
 * Run `fn(tx)` inside a per-user-locked transaction with a quota check
 * upfront. On quota hit: throws AppError 429 `quota_exceeded`; the audit
 * row is written AFTER the transaction releases its connection (Codex
 * post-fix review — see header).
 *
 * Race-free under same-user concurrency: pg_advisory_xact_lock(hashtext(userId))
 * serializes the count + INSERT pair. Cross-user concurrency is unaffected.
 *
 * Caller passes `fn(tx)` that runs INSIDE the transaction after the quota
 * passes — typically the INSERT and any junction inserts that must roll
 * back together. `fn`-thrown errors propagate normally; only `quota_exceeded`
 * triggers the post-rollback audit emission.
 */
export async function withQuotaGuard<T>(
  userId: string,
  kind: QuotaKind,
  ipAddress: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  // Capture the metadata the audit needs IF the guard fires; the audit
  // itself runs in `finally` after the tx releases its pool connection.
  let quotaHitMetadata: { kind: QuotaKind; limit: number; current: number } | null = null;

  try {
    return await db.transaction(async (tx) => {
      // hashtext returns int4 → cast to bigint for pg_advisory_xact_lock(bigint).
      // The cast is stable across Postgres versions; collisions are 1/2^32 and
      // benign (a colliding user pair would just briefly serialize each other).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`);

      const limit = LIMITS[kind];
      const current = await currentCount(tx, userId, kind);
      if (current >= limit) {
        // DO NOT call writeAudit from inside the tx — see header for the
        // pool-deadlock rationale. Capture metadata, throw, audit in finally.
        quotaHitMetadata = { kind, limit, current };
        throw new AppError(`quota_exceeded: ${kind} ${current}/${limit}`, "quota_exceeded", 429, {
          kind,
          limit,
          current,
        });
      }

      return await fn(tx);
    });
  } finally {
    // Reached AFTER db.transaction has fully resolved (commit or rollback);
    // the connection is back in the pool. Safe to acquire a fresh connection
    // for the audit insert. If `fn` threw a non-quota error, quotaHitMetadata
    // is null and this is a no-op.
    if (quotaHitMetadata !== null) {
      await writeAudit({
        userId,
        action: "quota.limit_hit",
        ipAddress,
        metadata: quotaHitMetadata,
      });
    }
  }
}

// ───── Phase 03.0.1 — per-user fair-share cap window helpers ─────
// Per-user cap on operator's API budget (separate from cross-source
// `events_per_day` cap which targets manual creates). Sources of truth:
//   - Cap declaration:   adapter.observability.userQuotaCap (each platform).
//   - Counter source:    audit_log SUM (metadata.requests_used /
//                        metadata.events_inserted).
//   - Window:            Pacific calendar day (sync с operator's reservoir
//                        reset cycle in chargedFetch — Plan 08).
//   - Capped kinds:      'incremental' | 'historical' | 'stats_refresh'.
//   - Excluded kinds:    'initial' (onboarding UX), 'auto_passive' (cron pool).
//
// All exported as helpers consumed by:
//   - Endpoint cap checks (refresh-content + refresh-poll) — pre-enqueue gate.
//   - Banner UI loaders — quota status display.

/**
 * Returns the absolute UTC instant at which the current Pacific calendar day
 * began (00:00 PT today). Used as the cap window's lower bound.
 *
 * DST-aware: uses Intl.DateTimeFormat with timezone offset to compute. Spring-
 * forward / fall-back days are handled implicitly because the calculation
 * always derives "00:00 in PT" → UTC, never +24h arithmetic.
 */
/**
 * Per-user cap counter: SUM of audit metadata.requests_used + events_inserted
 * for the current Pacific calendar day, scoped to user-initiated capped flows
 * (excludes 'initial' onboarding and 'auto_passive' cron — those use cron pool,
 * not user pool).
 *
 * Filters by `metadata.platform` when supplied — Phase 03.1+ multi-platform
 * separates Reddit cap from YouTube cap. When omitted (or undefined), counts
 * across all platforms (used by lifetime stats).
 */
export async function getUserQuotaUsedToday(
  userId: string,
  platform?: string,
): Promise<{ requests: number; events: number }> {
  const since = pacificDayStart();
  // Existing audit metadata convention: `kind` carries the source kind
  // (e.g. 'youtube_channel'). New `flow` field carries the refresh-flow
  // discriminator (incremental/historical/stats_refresh/auto_passive/initial).
  // Filter by `kind` for platform separation; by `flow` for capped/excluded.
  const platformFilter = platform ? sql`AND metadata->>'kind' = ${platform}` : sql``;
  const result = await db.execute(sql`
    SELECT
      COALESCE(SUM((metadata->>'requests_used')::int), 0)::bigint AS requests,
      COALESCE(SUM((metadata->>'events_inserted')::int), 0)::bigint AS events
    FROM audit_log
    WHERE user_id = ${userId}
      AND action IN ('source.refresh_content_requested', 'event.poll_refreshed')
      AND metadata->>'flow' IN ('incremental', 'historical', 'stats_refresh')
      AND created_at >= ${since.toISOString()}::timestamptz
      ${platformFilter}
  `);
  const row = result.rows[0] as { requests: string | number; events: string | number } | undefined;
  return {
    requests: Number(row?.requests ?? 0),
    events: Number(row?.events ?? 0),
  };
}

/**
 * Per-user lifetime usage — SUM since the user's signup (no time filter).
 * Includes ALL flows (initial + incremental + historical + stats_refresh +
 * auto_passive) so banner footer shows true lifetime consumption.
 *
 * Performance: indexed via (user_id, created_at desc). For users with
 * thousands of audit rows still <50ms — no caching needed at current scale.
 */
export async function getUserQuotaLifetime(
  userId: string,
  platform?: string,
): Promise<{ requests: number; events: number }> {
  const platformFilter = platform ? sql`AND metadata->>'kind' = ${platform}` : sql``;
  const result = await db.execute(sql`
    SELECT
      COALESCE(SUM((metadata->>'requests_used')::int), 0)::bigint AS requests,
      COALESCE(SUM((metadata->>'events_inserted')::int), 0)::bigint AS events
    FROM audit_log
    WHERE user_id = ${userId}
      AND action IN ('source.refresh_content_requested', 'event.poll_refreshed')
      AND metadata->>'flow' IN ('initial', 'incremental', 'historical', 'stats_refresh', 'auto_passive')
      ${platformFilter}
  `);
  const row = result.rows[0] as { requests: string | number; events: string | number } | undefined;
  return {
    requests: Number(row?.requests ?? 0),
    events: Number(row?.events ?? 0),
  };
}
