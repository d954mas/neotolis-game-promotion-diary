// Global Reddit rate-limit pacer and adapter pause state.
//
// Every outgoing Reddit HTTP call must acquire this single DB-backed token
// before it touches public `.json`. This protects both the async worker and
// sync user paths such as preview/paste. When Reddit itself returns 403/429,
// the same row records an escalating degraded pause so we stop sending
// requests for a conservative window.

import { sql } from "drizzle-orm";
import { db, type DbOrTx } from "$lib/server/db/client.js";
import { logger } from "$lib/server/logger.js";
import { env } from "$lib/server/config/env.js";

/** Slot interval. Production uses 7500ms = 8 req/min. Tests disable the
 * pacing slot so suites do not wait seconds between mocked Reddit calls. */
export const REDDIT_PACER_SLOT_MS = env.NODE_ENV === "test" ? 0 : 7500;

/** Escalating adapter-wide pauses after real upstream 403/429 responses. */
export const REDDIT_ADAPTER_PAUSE_BACKOFF_MS = [
  10 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;

const REDDIT_PAUSE_ESCALATION_WINDOW_MS = 24 * 60 * 60_000;

export type RedditAdapterPauseReason = "http_403" | "http_429";

export interface RedditPacerSlotResult {
  acquired: boolean;
  waitMs: number;
  paused: boolean;
  pauseReason: string | null;
  pausedUntil: Date | null;
}

export interface RedditAdapterPauseState {
  pausedUntil: Date;
  pauseLevel: number;
  waitMs: number;
  reason: RedditAdapterPauseReason;
}

export async function acquireRedditPacerSlot(): Promise<RedditPacerSlotResult> {
  return acquireRedditPacerSlotWith(db);
}

export async function acquireRedditPacerSlotWith(dbCtx: DbOrTx): Promise<RedditPacerSlotResult> {
  const updateResult = await dbCtx.execute<{ next_allowed_at: Date }>(sql`
    UPDATE reddit_pacer
    SET next_allowed_at = NOW() + (${REDDIT_PACER_SLOT_MS} || ' milliseconds')::interval
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
    FROM reddit_pacer
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
  const waitMs = row ? Number(row.wait_ms) : REDDIT_PACER_SLOT_MS;
  const paused = row?.paused === true;
  const pausedUntil =
    row?.paused_until == null
      ? null
      : row.paused_until instanceof Date
        ? row.paused_until
        : new Date(row.paused_until);
  logger.debug({ waitMs, paused }, "reddit pacer: denied; next slot ahead");
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
 *  upstream failures are isolated. That can over-pause under a flaky Reddit
 *  anti-bot fence, but it avoids hammering a degraded public endpoint from
 *  user and worker paths. */
export async function recordRedditAdapterPause(
  reason: RedditAdapterPauseReason,
  upstreamRetryAfterMs = 0,
): Promise<RedditAdapterPauseState> {
  return db.transaction(async (tx) => {
    const currentResult = await tx.execute<{
      pause_level: number | string;
      last_paused_at: Date | string | null;
    }>(sql`
      SELECT pause_level, last_paused_at
      FROM reddit_pacer
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
      Date.now() - lastPausedAt.getTime() <= REDDIT_PAUSE_ESCALATION_WINDOW_MS;
    const currentLevel = Number(current?.pause_level ?? 0);
    const pauseLevel = escalates
      ? Math.min(currentLevel + 1, REDDIT_ADAPTER_PAUSE_BACKOFF_MS.length - 1)
      : 0;
    const waitMs = Math.max(REDDIT_ADAPTER_PAUSE_BACKOFF_MS[pauseLevel]!, upstreamRetryAfterMs);
    const pausedUntil = new Date(Date.now() + waitMs);

    await tx.execute(sql`
      UPDATE reddit_pacer
      SET paused_until = ${pausedUntil},
          pause_level = ${pauseLevel},
          last_pause_reason = ${reason},
          last_paused_at = NOW(),
          next_allowed_at = GREATEST(next_allowed_at, ${pausedUntil})
      WHERE id = 1
    `);
    logger.warn(
      { reason, pauseLevel, waitMs, pausedUntil: pausedUntil.toISOString() },
      "reddit adapter paused after upstream rate-limit/degraded response",
    );
    return { pausedUntil, pauseLevel, waitMs, reason };
  });
}

export async function getRedditAdapterPauseState(): Promise<{
  pausedUntil: Date | null;
  pauseLevel: number;
  pauseReason: string | null;
  isPaused: boolean;
  waitMs: number;
}> {
  const result = await db.execute<{
    paused_until: Date | string | null;
    pause_level: number | string;
    last_pause_reason: string | null;
    wait_ms: number | string;
    is_paused: boolean;
  }>(sql`
    SELECT
      paused_until,
      pause_level,
      last_pause_reason,
      (paused_until IS NOT NULL AND paused_until > NOW()) AS is_paused,
      GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(paused_until, NOW()) - NOW())) * 1000)::int AS wait_ms
    FROM reddit_pacer
    WHERE id = 1
  `);
  const row = (
    result as unknown as {
      rows?: Array<{
        paused_until: Date | string | null;
        pause_level: number | string;
        last_pause_reason: string | null;
        wait_ms: number | string;
        is_paused: boolean;
      }>;
    }
  ).rows?.[0];
  const pausedUntil =
    row?.paused_until == null
      ? null
      : row.paused_until instanceof Date
        ? row.paused_until
        : new Date(row.paused_until);
  return {
    pausedUntil,
    pauseLevel: Number(row?.pause_level ?? 0),
    pauseReason: row?.last_pause_reason ?? null,
    isPaused: row?.is_paused === true,
    waitMs: Number(row?.wait_ms ?? 0),
  };
}

export async function __resetRedditPacerForTest(): Promise<void> {
  await db.execute(sql`
    UPDATE reddit_pacer
    SET next_allowed_at = NOW(),
        paused_until = NULL,
        pause_level = 0,
        last_pause_reason = NULL,
        last_paused_at = NULL
    WHERE id = 1
  `);
}
