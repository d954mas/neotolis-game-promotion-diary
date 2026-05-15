// Per-user abuse quotas.
//
// Canonical entry point for the 3 create paths most subject to abuse:
//   - createGame   -> withQuotaGuard(userId, "games", ipAddress, async tx => INSERT)
//   - createSource -> withQuotaGuard(userId, "data_sources", ipAddress, async tx => INSERT)
//   - createEvent  -> withQuotaGuard(userId, "events_per_day", ipAddress, async tx => INSERT)
//
// Race-free contract:
//   withQuotaGuard wraps takeUserQuotaLock + count + caller-INSERT in one
//   db.transaction. Same-user concurrent requests serialize on the
//   per-user pg_advisory_xact_lock; cross-user concurrency is unaffected
//   (lock key is hashtext(userId)).
//
// Pool-deadlock-safe audit:
//   When the quota fires, the AppError throw bubbles out of the
//   transaction. ROLLBACK runs, the connection returns to the pool, and
//   ONLY THEN does the `finally` block write the audit row via the
//   top-level `db`. If audit were written from inside the transaction
//   (via `db`, not `tx`), it would need a second pool connection while
//   the tx still holds its first; with pool max=10, ten concurrent
//   over-limit same-user requests would each hold one tx connection
//   waiting for the audit connection that the pool can never provide →
//   permanent deadlock. The finally pattern releases first, audits
//   second.
//
// Why audit survives rollback anyway: writeAudit runs OUTSIDE the
// rolled-back transaction on a fresh connection, so the audit row is
// committed independently. The abuse-detection signal isn't lost.
//
// Reset semantics for events_per_day: rolling 24h (NOT
// calendar-day-server-time). Avoids midnight cliff: a user posting 499
// at 23:59 + 1 at 00:01 still hits the cap.
//
// Soft-deleted rows are EXCLUDED from games/data_sources counts. Events
// are NOT excluded — events_per_day is a rate cap, not a footprint cap.
//
// Tenant-scope contract: every Drizzle query inside this module filters
// `eq(<table>.userId, userId)`. The custom ESLint rule
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
import type { DataSourceAdapter } from "$lib/sources/adapter.js";
import { pacificDayStart, nextPacificMidnight, todayPacific } from "../dates.js";

export { pacificDayStart, nextPacificMidnight, todayPacific };

/**
 * Adapter-driven quota counters.
 *
 * Cross-source quotas (games, data_sources, events_per_day) live here as
 * the abuse-quota authority of record. Per-source counters
 * (youtube_metadata_fetches_per_day, future reddit_metadata_fetches_per_day,
 * etc.) are declared by each adapter via `observability.quotaCounters[]`
 * and looked up via `findAdapterCounter(kind)`. Adding a new per-source
 * counter means declaring it on the adapter — quota.ts code stays
 * unchanged.
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
  // Per-source counters live on the adapter (e.g.
  // youtube_metadata_fetches_per_day → youtube adapter's
  // observability.quotaCounters). Cross-source code never knows the
  // table. Adding a new metadata-fetches counter = declare it on the
  // new adapter; this iteration finds it without a quota.ts edit.
  const adapterCounter = findAdapterCounter(kind);
  if (adapterCounter !== null) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return adapterCounter.count(dbCtx, userId, since);
  }
  // events_per_day — rolling 24h count.
  //
  // The events_per_day cap models the human-time budget for manual
  // creates. Auto-import (rows where source_id IS NOT NULL) is excluded
  // from the count entirely; a registered YouTube channel that posts 50
  // videos in one day must not burn the user's manual-paste budget. The
  // auto-import worker bypasses withQuotaGuard altogether; this filter
  // is the defense-in-depth guarantee that ANY service that DOES route
  // an auto-import write through withQuotaGuard still excludes those
  // rows from the rate cap.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [r] = await dbCtx
    .select({ c: count() })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        gte(events.createdAt, since),
        isNull(events.sourceId), // human-driven creates only
      ),
    );
  return Number(r?.c ?? 0);
}

/**
 * Run `fn(tx)` inside a per-user-locked transaction with a quota check
 * upfront. On quota hit: throws AppError 429 `quota_exceeded`; the audit
 * row is written AFTER the transaction releases its connection (see the
 * pool-deadlock note in this file's header).
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

// ───── per-user fair-share cap window helpers ─────
// Per-user cap on operator's API budget (separate from cross-source
// `events_per_day` cap which targets manual creates). Sources of truth:
//   - Cap declaration:   adapter.observability.userQuotaCap (each platform).
//   - Counter source:    audit_log SUM (metadata.requests_used /
//                        metadata.events_inserted).
//   - Window:            Pacific calendar day (in sync with the
//                        operator's reservoir reset cycle in chargedFetch).
//   - Capped flows:      'initial' | 'incremental' | 'historical' | 'stats_refresh'.
//   - Excluded flows:    'auto_passive' (uses the cron pool).
//
// SOFT FAIRNESS CAP — not security-grade strict.
//   The cap-check pattern (read counter → compare → write audit) is NOT
//   atomic. Two concurrent requests from the same user at 99/100 can both
//   pass the gate before either writes its audit row. Result: user briefly
//   reaches 101/100 — overshoot of 1-2 requests per Pacific day under
//   contention.
//
//   Why we accept this: the cap is a FAIRNESS signal protecting shared
//   operator budget from one user monopolizing it, not a compliance ceiling.
//   1-2 request overshoot is irrelevant at indie scale. A strict atomic
//   check would require pg_advisory_xact_lock(hashtext(userId)) on every
//   refresh-content / refresh-poll click — cost-prohibitive for the
//   security improvement gained.
//
//   For genuinely strict caps (events_per_day on manual creates) we DO
//   use advisory locks via withQuotaGuard above. These per-source caps
//   rate-limit upstream API consumption, which is intrinsically soft.
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
 * for the current Pacific calendar day, scoped to user-initiated capped flows.
 *
 * Capped flows (counted in user fair-share cap):
 *   - 'initial' — onboarding channel-context-backfill. The user explicitly
 *     added the source; the API call burned operator budget under their
 *     identity; it MUST count or the cap counter lies. Pre-fix this was
 *     excluded «for UX» (don't thrash on cap during onboarding) but that's
 *     wrong reasoning: it created a discrepancy between Today (excluded)
 *     and Lifetime (included), confusing users about real consumption.
 *   - 'incremental' — refresh-content button (default catch-up).
 *   - 'historical' — refresh-content with explicit older boundary.
 *   - 'stats_refresh' — refresh-poll endpoint (Refresh now button).
 *
 * Excluded flows (use the cron pool, not user pool):
 *   - 'auto_passive' — daily auto-backfill cron pick. Cron-driven, runs
 *     against operator's cron reservoir; per-user cap is irrelevant.
 *
 * Filters by `metadata.platform` when supplied — multi-platform builds
 * separate per-source caps (e.g. Reddit cap from YouTube cap). When
 * omitted (or undefined), counts across all platforms (used by lifetime
 * stats).
 */
export async function getUserQuotaUsedToday(
  userId: string,
  platform?: string,
): Promise<{ requests: number; events: number }> {
  const since = pacificDayStart();
  // `platform` field carries source-kind explicitly. `kind` carries
  // different semantics across audit verbs (event.poll_refreshed writes
  // event-kind = 'youtube_video' while the cap query passes source-kind
  // = 'youtube_channel' — would never match, leaking stats_refresh
  // counts entirely). `platform` is a dedicated field across ALL
  // capped-flow writers — see audit.ts AuditMetadata.platform jsdoc.
  const platformFilter = platform ? sql`AND metadata->>'platform' = ${platform}` : sql``;
  const result = await db.execute(sql`
    SELECT
      COALESCE(SUM((metadata->>'requests_used')::int), 0)::bigint AS requests,
      COALESCE(SUM((metadata->>'events_inserted')::int), 0)::bigint AS events
    FROM audit_log
    WHERE user_id = ${userId}
      AND action IN ('source.refresh_content_requested', 'event.poll_refreshed')
      AND metadata->>'flow' IN ('initial', 'incremental', 'historical', 'stats_refresh')
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
  // Filter on `metadata->>'platform'` for the same reason as
  // getUserQuotaUsedToday above. Filtering on `kind` would
  // under-report (writers populate the dedicated `platform` field).
  const platformFilter = platform ? sql`AND metadata->>'platform' = ${platform}` : sql``;
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

// ───── Adapter-driven per-user quota orchestrator ─────
//
// Single cross-source entry point for per-user cap enforcement. The
// caller passes any DataSourceAdapter and a semantic action; we read
// `adapter.observability.userQuotaCap` and dispatch:
//
//   - cap.windowMinutes set  → Reddit-style two-axis sliding window
//                              (sourceActionsPerWindow / postRefreshesPerWindow),
//                              counter lives in reddit_refresh_queue;
//                              reachable via internal _enforceSlidingWindowCap.
//   - cap.requestsPerDay /   → YouTube-style per-Pacific-day caps;
//     cap.eventsPerDay set     counter via getUserQuotaUsedToday's
//                              audit_log SUM.
//   - neither                → no-op (adapter declares no per-user cap).
//
// Lazy import: cap-axis-specific helpers (Reddit's counter +
// audit writer) load only when the matching adapter shape is present.
// Cross-source code stays adapter-agnostic at module-load time.

/**
 * Action vocabulary the caller is consuming. Generic across adapters:
 *   - "source-action"  : registering or refreshing a source
 *                        (createSource, /sources/:id/refresh-content).
 *   - "post-refresh"   : an event-level stats refresh
 *                        (paste with externalId, Refresh-Now,
 *                        bulk post refresh).
 *
 * Per-axis declaration on the adapter:
 *   - cap.sourceActionsPerWindow declared ⇒ accepts "source-action".
 *   - cap.postRefreshesPerWindow declared ⇒ accepts "post-refresh".
 * When the declared shape doesn't include the caller's action, the
 * helper is a no-op.
 */
export type AdapterQuotaAction = "source-action" | "post-refresh";

/**
 * Enforce the adapter's per-user cap (if any) and throw structured
 * AppError 429 on exhaustion. Adapter-agnostic dispatch: dispatches
 * on `cap.windowMinutes !== undefined` for the sliding-window shape,
 * otherwise treats the cap as the per-Pacific-day shape.
 *
 * Parameters:
 *   - dbCtx     — Drizzle db handle or active tx; the sliding-window
 *                 counter joins the caller's transaction when one is
 *                 active.
 *   - adapter   — the source-kind adapter whose cap to enforce.
 *   - userId    — tenant owner of the action.
 *   - ipAddress — for the audit row on exhaustion.
 *   - action    — which axis the caller is consuming.
 *   - opts.platform — platform key for the per-day audit-log SUM
 *                     query. Defaults to adapter.kind; callers pass an
 *                     override when one adapter instance serves
 *                     multiple SourceKinds (Reddit: reddit_account
 *                     adapter answers for both reddit_account and
 *                     reddit_subreddit createSource paths).
 */
export async function enforceAdapterUserQuota(
  dbCtx: DbOrTx,
  adapter: DataSourceAdapter,
  userId: string,
  ipAddress: string,
  action: AdapterQuotaAction,
  opts: { platform?: string } = {},
): Promise<void> {
  const cap = adapter.observability.userQuotaCap;
  if (!cap) return;

  if (cap.windowMinutes !== undefined) {
    await _enforceSlidingWindowCap(dbCtx, adapter, userId, ipAddress, action);
    return;
  }

  if (cap.requestsPerDay === undefined && cap.eventsPerDay === undefined) return;

  const platform = opts.platform ?? adapter.kind;
  const used = await getUserQuotaUsedToday(userId, platform);
  const resetAt = nextPacificMidnight();
  const resetInSeconds = Math.max(0, Math.floor((resetAt.getTime() - Date.now()) / 1000));

  if (cap.requestsPerDay !== undefined && used.requests >= cap.requestsPerDay) {
    throw new AppError(
      `daily request quota exhausted: ${used.requests}/${cap.requestsPerDay}`,
      "requests_quota_exhausted",
      429,
      { cap: cap.requestsPerDay, used: used.requests, reset_in_seconds: resetInSeconds },
    );
  }
  if (cap.eventsPerDay !== undefined && used.events >= cap.eventsPerDay) {
    throw new AppError(
      `daily events quota exhausted: ${used.events}/${cap.eventsPerDay}`,
      "events_quota_exhausted",
      429,
      { cap: cap.eventsPerDay, used: used.events, reset_in_seconds: resetInSeconds },
    );
  }
}

/**
 * Sliding-window-cap dispatcher used only by `enforceAdapterUserQuota`
 * above. Reddit is the sole adapter declaring this shape today;
 * Reddit-specific counter + error-code mapping + audit writer live in
 * `$lib/sources/reddit/server/quota.ts` and are lazy-imported so
 * cross-source code never resolves Reddit modules at boot.
 *
 * On exhaustion:
 *   1. Write `reddit.cap_exhausted` audit row (forensic trail).
 *   2. Throw AppError 429 with structured metadata
 *      { cap, used, window, reset_in_seconds }. AppError.code carries
 *      the axis-specific error string:
 *        - 'reddit_source_quota_exhausted'
 *        - 'reddit_post_quota_exhausted'
 */
async function _enforceSlidingWindowCap(
  dbCtx: DbOrTx,
  adapter: DataSourceAdapter,
  userId: string,
  ipAddress: string,
  flow: AdapterQuotaAction,
): Promise<void> {
  const cap = adapter.observability.userQuotaCap;
  if (!cap || cap.windowMinutes === undefined) return;

  if (flow === "source-action" && cap.sourceActionsPerWindow === undefined) return;
  if (flow === "post-refresh" && cap.postRefreshesPerWindow === undefined) return;

  // Lazy-load: only the sliding-window adapter (Reddit today) pays the
  // import cost. Cross-source code stays adapter-agnostic at module
  // load — no `import "$lib/sources/reddit/..."` at the top of file.
  const { checkRedditUserCap, writeRedditCapExhaustedAudit, redditCapErrorCode } =
    await import("$lib/sources/reddit/server/quota.js");

  const axis = flow === "source-action" ? "source-actions" : "post-refreshes";
  const result = await checkRedditUserCap(dbCtx, userId, axis);
  if (result.allowed) return;

  // Cap exhausted — write the audit row first (forensic trail) then
  // throw. writeRedditCapExhaustedAudit uses the non-strict writer
  // (swallows audit errors) so a transient DB hiccup on the audit
  // INSERT doesn't suppress the 429.
  await writeRedditCapExhaustedAudit({
    userId,
    ipAddress,
    axis,
    cap: result.cap,
    used: result.used,
  });

  throw new AppError(
    flow === "source-action"
      ? `Reddit source-action cap exhausted: ${result.used}/${result.cap} in last ${result.window_minutes}min`
      : `Reddit post-refresh cap exhausted: ${result.used}/${result.cap} in last ${result.window_minutes}min`,
    redditCapErrorCode(axis),
    429,
    {
      cap: result.cap,
      used: result.used,
      window: `${result.window_minutes}min`,
      reset_in_seconds: result.reset_in_seconds,
    },
  );
}
