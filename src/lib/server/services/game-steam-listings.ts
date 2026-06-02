// Game Steam Listings service — multi-listing per game (Demo / Full /
// DLC / OST) keyed by Steam appId.
//
// Tenant scope: every Drizzle query filters by
// `eq(<table>.userId, userId)`. `addSteamListing` ALSO calls
// `getGameById(userId, gameId)` first as defense-in-depth — it would
// already be impossible for user A to attach a listing to user B's game
// (the listing INSERT itself includes `userId`, and Postgres would
// reject the FK chain) but the explicit check turns the failure into a
// clean 404 instead of a 23503 foreign_key_violation surfacing as a 500.
//
// fetchSteamAppDetails runs ONCE at INSERT time. If Steam is down or
// returns success:false, we still create the listing with NULL
// cover/release fields and `comingSoon='unavailable'` so the user can
// retry the metadata fetch later via a backfill worker. The listing row
// itself is the source of truth for `app_id` + `game_id` + `label`.
//
// `addSteamListing` translates Postgres 23505 unique_violation on
// `game_steam_listings_game_app_id_unq` into AppError(422,
// 'steam_listing_duplicate', { gameId, appId, existingGameId,
// existingState }). The only remaining listing uniqueness is
// `(game_id, app_id)` UNCONDITIONAL (no `WHERE deleted_at IS NULL`
// clause).
//
// A defensive pre-INSERT same-tenant same-game lookup runs FIRST —
// without an `isNull(deletedAt)` filter — so soft-deleted same-game
// duplicates surface as `existingState='soft_deleted'` BEFORE the
// INSERT (saving a roundtrip + giving the UI the hint to render the
// "use Restore" affordance). The INSERT is wrapped in
// `isPgUniqueViolation` try/catch as the race-window backstop: an
// active row that landed between our SELECT and INSERT translates to
// `existingState='active'`. The pre-INSERT lookup is preferred over a
// partial-WHERE unique constraint because it (i) keeps the existing
// constraint shape, (ii) matches the events soft-delete-Restore UX
// precedent, (iii) keeps audit forensics simple — every (game_id,
// app_id) tuple maps to one historical row chain regardless of
// soft-delete state.
//
// The 422 metadata payload is non-secret (gameId / appId /
// existingGameId / existingState — all non-credential identifiers);
// Pino redact paths unchanged. The payload reaches the user via mapErr
// → JSON response → client-side toast.
//
// Audit policy for this service: reversible listing CRUD (add / soft-remove /
// restore / label edit) writes NO audit row — it's creation/destruction of
// metadata, not security state, and recording every add/remove would balloon
// the log without forensic benefit. The ONE exception is the irreversible
// permanent purge (`hardDeleteListing` → `listing.delete_forever`), which is
// audited like the sibling event/source/game `.delete_forever` verbs.

import { and, eq, isNull, isNotNull, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { gameSteamListings } from "../db/schema/game-steam-listings.js";
import { fetchSteamAppDetails } from "../integrations/steam-api.js";
import { getGameById } from "./games.js";
import { writeAudit } from "../audit.js";
import { AppError, NotFoundError } from "./errors.js";
import { isPgUniqueViolation } from "../db/postgres-errors.js";

export type SteamListingRow = typeof gameSteamListings.$inferSelect;

export interface AddSteamListingInput {
  gameId: string;
  appId: number;
  label?: string;
}

/**
 * Attach a Steam appId to a game. Calls Steam appdetails once; if the
 * fetch fails or returns success:false the row is still created with
 * NULL metadata + `comingSoon='unavailable'` so the listing exists and
 * can be backfilled later.
 *
 * Throws:
 *   - NotFoundError if `input.gameId` does not belong to `userId`
 *     (cross-tenant 404, not 403).
 *   - AppError(422, 'steam_listing_duplicate', { gameId, appId,
 *     existingGameId, existingState }) when an active OR soft-deleted
 *     same-game listing already exists for `(userId, gameId, appId)`.
 *     `existingState` is `'active'` for non-deleted rows and
 *     `'soft_deleted'` for tombstoned rows (pre-INSERT lookup catches
 *     soft-deletes BEFORE the INSERT). The UI reads `existingGameId`
 *     to render an actionable toast ("open game" for active duplicates;
 *     "use Restore" for soft-deleted duplicates).
 *
 *     Cross-game same-appId is ALLOWED: the same Steam appId can attach
 *     to multiple games of the same user (e.g. a Portal-2 main card +
 *     a Portal-2 review-notes card — denorm cost accepted).
 *
 * `ipAddress` is currently unused (no audit row) but kept in the
 * signature for parity with the audited services so callers can pass
 * it through without a service-shape change if the audit vocabulary
 * later expands.
 */
export async function addSteamListing(
  userId: string,
  input: AddSteamListingInput,
  _ipAddress: string,
): Promise<SteamListingRow> {
  // Defense-in-depth: assert ownership BEFORE the INSERT so cross-tenant
  // attempts surface as 404, not a foreign-key violation.
  await getGameById(userId, input.gameId);

  // Pre-INSERT same-tenant same-game lookup. NO `isNull(deletedAt)`
  // filter so soft-deleted dupes surface as
  // existingState='soft_deleted'. Cross-game same-appId is NOT scoped
  // here (different gameId) — falls through to the INSERT, which is
  // the expected path for cross-game listings.
  const existing = await db
    .select({
      id: gameSteamListings.id,
      gameId: gameSteamListings.gameId,
      deletedAt: gameSteamListings.deletedAt,
    })
    .from(gameSteamListings)
    .where(
      and(
        eq(gameSteamListings.userId, userId),
        eq(gameSteamListings.gameId, input.gameId),
        eq(gameSteamListings.appId, input.appId),
      ),
    )
    .limit(1);

  if (existing.length > 0 && existing[0]) {
    const exRow = existing[0];
    throw new AppError("steam listing already exists", "steam_listing_duplicate", 422, {
      gameId: input.gameId,
      appId: input.appId,
      existingGameId: exRow.gameId,
      existingState: exRow.deletedAt === null ? "active" : "soft_deleted",
    });
  }

  const meta = await fetchSteamAppDetails(input.appId);

  // Defense-in-depth try/catch translates the (game_id, app_id)
  // unique-violation race window: an active same-game row that landed
  // between our SELECT above and the INSERT below. Pattern reused from
  // services/data-sources.ts via the shared
  // src/lib/server/db/postgres-errors.ts module. The catch can't know
  // whether the colliding row was soft-deleted post-our-SELECT, so it
  // defaults to existingState='active'; the UI re-fetches the listing
  // list after a 422 to reconcile that edge case.
  let row: SteamListingRow | undefined;
  try {
    [row] = await db
      .insert(gameSteamListings)
      .values({
        userId,
        gameId: input.gameId,
        appId: input.appId,
        label: input.label ?? "",
        // Persist Steam game name when the appdetails fetch succeeded;
        // otherwise NULL (Steam down or success:false). The UI
        // (SteamListingRow) renders `App {appId}` fallback for null rows.
        name: meta?.name ?? null,
        coverUrl: meta?.coverUrl ?? null,
        releaseDate: meta?.releaseDate ?? null,
        comingSoon: meta ? (meta.comingSoon ? "true" : "false") : "unavailable",
        steamGenres: meta?.genres ?? [],
        steamCategories: meta?.categories ?? [],
        rawAppdetails: meta?.raw ?? null,
      })
      .returning();
  } catch (e: unknown) {
    if (isPgUniqueViolation(e)) {
      throw new AppError("steam listing already exists", "steam_listing_duplicate", 422, {
        gameId: input.gameId,
        appId: input.appId,
        existingGameId: input.gameId,
        existingState: "active",
      });
    }
    throw e;
  }
  if (!row) throw new Error("addSteamListing: INSERT returned no row");
  return row;
}

/**
 * List the caller's listings for a given game (excludes soft-deleted by
 * default — restore flow lives on the games service, not here).
 *
 * Throws NotFoundError if the parent game does not belong to userId
 * (defense-in-depth).
 */
export async function listListings(userId: string, gameId: string): Promise<SteamListingRow[]> {
  await getGameById(userId, gameId);
  return db
    .select()
    .from(gameSteamListings)
    .where(
      and(
        eq(gameSteamListings.userId, userId),
        eq(gameSteamListings.gameId, gameId),
        isNull(gameSteamListings.deletedAt),
      ),
    )
    .orderBy(desc(gameSteamListings.createdAt));
}

/**
 * List the caller's SOFT-DELETED listings for a given game.
 *
 * Powers the per-game RecoveryDialog mounted on
 * /games/[gameId]/+page.svelte — same pattern as listSoftDeletedGames
 * on the games service.
 *
 * Throws NotFoundError if the parent game does not belong to userId
 * (defense-in-depth — same pre-check as listListings; cross-tenant
 * gameId surfaces as 404, not 403, per AGENTS.md item 2).
 *
 * Ordered by `deletedAt DESC` so the most recently soft-deleted listing
 * surfaces first in the dialog (mirrors listSoftDeletedGames ordering by
 * createdAt DESC — most-recent-first is the natural recovery UX).
 */
export async function listSoftDeletedListings(
  userId: string,
  gameId: string,
): Promise<SteamListingRow[]> {
  // Tenant scope on (userId, gameId) plus `isNotNull(deletedAt)` filter
  // is exactly the inverse of listListings's `isNull(deletedAt)`. Cross-
  // tenant gameId returns an empty array by construction (the userId
  // filter prunes it before isNotNull discrimination); the page-level
  // loader has already validated the parent via getGameById, so a
  // legitimate empty array here is simply "no soft-deleted listings yet".
  return db
    .select()
    .from(gameSteamListings)
    .where(
      and(
        eq(gameSteamListings.userId, userId),
        eq(gameSteamListings.gameId, gameId),
        isNotNull(gameSteamListings.deletedAt),
      ),
    )
    .orderBy(desc(gameSteamListings.deletedAt));
}

/**
 * Restore a soft-deleted listing.
 *
 * Mirrors `restoreSource` (data-sources service): sets `deletedAt = NULL`
 * + bumps `updatedAt`, scoped to (userId, gameId, listingId) AND requiring
 * `deletedAt IS NOT NULL` so the operation is idempotent for the dialog
 * (calling restore on an already-active row throws NotFoundError instead
 * of silently no-op'ing — the UI should not surface this case).
 *
 * Wrapped in `db.transaction` so a partial-write race window cannot
 * leave the listing in an inconsistent state. The
 * audit-write-OUTSIDE-the-transaction pattern from softDeleteSource is
 * N/A here because no audit verb is recorded for listing CRUD — see
 * file-header rationale.
 *
 * Throws NotFoundError on:
 *   - cross-tenant gameId / listingId (404, not 403)
 *   - already-active row (deletedAt IS NULL — programming error)
 *   - non-existent row
 *
 * No retention-window check — listings have no retention purge worker
 * yet; rows keep `deletedAt` indefinitely. When a purge job lands,
 * mirror restoreSource's 422 retention_expired path here too.
 */
export async function restoreListing(
  userId: string,
  gameId: string,
  listingId: string,
  _ipAddress: string,
): Promise<SteamListingRow> {
  return db.transaction(async (tx) => {
    // Defense-in-depth pre-check: even though the UPDATE's WHERE clause
    // already enforces (userId, gameId, listingId), the explicit SELECT
    // gives us a clean NotFoundError discriminator between "row exists
    // but is not soft-deleted" and "row does not exist / cross-tenant".
    const [existing] = await tx
      .select()
      .from(gameSteamListings)
      .where(
        and(
          eq(gameSteamListings.userId, userId),
          eq(gameSteamListings.gameId, gameId),
          eq(gameSteamListings.id, listingId),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundError();
    if (existing.deletedAt === null) throw new NotFoundError();

    const [row] = await tx
      .update(gameSteamListings)
      .set({ deletedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(gameSteamListings.userId, userId),
          eq(gameSteamListings.gameId, gameId),
          eq(gameSteamListings.id, listingId),
        ),
      )
      .returning();
    if (!row) throw new NotFoundError();
    return row;
  });
}

/**
 * Update mutable fields on a listing.
 *
 * Today the only editable field is `label` (the user's free-text "Demo
 * / Full / DLC / OST" tag). Future work extends this to the rest of
 * the per-listing edit form (release-date / categories override) — the
 * signature is shaped so adding a field is one optional input + one
 * patch line, no breaking change.
 *
 * Tenant scope: scoped to (userId, gameId, listingId) AND requires
 * `deletedAt IS NULL` so the operation can't accidentally surface
 * soft-deleted rows. The double constraint (gameId AND listingId) is
 * defense-in-depth — a future caller that confuses listing IDs across
 * games gets a clean 404 instead of a cross-game label edit.
 *
 * Throws NotFoundError on:
 *   - cross-tenant gameId / listingId (404, not 403)
 *   - mismatched gameId/listingId (listing belongs to a different game)
 *   - soft-deleted row (use restoreListing first)
 *   - non-existent row
 *
 * Wrapped in `db.transaction` so a partial-write race window cannot
 * leave the listing in an inconsistent state. Today it's a single
 * UPDATE; the transaction wrap is forward-compat for the future
 * field-set extension (which will likely involve a pre-update SELECT
 * + computed merge).
 *
 * No audit row (listing CRUD is metadata, not security state).
 */
export async function updateListing(
  userId: string,
  gameId: string,
  listingId: string,
  fields: { label?: string },
): Promise<SteamListingRow> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(gameSteamListings)
      .where(
        and(
          eq(gameSteamListings.userId, userId),
          eq(gameSteamListings.gameId, gameId),
          eq(gameSteamListings.id, listingId),
          isNull(gameSteamListings.deletedAt),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundError();

    const patch: Partial<typeof gameSteamListings.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (fields.label !== undefined) patch.label = fields.label;

    const [row] = await tx
      .update(gameSteamListings)
      .set(patch)
      .where(
        and(
          eq(gameSteamListings.userId, userId),
          eq(gameSteamListings.gameId, gameId),
          eq(gameSteamListings.id, listingId),
          isNull(gameSteamListings.deletedAt),
        ),
      )
      .returning();
    if (!row) throw new NotFoundError();
    return row;
  });
}

/**
 * Soft-delete one listing. The parent game is unaffected; if the parent
 * is also soft-deleted later, the listing's existing `deletedAt`
 * differs from the parent's marker so a future restore will NOT bring
 * this listing back (marker-timestamp design — earlier deletes stay
 * deleted).
 *
 * Scoped to (userId, gameId, listingId) — the `gameId` filter is
 * defense-in-depth matching hardDeleteListing/updateListing, so a
 * listing the caller owns under a DIFFERENT game cannot be soft-deleted
 * via the wrong game's route.
 *
 * Throws NotFoundError on miss / cross-tenant / mismatched gameId.
 */
export async function removeSteamListing(
  userId: string,
  gameId: string,
  listingId: string,
  _ipAddress: string,
): Promise<void> {
  const [row] = await db
    .update(gameSteamListings)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(gameSteamListings.userId, userId),
        eq(gameSteamListings.gameId, gameId),
        eq(gameSteamListings.id, listingId),
        isNull(gameSteamListings.deletedAt),
      ),
    )
    .returning({ id: gameSteamListings.id });
  if (!row) throw new NotFoundError();
}

/**
 * Permanently delete a soft-deleted listing (hard purge from the trash
 * view). Mirrors `hardDeleteGame` (games service): operates ONLY on a row
 * already soft-deleted (`deletedAt IS NOT NULL`); an active or non-existent
 * or cross-tenant row throws NotFoundError (404, not 403 — same semantics
 * as restoreListing).
 *
 * `wishlist_snapshots` rows attached to this listing cascade-delete via
 * the `listing_id` FK `ON DELETE cascade` (schema/wishlist-snapshots.ts) —
 * no explicit child delete needed.
 *
 * Scoped to (userId, gameId, listingId) with an `isNotNull(deletedAt)`
 * predicate so a single DELETE … RETURNING enforces the soft-deleted-only
 * rule atomically — no pre-check SELECT, no race window against a concurrent
 * restore (an active row simply does not match the WHERE).
 *
 * Audited (`listing.delete_forever`, after commit) — unlike the reversible
 * soft-delete / restore / update, a permanent purge is irreversible data
 * destruction and is security-relevant, symmetric with the sibling
 * `event/source/game .delete_forever` verbs. Metadata: { gameId, listingId, appId }.
 */
export async function hardDeleteListing(
  userId: string,
  gameId: string,
  listingId: string,
  ipAddress: string,
): Promise<void> {
  // Single statement enforces the soft-deleted-only rule atomically: the
  // `isNotNull(deletedAt)` predicate in the DELETE's WHERE means a row that is
  // missing, cross-tenant, OR active (not soft-deleted) simply matches nothing
  // and `returning` comes back empty → NotFoundError (404, never 403). The
  // returned appId feeds the audit metadata.
  const [deleted] = await db
    .delete(gameSteamListings)
    .where(
      and(
        eq(gameSteamListings.userId, userId),
        eq(gameSteamListings.gameId, gameId),
        eq(gameSteamListings.id, listingId),
        isNotNull(gameSteamListings.deletedAt),
      ),
    )
    .returning({ appId: gameSteamListings.appId });
  if (!deleted) throw new NotFoundError();
  const appId = deleted.appId;

  // Audit AFTER commit (irreversible purge). writeAudit never throws.
  await writeAudit({
    userId,
    action: "listing.delete_forever",
    ipAddress,
    metadata: { gameId, listingId, appId },
  });
}

/**
 * Attach (or detach with `keyId=null`) a Steamworks API key to this
 * listing. The FK on `api_key_id` is set null on key delete, so detach
 * happens implicitly when a key is removed.
 *
 * Throws NotFoundError on miss / cross-tenant.
 */
export async function attachKeyToListing(
  userId: string,
  listingId: string,
  keyId: string | null,
): Promise<SteamListingRow> {
  const [row] = await db
    .update(gameSteamListings)
    .set({ apiKeyId: keyId, updatedAt: new Date() })
    .where(
      and(
        eq(gameSteamListings.userId, userId),
        eq(gameSteamListings.id, listingId),
        isNull(gameSteamListings.deletedAt),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError();
  return row;
}
