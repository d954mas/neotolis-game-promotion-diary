// Games service — GAMES-01..03 (CRUD + soft-delete + transactional restore).
//
// Pattern 1 (tenant scope): EVERY function here takes `userId: string` as the
// first arg and EVERY Drizzle query .where()-clauses on `eq(<table>.userId, userId)`.
// The custom ESLint rule `tenant-scope/no-unfiltered-tenant-query` (Plan 02-02)
// fires on any query against tenant-owned tables that omits this filter — so
// the absence of warnings on this file is a load-bearing assertion, not a
// stylistic preference. Disable comments are NOT allowed in this file.
//
// Soft-delete + transactional restore (D-23): when a parent `games` row is
// soft-deleted, the SAME captured `Date` value lands on the parent and on
// every active child row (game_steam_listings) inside ONE database
// transaction. On restore, we read the parent's `deletedAt` as the marker
// timestamp and reverse ONLY children whose `deletedAt === markerTs`. Rows
// soft-deleted EARLIER keep their original `deletedAt` and stay deleted —
// that's the marker-timestamp design.
//
// Phase 2.1: `game_youtube_channels` and `tracked_youtube_videos` were
// retired in Plan 02.1-01 (the per-platform M:N + per-platform tracked
// tables collapsed into the unified `events` table + the user-level
// `data_sources` registry).
//
// Plan 02.1-28 (M:N migration): the events cascade is REMOVED. With the
// `events.game_id` column dropped (Plan 02.1-27) and events relating to
// games via the `event_games` junction, soft-deleting a game no longer
// has a clean "delete events whose gameId = this" semantic — events can
// be attached to multiple games, and soft-deleting an event because ONE
// of its attached games went away would be wrong. The schema's CASCADE
// on `event_games(game_id)` means HARD-deleting a game removes the
// junction row but leaves the event; soft-deleting a game leaves the
// junction rows alone too (no deletedAt column on the junction). The
// per-game listEventsForGame query naturally JOINs through the junction
// — events stay visible only on the games they're still attached to.
//
// NOT cascaded: `data_sources` (user-level, reused across games),
// `api_keys_steam` (the user's wishlist key is not game-bound), and
// `events` (M:N relation; see Plan 02.1-28 rationale above).
//
// writeAudit calls are `await`-ed but never throw — see src/lib/server/audit.ts.
// We capture `game.created`, `game.deleted`, `game.restored` per D-32; listing
// CRUD is intentionally NOT audited (D-32: only the audit verbs in the enum).

import { and, eq, isNull, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { games } from "../db/schema/games.js";
import { gameSteamListings } from "../db/schema/game-steam-listings.js";
import { writeAudit } from "../audit.js";
import { env } from "../config/env.js";
import { AppError, NotFoundError } from "./errors.js";

export type GameRow = typeof games.$inferSelect;

export interface CreateGameInput {
  title: string;
  notes?: string;
}

export interface UpdateGameInput {
  title?: string;
  notes?: string;
  tags?: string[];
  releaseTba?: boolean;
  releaseDate?: string | null;
  coverUrl?: string | null;
  // Plan 02.1-39 round-6 polish #14a: nullable long-form description.
  // Service-layer max length 2000 chars (DB column has no constraint
  // — the migration is purely additive). Pass `null` explicitly to
  // clear an existing description; omit the field to leave it
  // untouched. The empty-string case is normalized to NULL at the
  // service entry so callers can pass an empty textarea verbatim.
  description?: string | null;
}

const TITLE_MIN = 1;
const TITLE_MAX = 200;
// Plan 02.1-39 round-6 polish #14a: description is bounded at the
// service layer (DB column is unconstrained — see schema/games.ts).
// 2000 chars is roughly two short paragraphs — enough for "what's
// the pitch / target audience / status" without growing into a wiki
// surface. The validateDescription helper accepts NULL (clear) and
// validates length on string inputs only.
const DESCRIPTION_MAX = 2000;

function validateTitle(title: string): void {
  const trimmed = title.trim();
  if (trimmed.length < TITLE_MIN || trimmed.length > TITLE_MAX) {
    throw new AppError(
      `title must be between ${TITLE_MIN} and ${TITLE_MAX} characters`,
      "validation_failed",
      422,
    );
  }
}

function validateDescription(description: string | null): void {
  if (description === null) return;
  if (description.length > DESCRIPTION_MAX) {
    throw new AppError(
      `description must be at most ${DESCRIPTION_MAX} characters`,
      "validation_failed",
      422,
    );
  }
}

/**
 * Create a game scoped to `userId`. Throws AppError(422) on missing/oversized
 * title BEFORE any INSERT — never produces an orphan row on validation fail.
 *
 * Audit: writes `game.created` with `metadata: { gameId }`.
 */
export async function createGame(
  userId: string,
  input: CreateGameInput,
  ipAddress: string,
): Promise<GameRow> {
  validateTitle(input.title);
  const [row] = await db
    .insert(games)
    .values({
      userId,
      title: input.title.trim(),
      notes: input.notes ?? "",
    })
    .returning();
  if (!row) {
    // Should be unreachable — Postgres INSERT ... RETURNING * either succeeds
    // with one row or throws. Defensive in case of driver-layer surprise.
    throw new Error("createGame: INSERT returned no row");
  }
  await writeAudit({
    userId,
    action: "game.created",
    ipAddress,
    metadata: { gameId: row.id },
  });
  return row;
}

/**
 * List the caller's games. By default omits soft-deleted rows. Pass
 * `includeSoftDeleted: true` for the trash view (Plan 02-08 wires the route).
 */
export async function listGames(
  userId: string,
  opts?: { includeSoftDeleted?: boolean },
): Promise<GameRow[]> {
  if (opts?.includeSoftDeleted) {
    return db.select().from(games).where(eq(games.userId, userId)).orderBy(desc(games.createdAt));
  }
  return db
    .select()
    .from(games)
    .where(and(eq(games.userId, userId), isNull(games.deletedAt)))
    .orderBy(desc(games.createdAt));
}

/**
 * List ONLY the caller's soft-deleted games (the "trash" view). Convenience
 * wrapper around listGames; kept separate so the audit-read service can fan
 * out without re-implementing the filter logic.
 */
export async function listSoftDeletedGames(userId: string): Promise<GameRow[]> {
  const all = await listGames(userId, { includeSoftDeleted: true });
  return all.filter((g) => g.deletedAt !== null);
}

/**
 * Read one game by id. Throws NotFoundError when:
 *   - row does not exist
 *   - row exists but is owned by a different user (cross-tenant 404, NOT 403 — PRIV-01)
 *   - row is soft-deleted (call getGameByIdIncludingDeleted for the restore route)
 *
 * The double-condition (`userId AND id`) is the Pattern 1 invariant — the
 * only way a row comes back is when both the resource id and the caller
 * id agree, so cross-tenant fetches are indistinguishable from "this id
 * never existed" by construction.
 */
export async function getGameById(userId: string, gameId: string): Promise<GameRow> {
  const rows = await db
    .select()
    .from(games)
    .where(and(eq(games.userId, userId), eq(games.id, gameId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.deletedAt !== null) throw new NotFoundError();
  return row;
}

/**
 * Read one game including soft-deleted rows. Used by the restore endpoint
 * (Plan 02-08) where the caller explicitly wants to operate on a row in
 * trash. Cross-tenant access still throws NotFoundError.
 */
export async function getGameByIdIncludingDeleted(
  userId: string,
  gameId: string,
): Promise<GameRow> {
  const rows = await db
    .select()
    .from(games)
    .where(and(eq(games.userId, userId), eq(games.id, gameId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return row;
}

/**
 * Update one game. Only the fields present in `input` are written; missing
 * fields preserve their existing values. `updatedAt` is bumped on every
 * call so the UI can show "edited Nm ago" without a separate column.
 *
 * No audit row — D-32 reserves audit verbs for security-relevant ops; field
 * edits are not in the enum.
 */
export async function updateGame(
  userId: string,
  gameId: string,
  input: UpdateGameInput,
): Promise<GameRow> {
  if (input.title !== undefined) validateTitle(input.title);
  // Plan 02.1-39 round-6 polish #14a: normalize empty string → null
  // BEFORE validation so the 2000-char check operates on the
  // post-normalization value. Empty string is semantically equivalent
  // to "no description"; collapsing it to NULL keeps the column
  // tri-state-free (NULL vs string-with-content).
  let normalizedDescription: string | null | undefined = input.description;
  if (typeof normalizedDescription === "string") {
    if (normalizedDescription.trim().length === 0) {
      normalizedDescription = null;
    } else {
      validateDescription(normalizedDescription);
    }
  }

  const patch: Partial<typeof games.$inferInsert> = { updatedAt: new Date() };
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.notes !== undefined) patch.notes = input.notes;
  if (input.tags !== undefined) patch.tags = input.tags;
  if (input.releaseTba !== undefined) patch.releaseTba = input.releaseTba;
  if (input.releaseDate !== undefined) patch.releaseDate = input.releaseDate;
  if (input.coverUrl !== undefined) patch.coverUrl = input.coverUrl;
  if (normalizedDescription !== undefined) patch.description = normalizedDescription;

  const [row] = await db
    .update(games)
    .set(patch)
    .where(and(eq(games.userId, userId), eq(games.id, gameId), isNull(games.deletedAt)))
    .returning();
  if (!row) throw new NotFoundError();
  return row;
}

/**
 * Soft-delete a game and cascade the same `deletedAt` to its four child
 * tables in a single transaction (D-23). Children sharing the parent's
 * exact timestamp can be reversed atomically by `restoreGame`; rows that
 * were already soft-deleted before this call have a different (earlier)
 * `deletedAt` and stay deleted on restore.
 *
 * `youtubeChannels` and `apiKeysSteam` are intentionally NOT cascaded
 * (D-24) — channels live at user level and api keys are not game-bound.
 *
 * Audit: writes `game.deleted` with `metadata: { gameId, retentionDays }`.
 * The retentionDays value lets the UI surface "this game will be hard-
 * purged in N days" without re-reading env (Plan 02-08).
 */
export async function softDeleteGame(
  userId: string,
  gameId: string,
  ipAddress: string,
): Promise<void> {
  // Captured ONCE so every UPDATE in this tx writes the same Date value.
  // Postgres `now()` would also be tx-stable but the explicit Date makes
  // the value testable + comparable across transactions.
  const deletedAt = new Date();
  await db.transaction(async (tx) => {
    const result = await tx
      .update(games)
      .set({ deletedAt })
      .where(and(eq(games.userId, userId), eq(games.id, gameId), isNull(games.deletedAt)))
      .returning({ id: games.id });
    if (result.length === 0) throw new NotFoundError();

    await tx
      .update(gameSteamListings)
      .set({ deletedAt })
      .where(
        and(
          eq(gameSteamListings.userId, userId),
          eq(gameSteamListings.gameId, gameId),
          isNull(gameSteamListings.deletedAt),
        ),
      );
    // Plan 02.1-28: events cascade REMOVED — see file-header rationale.
    // Events are M:N to games via event_games (Plan 02.1-27 schema); a
    // game's soft-delete no longer cleanly maps to "delete events
    // attached to this game" because events can be attached to multiple
    // games. Per-game views (listEventsForGame) JOIN through the
    // junction so events stop appearing on the deleted game's curated
    // list as long as the game stays soft-deleted.
  });
  await writeAudit({
    userId,
    action: "game.deleted",
    ipAddress,
    metadata: { gameId, retentionDays: env.RETENTION_DAYS },
  });
}

/**
 * Restore a soft-deleted game and reverse ONLY children whose `deletedAt`
 * matches the parent's marker timestamp. Children soft-deleted BEFORE the
 * parent (earlier `deletedAt`) keep their original timestamp and stay
 * deleted — that's the design (D-23).
 *
 * Audit: writes `game.restored` with `metadata: { gameId }`.
 */
export async function restoreGame(
  userId: string,
  gameId: string,
  ipAddress: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [parent] = await tx
      .select({ deletedAt: games.deletedAt })
      .from(games)
      .where(and(eq(games.userId, userId), eq(games.id, gameId)))
      .limit(1);
    if (!parent || parent.deletedAt === null) throw new NotFoundError();
    const markerTs = parent.deletedAt;

    await tx
      .update(games)
      .set({ deletedAt: null })
      .where(and(eq(games.userId, userId), eq(games.id, gameId)));
    await tx
      .update(gameSteamListings)
      .set({ deletedAt: null })
      .where(
        and(
          eq(gameSteamListings.userId, userId),
          eq(gameSteamListings.gameId, gameId),
          eq(gameSteamListings.deletedAt, markerTs),
        ),
      );
    // Plan 02.1-28: events cascade REMOVED — see file-header rationale.
    // Symmetric with softDeleteGame: no events were soft-deleted as part
    // of the game's cascade, so there's nothing to restore here.
  });
  await writeAudit({
    userId,
    action: "game.restored",
    ipAddress,
    metadata: { gameId },
  });
}
