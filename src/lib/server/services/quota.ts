// Phase 02.2 D-11: per-user abuse quotas.
//
// Service-layer guard for the 3 create paths most subject to abuse:
//   - createGame   -> takeUserQuotaLock + assertQuota(tx, userId, "games", ipAddress)
//   - createSource -> takeUserQuotaLock + assertQuota(tx, userId, "data_sources", ipAddress)
//   - createEvent  -> takeUserQuotaLock + assertQuota(tx, userId, "events_per_day", ipAddress)
//
// Race-free contract (Phase 02.2 review — Codex P2.1 fix):
//   The 3 create paths wrap COUNT + INSERT in a single db.transaction and
//   take a per-user xact-scope advisory lock first via takeUserQuotaLock.
//   Two concurrent requests at limit-1 from the same user serialize on the
//   lock; one wins (count = limit-1, INSERT, commit, lock released), the
//   other loses (count = limit, throw 429). Cross-user concurrency is NOT
//   blocked — the lock key is hashtext(userId).
//
// Audit-on-throw semantics:
//   When assertQuota throws 429, writeAudit("quota.limit_hit") runs against
//   the top-level `db` connection (NOT the surrounding tx) so the tripwire
//   row is committed even though the transaction rolls back. This is by
//   design — the audit log is the abuse-detection signal; rolling it back
//   on quota refusal would defeat the point.
//
// On exceedance, throws AppError 429 quota_exceeded with structured
// metadata. mapErr in routes/_shared.ts forwards the metadata to the
// HTTP response body verbatim — no new route-level mapping needed.
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
// {...})`. Same surface as `DB` for `select`/`execute`/`insert`, so we accept
// either via Pick to keep the contract minimal.
type DbOrTx = DB | Parameters<Parameters<DB["transaction"]>[0]>[0];

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
 * Take a per-user, xact-scoped Postgres advisory lock. Released automatically
 * on COMMIT or ROLLBACK (no manual unlock). Serializes only same-user requests
 * that hold this lock — cross-user concurrency is unaffected.
 *
 * Must be called BEFORE assertQuota inside the same db.transaction. Otherwise
 * the count + insert is racy (Codex P2.1 finding).
 */
export async function takeUserQuotaLock(tx: DbOrTx, userId: string): Promise<void> {
  // hashtext returns int4 → cast to bigint for pg_advisory_xact_lock(bigint).
  // The cast is stable across Postgres versions; collisions are 1/2^32 and
  // benign (a colliding user pair would just briefly serialize each other).
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId})::bigint)`);
}

/**
 * Throws AppError 429 quota_exceeded when the user has reached the limit.
 * Writes a quota.limit_hit audit event (on `db`, not on `dbCtx`) when the
 * guard fires so the tripwire survives the surrounding tx rollback.
 *
 * Pass a transaction handle for the race-free path: the create-side caller
 * wraps takeUserQuotaLock + assertQuota + INSERT in one db.transaction.
 *
 * Tenant-scope contract: every Drizzle query inside this function filters
 * `eq(<table>.userId, userId)` (AGENTS.md §1). The custom ESLint rule
 * eslint-plugin-tenant-scope/no-unfiltered-tenant-query flags drift.
 */
export async function assertQuota(
  userId: string,
  kind: QuotaKind,
  ipAddress: string,
  dbCtx: DbOrTx = db,
): Promise<void> {
  const limit = LIMITS[kind];
  const current = await currentCount(dbCtx, userId, kind);
  if (current >= limit) {
    // Audit on `db` (NOT dbCtx) so the row commits even when the surrounding
    // tx rolls back. Audit log is the abuse-detection signal — rolling it
    // back on quota refusal would defeat the point.
    await writeAudit({
      userId,
      action: "quota.limit_hit",
      ipAddress,
      metadata: { kind, limit, current },
    });
    throw new AppError(`quota_exceeded: ${kind} ${current}/${limit}`, "quota_exceeded", 429, {
      kind,
      limit,
      current,
    });
  }
}
