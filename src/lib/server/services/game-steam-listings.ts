// Game Steam Listings service — multi-listing per game (Demo / Full / DLC / OST)
// keyed by Steam appId. D-06 + D-10.
//
// Pattern 1 (tenant scope): every Drizzle query filters by `eq(<table>.userId, userId)`.
// `addSteamListing` ALSO calls `getGameById(userId, gameId)` first as defense-in-depth —
// it would already be impossible for user A to attach a listing to user B's game
// (the listing INSERT itself includes `userId`, and Postgres would reject the FK
// chain) but the explicit check turns the failure into a clean 404 instead of a
// 23503 foreign_key_violation surfacing as a 500.
//
// fetchSteamAppDetails runs ONCE at INSERT time. If Steam is down or returns
// success:false, we still create the listing with NULL cover/release fields
// and `comingSoon='unavailable'` so the user can retry the metadata fetch
// later (Phase 6 backfill worker). The listing row itself is the source of
// truth for `app_id` + `game_id` + `label`.
//
// Plan 02.1-29 (UAT-NOTES.md §4.25.E + §4.25.G): `addSteamListing` translates
// Postgres 23505 unique_violation on `game_steam_listings_game_app_id_unq`
// into AppError(422, 'steam_listing_duplicate', { gameId, appId,
// existingGameId, existingState }). Plan 02.1-27 dropped the user-scoped
// `(user_id, app_id)` constraint; the only remaining listing uniqueness is
// `(game_id, app_id)` UNCONDITIONAL (no `WHERE deleted_at IS NULL` clause).
//
// Path B (Plan 02.1-29): a defensive pre-INSERT same-tenant same-game lookup
// runs FIRST — without an `isNull(deletedAt)` filter — so soft-deleted same-
// game duplicates surface as `existingState='soft_deleted'` BEFORE the
// INSERT (saving a roundtrip + giving the UI the hint to render the "use
// Restore" affordance). The INSERT is wrapped in `isPgUniqueViolation`
// try/catch as the race-window backstop: an active row that landed
// between our SELECT and INSERT translates to `existingState='active'`.
// Path B chosen over Path A (partial-WHERE constraint) because it (i)
// doesn't require changing Plan 02.1-27's constraint shape, (ii) matches
// the Plan 02.1-14 events soft-delete-Restore UX precedent, (iii) keeps
// audit forensics simple — every (game_id, app_id) tuple maps to one
// historical row chain regardless of soft-delete state.
//
// The 422 metadata payload is non-secret (gameId / appId / existingGameId /
// existingState — all non-credential identifiers); Pino redact paths
// unchanged. The payload reaches the user via mapErr → JSON response →
// Plan 02.1-30 client-side toast.
//
// NO audit entries from this service (D-32): the audit verbs `key.*`,
// `game.*`, `item.*`, `event.*`, `theme.*`, `session.*` cover the
// security-relevant operations. Listing CRUD is creation/destruction of
// metadata, not security state — recording every add/remove would balloon
// the audit log without forensic benefit.

import { and, eq, isNull, isNotNull, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { gameSteamListings } from "../db/schema/game-steam-listings.js";
import { fetchSteamAppDetails } from "../integrations/steam-api.js";
import { getGameById } from "./games.js";
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
 *     (cross-tenant 404, not 403 — PRIV-01).
 *   - AppError(422, 'steam_listing_duplicate', { gameId, appId,
 *     existingGameId, existingState }) when an active OR soft-deleted
 *     same-game listing already exists for `(userId, gameId, appId)`.
 *     `existingState` is `'active'` for non-deleted rows and
 *     `'soft_deleted'` for tombstoned rows (Plan 02.1-29 / Path B —
 *     pre-INSERT lookup catches soft-deletes BEFORE the INSERT). Plan
 *     02.1-30's UI reads `existingGameId` to render an actionable toast
 *     ("open game" for active duplicates; "use Restore" for soft-
 *     deleted duplicates).
 *
 *     Cross-game same-appId is ALLOWED (post-Plan-02.1-27 the
 *     user-scoped unique constraint is gone): the same Steam appId can
 *     attach to multiple games of the same user (e.g. a Portal-2 main
 *     card + a Portal-2 review-notes card — denorm cost accepted).
 *
 * `ipAddress` is currently unused (no audit row per D-32) but kept in
 * the signature for parity with the audited services and so Plan 02-08
 * can pass it through without a service-shape change if the audit
 * vocabulary later expands.
 */
export async function addSteamListing(
  userId: string,
  input: AddSteamListingInput,
  _ipAddress: string,
): Promise<SteamListingRow> {
  // Defense-in-depth: assert ownership BEFORE the INSERT so cross-tenant
  // attempts surface as 404, not a foreign-key violation.
  await getGameById(userId, input.gameId);

  // Plan 02.1-29 Path B — pre-INSERT same-tenant same-game lookup. NO
  // `isNull(deletedAt)` filter so soft-deleted dupes surface as
  // existingState='soft_deleted'. Cross-game same-appId is NOT scoped
  // here (different gameId) — falls through to the INSERT, which is
  // the post-Plan-02.1-27 expected path.
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
    throw new AppError(
      "steam listing already exists",
      "steam_listing_duplicate",
      422,
      {
        gameId: input.gameId,
        appId: input.appId,
        existingGameId: exRow.gameId,
        existingState: exRow.deletedAt === null ? "active" : "soft_deleted",
      },
    );
  }

  const meta = await fetchSteamAppDetails(input.appId);

  // Plan 02.1-29 — defense-in-depth try/catch translates the (game_id,
  // app_id) unique-violation race window: an active same-game row that
  // landed between our SELECT above and the INSERT below. Pattern reused
  // from Plan 02.1-04 services/data-sources.ts (now via the shared
  // src/lib/server/db/postgres-errors.ts module). The catch can't know
  // whether the colliding row was soft-deleted post-our-SELECT, so it
  // defaults to existingState='active'; Plan 02.1-30's UI re-fetches
  // the listing list after a 422 to reconcile that edge case.
  let row: SteamListingRow | undefined;
  try {
    [row] = await db
      .insert(gameSteamListings)
      .values({
        userId,
        gameId: input.gameId,
        appId: input.appId,
        label: input.label ?? "",
        // Plan 02.1-25: persist Steam game name when the appdetails fetch
        // succeeded; otherwise NULL (Steam down or success:false). The UI
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
      throw new AppError(
        "steam listing already exists",
        "steam_listing_duplicate",
        422,
        {
          gameId: input.gameId,
          appId: input.appId,
          existingGameId: input.gameId,
          existingState: "active",
        },
      );
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
 * List the caller's SOFT-DELETED listings for a given game (Plan 02.1-39
 * round-6 polish #12 — UAT-NOTES.md §5.8 follow-up #12, 2026-04-30).
 *
 * User during round-6 UAT after `d4d55eb` extended <RecoveryDialog> to
 * /games + /sources reported (verbatim, ru):
 *   "и я удалил стор, и теперь нет вохзможности его восстановить"
 *   ("and I deleted a store, and now there's no way to restore it")
 *
 * The schema's `deletedAt` column has been carrying soft-delete state
 * since Plan 02.1-04; only the recovery UI/endpoint was missing. This
 * function powers the per-game RecoveryDialog mounted on
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
 * Restore a soft-deleted listing (Plan 02.1-39 round-6 polish #12).
 *
 * Mirrors `restoreSource` (data-sources service): sets `deletedAt = NULL`
 * + bumps `updatedAt`, scoped to (userId, gameId, listingId) AND requiring
 * `deletedAt IS NOT NULL` so the operation is idempotent for the dialog
 * (calling restore on an already-active row throws NotFoundError instead
 * of silently no-op'ing — the UI should not surface this case).
 *
 * Wrapped in `db.transaction` per the round-5 §5.12 invariant fix
 * (Plan 02.1-39 §5.12 closure — multi-step writes go through a
 * transaction so a partial-write race window cannot leave the listing
 * in an inconsistent state). The audit-write-OUTSIDE-the-transaction
 * pattern from softDeleteSource is N/A here because no audit verb is
 * recorded for listing CRUD (D-32 — see file-header rationale).
 *
 * Throws NotFoundError on:
 *   - cross-tenant gameId / listingId (PRIV-01: 404, not 403)
 *   - already-active row (deletedAt IS NULL — programming error)
 *   - non-existent row
 *
 * No retention-window check (Plan 02.1-39 round-6 #12 design — listings
 * have no retention purge worker yet; row keeps `deletedAt` indefinitely
 * until Phase 6+ adds a purge job. When that lands, mirror restoreSource's
 * 422 retention_expired path here too.)
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
 * Update mutable fields on a listing (Plan 02.1-39 round-6 polish #14c
 * — UAT-NOTES.md §5.8 follow-up #14, 2026-04-30).
 *
 * User during round-6 UAT (verbatim, ru):
 *   "При редактировании стора, я бы хотел иметь возможноть поменять label.
 *    И вот мне не понятно что так лейбл и где"
 *   ("When editing a store, I'd like to be able to change the label.
 *    And I don't understand what 'label' is or where it lives.")
 *
 * Today the only editable field is `label` (the user's free-text "Demo
 * / Full / DLC / OST" tag). Future phases extend this to the rest of
 * the §5.3 item B "full Steam-listing edit form" (release-date /
 * categories override) — the signature is shaped so adding a field is
 * one optional input + one patch line, no breaking change.
 *
 * Tenant scope: scoped to (userId, gameId, listingId) AND requires
 * `deletedAt IS NULL` so the operation can't accidentally surface
 * soft-deleted rows. The double constraint (gameId AND listingId) is
 * defense-in-depth — a future caller that confuses listing IDs across
 * games gets a clean 404 instead of a cross-game label edit.
 *
 * Throws NotFoundError on:
 *   - cross-tenant gameId / listingId (PRIV-01: 404, not 403)
 *   - mismatched gameId/listingId (listing belongs to a different game)
 *   - soft-deleted row (use restoreListing first)
 *   - non-existent row
 *
 * Wrapped in `db.transaction` per the round-5 §5.12 invariant fix
 * (multi-step writes go through a transaction so a partial-write race
 * window cannot leave the listing in an inconsistent state). Today
 * it's a single UPDATE; the transaction wrap is forward-compat for
 * the future field-set extension (which will likely involve a
 * pre-update SELECT + computed merge).
 *
 * No audit row (D-32: listing CRUD is metadata, not security state).
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
 * this listing back (D-23 design — earlier deletes stay deleted).
 *
 * Throws NotFoundError on miss / cross-tenant.
 */
export async function removeSteamListing(
  userId: string,
  listingId: string,
  _ipAddress: string,
): Promise<void> {
  const [row] = await db
    .update(gameSteamListings)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(gameSteamListings.userId, userId),
        eq(gameSteamListings.id, listingId),
        isNull(gameSteamListings.deletedAt),
      ),
    )
    .returning({ id: gameSteamListings.id });
  if (!row) throw new NotFoundError();
}

/**
 * Attach (or detach with `keyId=null`) a Steamworks API key to this
 * listing. Plan 02-05 lands the key creation; Plan 02-08 wires the
 * route. The FK on `api_key_id` is set null on key delete, so detach
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
