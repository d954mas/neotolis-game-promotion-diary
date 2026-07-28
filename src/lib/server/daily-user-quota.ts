import { sql } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "./db/client.js";
import { pacificDayStart, nextPacificMidnight, todayPacific } from "./dates.js";
import { AppError } from "./services/errors.js";
import type { AuditEntry, AuditMetadata } from "./audit.js";

export interface DailyUserQuotaUsage {
  requests: number;
  events: number;
}

export interface DailyUserRequestAccounting {
  requestsPerDay: number;
  auditEntry: Omit<AuditEntry, "metadata"> & {
    metadata: AuditMetadata & { platform: string };
  };
}

export async function getTransactionTimestamp(tx: Tx): Promise<Date> {
  const result = await tx.execute(sql`
    SELECT CURRENT_TIMESTAMP AS transaction_timestamp
  `);
  const row = result.rows[0] as { transaction_timestamp: Date | string };
  return new Date(row.transaction_timestamp);
}

async function readDailyUserQuotaUsage(
  dbCtx: DbOrTx,
  userId: string,
  platform: string | undefined,
  now: Date,
): Promise<DailyUserQuotaUsage> {
  const since = pacificDayStart(now);
  const platformFilter = platform ? sql`AND metadata->>'platform' = ${platform}` : sql``;
  const result = await dbCtx.execute(sql`
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

export async function getUserQuotaUsedToday(
  userId: string,
  platform?: string,
  // Callers already inside a transaction MUST pass their tx: reading via the
  // module-level `db` from within a held transaction checks out a SECOND pool
  // connection while the first is still held — the pool-deadlock pattern.
  dbCtx: DbOrTx = db,
): Promise<DailyUserQuotaUsage> {
  return readDailyUserQuotaUsage(dbCtx, userId, platform, new Date());
}

export async function lockAndAssertDailyUserRequestQuota(
  tx: Tx,
  args: {
    userId: string;
    platform: string;
    units: number;
    requestsPerDay: number;
  },
): Promise<void> {
  const now = await getTransactionTimestamp(tx);
  const datePacific = todayPacific(now);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`user-quota:${args.userId}:${args.platform}:${datePacific}`}, 0))`,
  );

  const used = await readDailyUserQuotaUsage(tx, args.userId, args.platform, now);
  if (used.requests + args.units <= args.requestsPerDay) return;

  const resetAt = nextPacificMidnight(now);
  const resetInSeconds = Math.max(0, Math.floor((resetAt.getTime() - now.getTime()) / 1000));
  throw new AppError(
    `daily request quota exhausted: ${used.requests}/${args.requestsPerDay}`,
    "requests_quota_exhausted",
    429,
    {
      cap: args.requestsPerDay,
      used: used.requests,
      reset_in_seconds: resetInSeconds,
    },
  );
}
