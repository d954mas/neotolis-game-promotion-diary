// Phase 02.2 D-11: per-user abuse quotas.
//
// Service-layer guard for the 3 create paths most subject to abuse:
//   - createGame   -> assertQuota(userId, "games", ipAddress)
//   - createSource -> assertQuota(userId, "data_sources", ipAddress)
//   - createEvent  -> assertQuota(userId, "events_per_day", ipAddress)
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

import { and, eq, isNull, gte, count } from "drizzle-orm";
import { db } from "../db/client.js";
import { games } from "../db/schema/games.js";
import { dataSources } from "../db/schema/data-sources.js";
import { events } from "../db/schema/events.js";
import { writeAudit } from "../audit.js";
import { env } from "../config/env.js";
import { AppError } from "./errors.js";

export type QuotaKind = "games" | "data_sources" | "events_per_day";

const LIMITS: Record<QuotaKind, number> = {
  games: env.LIMIT_GAMES_PER_USER,
  data_sources: env.LIMIT_SOURCES_PER_USER,
  events_per_day: env.LIMIT_EVENTS_PER_DAY,
};

async function currentCount(userId: string, kind: QuotaKind): Promise<number> {
  if (kind === "games") {
    const [r] = await db
      .select({ c: count() })
      .from(games)
      .where(and(eq(games.userId, userId), isNull(games.deletedAt)));
    return Number(r?.c ?? 0);
  }
  if (kind === "data_sources") {
    const [r] = await db
      .select({ c: count() })
      .from(dataSources)
      .where(and(eq(dataSources.userId, userId), isNull(dataSources.deletedAt)));
    return Number(r?.c ?? 0);
  }
  // events_per_day — rolling 24h count.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [r] = await db
    .select({ c: count() })
    .from(events)
    .where(and(eq(events.userId, userId), gte(events.createdAt, since)));
  return Number(r?.c ?? 0);
}

/**
 * Throws AppError 429 quota_exceeded when the user has reached the limit.
 * Writes a quota.limit_hit audit event when the guard fires.
 *
 * Tenant-scope contract: every Drizzle query inside this function filters
 * `eq(<table>.userId, userId)` (AGENTS.md §1). The custom ESLint rule
 * eslint-plugin-tenant-scope/no-unfiltered-tenant-query flags drift.
 */
export async function assertQuota(
  userId: string,
  kind: QuotaKind,
  ipAddress: string,
): Promise<void> {
  const limit = LIMITS[kind];
  const current = await currentCount(userId, kind);
  if (current >= limit) {
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
