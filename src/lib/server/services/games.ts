// Games service — CRUD + soft-delete + transactional restore.
//
// Tenant scope: EVERY function here takes `userId: string` as the first
// arg and EVERY Drizzle query .where()-clauses on
// `eq(<table>.userId, userId)`. The custom ESLint rule
// `tenant-scope/no-unfiltered-tenant-query` fires on any query against
// tenant-owned tables that omits this filter — so the absence of warnings
// on this file is a load-bearing assertion, not a stylistic preference.
// Disable comments are NOT allowed in this file.
//
// Soft-delete + transactional restore: when a parent `games` row is
// soft-deleted, the SAME captured `Date` value lands on the parent and
// on every active child row (game_steam_listings) inside ONE database
// transaction. On restore, we read the parent's `deletedAt` as the
// marker timestamp and reverse ONLY children whose
// `deletedAt === markerTs`. Rows soft-deleted EARLIER keep their
// original `deletedAt` and stay deleted — that's the marker-timestamp
// design.
//
// Events are M:N to games via the `event_games` junction; soft-deleting
// a game does NOT cascade to events. Events can be attached to multiple
// games, and soft-deleting an event because ONE of its attached games
// went away would be wrong. The schema's CASCADE on
// `event_games(game_id)` means HARD-deleting a game removes the junction
// row but leaves the event; soft-deleting a game leaves the junction
// rows alone too (no deletedAt column on the junction). The per-game
// `listEventsForGame` query JOINs through the junction — events stay
// visible only on the games they're still attached to.
//
// NOT cascaded: `data_sources` (user-level, reused across games),
// `api_keys_steam` (the user's wishlist key is not game-bound), and
// `events` (M:N relation; see rationale above).
//
// writeAudit calls are `await`-ed but never throw — see
// src/lib/server/audit.ts. We capture `game.created`, `game.deleted`,
// `game.restored`; listing CRUD is intentionally NOT audited (only the
// security-relevant verbs in the audit enum).

import { and, eq, isNull, desc, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { games } from "../db/schema/games.js";
import { gameSteamListings } from "../db/schema/game-steam-listings.js";
import { writeAudit } from "../audit.js";
import { env } from "../config/env.js";
import { AppError, NotFoundError } from "./errors.js";
import { withQuotaGuard } from "./quota.js";
import type { DerivedReleaseInfo } from "../dto.js";

export type GameRow = typeof games.$inferSelect;

export interface CreateGameInput {
  title: string;
  notes?: string;
}

export interface UpdateGameInput {
  title?: string;
  notes?: string;
  tags?: string[];
  coverUrl?: string | null;
  // Nullable long-form description. Service-layer max length 2000 chars
  // (DB column has no constraint). Pass `null` explicitly to clear an
  // existing description; omit the field to leave it untouched. The
  // empty-string case is normalized to NULL at the service entry so
  // callers can pass an empty textarea verbatim.
  description?: string | null;
  // releaseDate / releaseTba INTENTIONALLY OMITTED. The release date is
  // owned by `game_steam_listings.release_date` (denormalization-audit-2.md
  // V-2). Migration drizzle/0047 dropped the games-row columns; the
  // loaders derive the value via JOIN before serializing the DTO.
}

const TITLE_MIN = 1;
const TITLE_MAX = 200;
// Description is bounded at the service layer (DB column is unconstrained
// — see schema/games.ts). 2000 chars is roughly two short paragraphs —
// enough for "what's the pitch / target audience / status" without
// growing into a wiki surface. The validateDescription helper accepts
// NULL (clear) and validates length on string inputs only.
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

  // Race-free, deadlock-safe quota path. withQuotaGuard takes a per-user
  // advisory lock, runs the count + INSERT in one tx, and emits the
  // quota.limit_hit audit AFTER the tx releases its pool connection.
  const row = await withQuotaGuard(userId, "games", ipAddress, async (tx) => {
    const [r] = await tx
      .insert(games)
      .values({
        userId,
        title: input.title.trim(),
        notes: input.notes ?? "",
      })
      .returning();
    if (!r) {
      // Should be unreachable — Postgres INSERT ... RETURNING * either succeeds
      // with one row or throws. Defensive in case of driver-layer surprise.
      throw new Error("createGame: INSERT returned no row");
    }
    return r;
  });

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
 * `includeSoftDeleted: true` for the trash view.
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
 *   - row exists but is owned by a different user (cross-tenant 404, NOT 403)
 *   - row is soft-deleted (call getGameByIdIncludingDeleted for the restore route)
 *
 * The double-condition (`userId AND id`) is the tenant-scope invariant —
 * the only way a row comes back is when both the resource id and the
 * caller id agree, so cross-tenant fetches are indistinguishable from
 * "this id never existed" by construction.
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
 * where the caller explicitly wants to operate on a row in trash.
 * Cross-tenant access still throws NotFoundError.
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
 * No audit row — audit verbs are reserved for security-relevant ops; field
 * edits are not in the enum.
 */
export async function updateGame(
  userId: string,
  gameId: string,
  input: UpdateGameInput,
): Promise<GameRow> {
  if (input.title !== undefined) validateTitle(input.title);
  // Normalize empty string → null BEFORE validation so the 2000-char
  // check operates on the post-normalization value. Empty string is
  // semantically equivalent to "no description"; collapsing it to NULL
  // keeps the column tri-state-free (NULL vs string-with-content).
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
  if (input.coverUrl !== undefined) patch.coverUrl = input.coverUrl;
  if (normalizedDescription !== undefined) patch.description = normalizedDescription;
  // releaseDate / releaseTba: NOT WRITABLE on games row anymore.
  // Owned by game_steam_listings.release_date; see UpdateGameInput
  // header + denormalization-audit-2.md V-2.

  const [row] = await db
    .update(games)
    .set(patch)
    .where(and(eq(games.userId, userId), eq(games.id, gameId), isNull(games.deletedAt)))
    .returning();
  if (!row) throw new NotFoundError();
  return row;
}

/**
 * Soft-delete a game and cascade the same `deletedAt` to its child
 * tables in a single transaction. Children sharing the parent's exact
 * timestamp can be reversed atomically by `restoreGame`; rows that were
 * already soft-deleted before this call have a different (earlier)
 * `deletedAt` and stay deleted on restore.
 *
 * `data_sources` and `apiKeysSteam` are intentionally NOT cascaded —
 * sources live at user level and api keys are not game-bound.
 *
 * Audit: writes `game.deleted` with `metadata: { gameId, retentionDays }`.
 * The retentionDays value lets the UI surface "this game will be hard-
 * purged in N days" without re-reading env.
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
    // No events cascade — see file-header rationale. Events are M:N to
    // games via event_games; a game's soft-delete no longer cleanly
    // maps to "delete events attached to this game" because events can
    // be attached to multiple games. Per-game views (listEventsForGame)
    // JOIN through the junction so events stop appearing on the deleted
    // game's curated list as long as the game stays soft-deleted.
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
 * deleted — that's the design.
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
    // No events cascade — see file-header rationale. Symmetric with
    // softDeleteGame: no events were soft-deleted as part of the game's
    // cascade, so there's nothing to restore here.
  });
  await writeAudit({
    userId,
    action: "game.restored",
    ipAddress,
    metadata: { gameId },
  });
}

/**
 * Permanently delete a soft-deleted game and its cascaded children
 * (game_steam_listings). Only operates on rows with `deletedAt IS NOT NULL`.
 *
 * Events are M:N to games via `event_games` — the FK CASCADE on
 * `event_games(game_id)` automatically removes the junction rows when the
 * parent game is hard-deleted, leaving the events themselves intact.
 *
 * Audit: writes `game.delete_forever` with `metadata: { gameId }`.
 */
export async function hardDeleteGame(
  userId: string,
  gameId: string,
  ipAddress: string,
): Promise<void> {
  const [existing] = await db
    .select({ deletedAt: games.deletedAt })
    .from(games)
    .where(and(eq(games.userId, userId), eq(games.id, gameId)))
    .limit(1);
  if (!existing) throw new NotFoundError();
  if (existing.deletedAt === null) throw new NotFoundError();

  await db.transaction(async (tx) => {
    // Delete child listings first (FK constraint order).
    await tx
      .delete(gameSteamListings)
      .where(
        and(eq(gameSteamListings.userId, userId), eq(gameSteamListings.gameId, gameId)),
      );
    await tx
      .delete(games)
      .where(and(eq(games.userId, userId), eq(games.id, gameId)));
  });

  await writeAudit({
    userId,
    action: "game.delete_forever",
    ipAddress,
    metadata: { gameId },
  });
}

/**
 * Per-game derived release-date info — computed from the game's
 * non-deleted Steam listings.
 *
 * Why this helper exists: AGENTS.md no-denorm rule + denormalization-
 * audit-2.md V-2. `games.release_date` / `games.release_tba` were
 * dropped in migration 0047 because the listing rows already own the
 * field and were the only source kept in sync with Steam. The /games
 * list loader and /games/[gameId] detail loader call this helper once
 * per request, then pass each game's derived `{releaseDate, releaseTba}`
 * pair into `toGameDto(gameRow, derived)` so the wire DTO still
 * surfaces the two field names the UI reads.
 *
 * Derivation contract:
 *   - releaseDate: earliest non-null release_date across the game's
 *     non-deleted listings; null when no listings or every listing has
 *     NULL.
 *   - releaseTba: true when any non-deleted listing has release_date
 *     IS NULL (Steam's TBA sentinel for unannounced dates — "Coming
 *     soon" without a concrete date). A game with two listings (one
 *     with a date + one without) renders both: the concrete date
 *     surfaces as releaseDate AND releaseTba is true. UI today renders
 *     "TBA" when releaseTba is true (badge_release_tba), otherwise the
 *     date string — that's fine for the mixed case (a game with a
 *     released main + a TBA DLC reads as TBA, accurate to the listing
 *     mix).
 *
 * Listing.release_date is a free-form string from Steam's appdetails
 * ("Q4 2026" / "14 Mar, 2026"). The min-across-listings comparison
 * now uses Date.parse with an Infinity sentinel for unparseable
 * strings (B-7): concrete dates parse to a millis number and compare
 * chronologically; quarters / "Coming Soon" / other unparseable
 * shapes are treated as Infinity and sort last, so they never beat
 * a real date for the "earliest non-null" pick. This keeps a game
 * whose listings span ["Q4 2026", "14 Mar, 2026"] picking the March
 * 2026 row (the earlier date) instead of letting lexical "1" < "Q"
 * surface the quarter string.
 *
 * Tenant scope: the listing query filters by `eq(gameSteamListings.userId, userId)`
 * AND by `inArray(gameSteamListings.gameId, gameIds)`. Empty input
 * returns an empty map (no query issued).
 */
export async function deriveReleaseInfoForGames(
  userId: string,
  gameIds: string[],
): Promise<Map<string, DerivedReleaseInfo>> {
  const map = new Map<string, DerivedReleaseInfo>();
  if (gameIds.length === 0) return map;

  const rows = await db
    .select({
      gameId: gameSteamListings.gameId,
      releaseDate: gameSteamListings.releaseDate,
    })
    .from(gameSteamListings)
    .where(
      and(
        eq(gameSteamListings.userId, userId),
        inArray(gameSteamListings.gameId, gameIds),
        isNull(gameSteamListings.deletedAt),
      ),
    );

  for (const r of rows) {
    const existing = map.get(r.gameId) ?? { releaseDate: null, releaseTba: false };
    if (r.releaseDate === null) {
      existing.releaseTba = true;
    } else if (existing.releaseDate === null) {
      existing.releaseDate = r.releaseDate;
    } else if (releaseDateMillis(r.releaseDate) < releaseDateMillis(existing.releaseDate)) {
      existing.releaseDate = r.releaseDate;
    }
    map.set(r.gameId, existing);
  }

  return map;
}

/** Parse a free-form Steam release-date string to a comparable number.
 *  Returns Date.parse result for parseable shapes ("14 Mar, 2026" /
 *  "2026-03-14"), Infinity for unparseable shapes ("Q4 2026" / "Coming
 *  Soon"). Infinity sorts last so unparseable strings never beat a
 *  concrete date when picking the earliest. */
function releaseDateMillis(s: string): number {
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? Infinity : ms;
}
