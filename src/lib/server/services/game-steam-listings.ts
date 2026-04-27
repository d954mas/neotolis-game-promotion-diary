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
// NO audit entries from this service (D-32): the audit verbs `key.*`,
// `game.*`, `item.*`, `event.*`, `theme.*`, `session.*` cover the
// security-relevant operations. Listing CRUD is creation/destruction of
// metadata, not security state — recording every add/remove would balloon
// the audit log without forensic benefit.

import { and, eq, isNull, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { gameSteamListings } from "../db/schema/game-steam-listings.js";
import { fetchSteamAppDetails } from "../integrations/steam-api.js";
import { getGameById } from "./games.js";
import { NotFoundError } from "./errors.js";

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
 *     (cross-tenant 404, not 403 — PRIV-01)
 *   - the raw pg duplicate-key error if (game_id, app_id) or
 *     (user_id, app_id) already exists; Plan 02-08 translates that to
 *     a 409 at the route boundary
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

  const meta = await fetchSteamAppDetails(input.appId);
  const [row] = await db
    .insert(gameSteamListings)
    .values({
      userId,
      gameId: input.gameId,
      appId: input.appId,
      label: input.label ?? "",
      coverUrl: meta?.coverUrl ?? null,
      releaseDate: meta?.releaseDate ?? null,
      comingSoon: meta ? (meta.comingSoon ? "true" : "false") : "unavailable",
      steamGenres: meta?.genres ?? [],
      steamCategories: meta?.categories ?? [],
      rawAppdetails: meta?.raw ?? null,
    })
    .returning();
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
