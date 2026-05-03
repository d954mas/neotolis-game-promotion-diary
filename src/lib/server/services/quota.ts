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
import { db, type DB } from "../db/client.js";
import { games } from "../db/schema/games.js";
import { dataSources } from "../db/schema/data-sources.js";
import { events } from "../db/schema/events.js";
import { writeAudit } from "../audit.js";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";

export type QuotaKind = "games" | "data_sources" | "events_per_day";

// Drizzle transaction parameter type — `tx` inside `db.transaction(async tx =>
// {...})`. Same surface as `DB` for `select`/`execute`/`insert`.
export type DbOrTx = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];

const LIMITS: Record<QuotaKind, number> = {
  games: env.LIMIT_GAMES_PER_USER,
  data_sources: env.LIMIT_SOURCES_PER_USER,
  events_per_day: env.LIMIT_EVENTS_PER_DAY,
};

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
  // events_per_day — rolling 24h count.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [r] = await dbCtx
    .select({ c: count() })
    .from(events)
    .where(and(eq(events.userId, userId), gte(events.createdAt, since)));
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
  fn: (tx: DbOrTx) => Promise<T>,
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
