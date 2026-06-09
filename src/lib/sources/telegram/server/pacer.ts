// Global Telegram (t.me) rate-limit pacer and adapter pause state.
//
// Every outgoing t.me HTTP call must acquire this single DB-backed token
// before it touches the public listing / embed surface. This protects both
// the async listing-poll / warm-lane workers and sync user paths such as
// preview/paste. When t.me itself returns 403/429, the same row records an
// escalating degraded pause so we stop sending requests for a conservative
// window.
//
// This is a near-verbatim copy of reddit/server/pacer.ts. The t.me/s embed
// surface is far more tolerant than Reddit's anti-bot fence (RESEARCH:
// Mozilla/5.0 + a polite slot works live), so the slot is generous headroom
// rather than a hard ceiling — but the DB-token shape buys multi-replica
// safety identically.

import { sql } from "drizzle-orm";
import { db, type DbOrTx } from "$lib/server/db/client.js";
import { logger } from "$lib/server/logger.js";
import { env } from "$lib/server/config/env.js";

/** Slot interval. Production uses 3000ms = 20 req/min — conservative; the
 * t.me/s embed surface is tolerant (RESEARCH), so this is comfortable
 * headroom. Tests disable the pacing slot so suites do not wait seconds
 * between mocked t.me calls. */
export const TELEGRAM_PACER_SLOT_MS = env.NODE_ENV === "test" ? 0 : 3000;

/** Escalating adapter-wide pauses after real upstream 403/429 responses. */
export const TELEGRAM_ADAPTER_PAUSE_BACKOFF_MS = [
  10 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;

const TELEGRAM_PAUSE_ESCALATION_WINDOW_MS = 24 * 60 * 60_000;

export type TelegramAdapterPauseReason = "http_403" | "http_429";

export interface TelegramPacerSlotResult {
  acquired: boolean;
  waitMs: number;
  paused: boolean;
  pauseReason: string | null;
  pausedUntil: Date | null;
}

export interface TelegramAdapterPauseState {
  pausedUntil: Date;
  pauseLevel: number;
  waitMs: number;
  reason: TelegramAdapterPauseReason;
}

export async function acquireTelegramPacerSlot(): Promise<TelegramPacerSlotResult> {
  return acquireTelegramPacerSlotWith(db);
}

export async function acquireTelegramPacerSlotWith(
  dbCtx: DbOrTx,
): Promise<TelegramPacerSlotResult> {
  const updateResult = await dbCtx.execute<{ next_allowed_at: Date }>(sql`
    UPDATE telegram_pacer
    SET next_allowed_at = NOW() + (${TELEGRAM_PACER_SLOT_MS} || ' milliseconds')::interval
    WHERE id = 1
      AND next_allowed_at <= NOW()
      AND (paused_until IS NULL OR paused_until <= NOW())
    RETURNING next_allowed_at
  `);
  const updated =
    (updateResult as unknown as { rows?: Array<{ next_allowed_at: Date }> }).rows ?? [];
  if (updated.length === 1) {
    return { acquired: true, waitMs: 0, paused: false, pauseReason: null, pausedUntil: null };
  }

  const readResult = await dbCtx.execute<{
    wait_ms: number | string;
    paused: boolean;
    pause_reason: string | null;
    paused_until: Date | string | null;
  }>(sql`
    SELECT
      GREATEST(
        0,
        EXTRACT(EPOCH FROM (GREATEST(next_allowed_at, COALESCE(paused_until, next_allowed_at)) - NOW())) * 1000
      )::int AS wait_ms,
      (paused_until IS NOT NULL AND paused_until > NOW()) AS paused,
      last_pause_reason AS pause_reason,
      paused_until
    FROM telegram_pacer
    WHERE id = 1
  `);
  const readRows =
    (
      readResult as unknown as {
        rows?: Array<{
          wait_ms: number | string;
          paused: boolean;
          pause_reason: string | null;
          paused_until: Date | string | null;
        }>;
      }
    ).rows ?? [];
  const row = readRows[0];
  const waitMs = row ? Number(row.wait_ms) : TELEGRAM_PACER_SLOT_MS;
  const paused = row?.paused === true;
  const pausedUntil =
    row?.paused_until == null
      ? null
      : row.paused_until instanceof Date
        ? row.paused_until
        : new Date(row.paused_until);
  logger.debug({ waitMs, paused }, "telegram pacer: denied; next slot ahead");
  return {
    acquired: false,
    waitMs,
    paused,
    pauseReason: row?.pause_reason ?? null,
    pausedUntil,
  };
}

/** Record an adapter-wide degraded pause after a real upstream 403/429.
 *
 *  The backoff is consciously conservative: every pause inside the 24h
 *  escalation window ratchets from 10m -> 1h -> 3h -> 12h, even when the
 *  upstream failures are isolated. That can over-pause under a flaky t.me
 *  fence, but it avoids hammering a degraded public endpoint from user and
 *  worker paths. */
export async function recordTelegramAdapterPause(
  reason: TelegramAdapterPauseReason,
  upstreamRetryAfterMs = 0,
): Promise<TelegramAdapterPauseState> {
  return db.transaction(async (tx) => {
    const currentResult = await tx.execute<{
      pause_level: number | string;
      last_paused_at: Date | string | null;
    }>(sql`
      SELECT pause_level, last_paused_at
      FROM telegram_pacer
      WHERE id = 1
      FOR UPDATE
    `);
    const current = (
      currentResult as unknown as {
        rows?: Array<{ pause_level: number | string; last_paused_at: Date | string | null }>;
      }
    ).rows?.[0];
    const lastPausedAt =
      current?.last_paused_at == null
        ? null
        : current.last_paused_at instanceof Date
          ? current.last_paused_at
          : new Date(current.last_paused_at);
    const escalates =
      lastPausedAt !== null &&
      Date.now() - lastPausedAt.getTime() <= TELEGRAM_PAUSE_ESCALATION_WINDOW_MS;
    const currentLevel = Number(current?.pause_level ?? 0);
    const pauseLevel = escalates
      ? Math.min(currentLevel + 1, TELEGRAM_ADAPTER_PAUSE_BACKOFF_MS.length - 1)
      : 0;
    const waitMs = Math.max(TELEGRAM_ADAPTER_PAUSE_BACKOFF_MS[pauseLevel]!, upstreamRetryAfterMs);
    const pausedUntil = new Date(Date.now() + waitMs);

    await tx.execute(sql`
      UPDATE telegram_pacer
      SET paused_until = ${pausedUntil},
          pause_level = ${pauseLevel},
          last_pause_reason = ${reason},
          last_paused_at = NOW(),
          next_allowed_at = GREATEST(next_allowed_at, ${pausedUntil})
      WHERE id = 1
    `);
    logger.warn(
      { reason, pauseLevel, waitMs, pausedUntil: pausedUntil.toISOString() },
      "telegram adapter paused after upstream rate-limit/degraded response",
    );
    return { pausedUntil, pauseLevel, waitMs, reason };
  });
}

/** Test-only reset. The singleton id=1 row is seeded in migration 0057
 *  (INSERT ... ON CONFLICT DO NOTHING, mirroring reddit_pacer), so this
 *  UPSERTs the row first to be robust against a fresh test DB, then clears the
 *  pacing + pause state. */
export async function __resetTelegramPacerForTest(): Promise<void> {
  await db.execute(sql`
    INSERT INTO telegram_pacer (id, next_allowed_at) VALUES (1, NOW())
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    UPDATE telegram_pacer
    SET next_allowed_at = NOW(),
        paused_until = NULL,
        pause_level = 0,
        last_pause_reason = NULL,
        last_paused_at = NULL
    WHERE id = 1
  `);
}
