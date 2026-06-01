// Wishlist-snapshots service — tenant-scoped Steam wishlist CSV import +
// summary/recent reads (WISH-02).
//
// Tenant scope (D-06, load-bearing): every function takes `userId` as the
// first non-optional arg and every Drizzle query filters by
// `eq(wishlistSnapshots.userId, userId)`. Cross-tenant access returns 404
// (NotFoundError) via the listing ownership gate, NEVER 403.
//
// Import flow:
//   1. Ownership gate FIRST — a userId+gameId+listingId-scoped SELECT of
//      the parent listing. Absent → NotFoundError (cross-tenant 404). This
//      runs BEFORE any wishlist write, so a cross-tenant attempt mutates
//      nothing. The listing row also yields `appId` for the audit metadata.
//   2. parseWishlistCsv (Plan 03.2-02) — lets AppError(422,
//      'wishlist_csv_invalid_header') propagate to mapErr.
//   3. Derive cumulative balance over DATE-ASCENDING rows (RESEARCH.md
//      Option 1, all-history assumption): the CSV is the full daily history
//      from the game's launch, so the running sum of
//      (adds − deletes − purchasesAndActivations − gifts) is the absolute
//      outstanding-wishlist balance on each day. Balance is the SERVICE's
//      job, not the parser's.
//   4. Idempotent upsert (D-05 last-write-wins) on (listing_id, date) —
//      ON CONFLICT DO UPDATE. `updated` = how many imported dates already
//      existed (one scoped SELECT before the upsert; KISS).
//   5. AFTER the transaction commits, write the `wishlist.imported` audit
//      row with { appId, listingId, rowCount, dateRange, skipped }.
//
// NO DENORMALIZATION: the listing/game display name is never copied onto
// snapshot rows — only the listingId FK (AGENTS.md).

import { and, eq, isNull, desc, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { wishlistSnapshots } from "../db/schema/wishlist-snapshots.js";
import { gameSteamListings } from "../db/schema/game-steam-listings.js";
import { parseWishlistCsv } from "../csv/parse-wishlist-csv.js";
import { writeAudit } from "../audit.js";
import { AppError, NotFoundError } from "./errors.js";
import { toWishlistSnapshotDto, type WishlistSnapshotDto } from "../dto.js";

export interface ImportWishlistResult {
  rowCount: number;
  updated: number;
  skipped: number;
  dateRange: { from: string; to: string };
}

/**
 * Import a Steamworks Wishlists.csv scoped to one listing.
 *
 * Throws:
 *   - NotFoundError if the listing does not belong to (userId, gameId)
 *     (cross-tenant / mismatched listingId → 404, never 403).
 *   - AppError(422, 'wishlist_csv_invalid_header') from parseWishlistCsv on
 *     a bad/missing required header or empty input (propagated to mapErr).
 */
export async function importWishlistCsv(
  userId: string,
  gameId: string,
  listingId: string,
  csvText: string,
  ipAddress: string,
  fileName: string | null = null,
): Promise<ImportWishlistResult> {
  // Ownership gate FIRST — cross-tenant / mismatched listingId → 404 before
  // any wishlist write. Also yields appId for the audit metadata.
  const [listing] = await db
    .select({ appId: gameSteamListings.appId })
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
  if (!listing) throw new NotFoundError();

  // Wrong-game guard: Steam names the export
  // `SteamWishlists_{appId}_{from}_to_{to}.csv`. If the filename carries an
  // appId that doesn't match this listing, the user picked the wrong listing —
  // reject before writing. A renamed file (no appId in the name) can't be
  // checked, so we allow it; the listing binding still scopes the data (D-07).
  if (fileName) {
    const m = /(?:^|[/\\])SteamWishlists_(\d+)_/i.exec(fileName);
    if (m && Number(m[1]) !== listing.appId) {
      throw new AppError(
        `wishlist_csv_app_mismatch: file is for app ${m[1]}, this listing is app ${listing.appId}`,
        "wishlist_csv_app_mismatch",
        422,
      );
    }
  }

  const { rows, skipped } = parseWishlistCsv(csvText);

  if (rows.length === 0) {
    return { rowCount: 0, updated: 0, skipped, dateRange: { from: "", to: "" } };
  }

  // Date-ascending so the cumulative balance accumulates in chronological
  // order. ISO YYYY-MM-DD sorts lexicographically === chronologically.
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

  // Provisional per-row balance (running sum within THIS file). It is the
  // authoritative value only for a full-history import; the recompute step
  // below (cumulative over the WHOLE stored series) corrects it so a partial
  // import — e.g. a 1-week range layered onto a year already stored — can't
  // overwrite earlier days' balances with a wrong from-zero value.
  let running = 0;
  const values = sorted.map((r) => {
    running += r.adds - r.deletes - r.purchasesAndActivations - r.gifts;
    return {
      userId,
      listingId,
      date: r.date,
      adds: r.adds,
      deletes: r.deletes,
      purchasesAndActivations: r.purchasesAndActivations,
      gifts: r.gifts,
      balance: running,
      source: "csv",
    };
  });

  const importDates = values.map((v) => v.date);

  const updated = await db.transaction(async (tx) => {
    // Count how many of the imported dates already exist for this listing
    // (tenant-scoped) → the `updated` (conflict) count. KISS — one scoped
    // SELECT beats inspecting xmax.
    const existing = await tx
      .select({ date: wishlistSnapshots.date })
      .from(wishlistSnapshots)
      .where(
        and(
          eq(wishlistSnapshots.userId, userId),
          eq(wishlistSnapshots.listingId, listingId),
          inArray(wishlistSnapshots.date, importDates),
        ),
      );

    await tx
      .insert(wishlistSnapshots)
      .values(values)
      .onConflictDoUpdate({
        target: [wishlistSnapshots.listingId, wishlistSnapshots.date],
        // Per-row conflict values come from the rejected INSERT row via
        // the `excluded` pseudo-table (batch upsert: each (listing,date)
        // tuple takes its own row's recomputed balance/components).
        set: {
          adds: sql`excluded.adds`,
          deletes: sql`excluded.deletes`,
          purchasesAndActivations: sql`excluded.purchases_and_activations`,
          gifts: sql`excluded.gifts`,
          balance: sql`excluded.balance`,
          source: sql`excluded.source`,
          // Postgres clock (not Node's `new Date()`) so updatedAt shares the
          // same clock source as createdAt's `defaultNow()` — a consumer
          // comparing the two never sees client/server clock skew.
          updatedAt: sql`now()`,
        },
      });

    // Recompute `balance` as the cumulative sum over the ENTIRE stored series
    // for this listing (date-ordered), not just the rows in this file. This is
    // what makes balance correct under partial / out-of-order / repeated
    // imports: it's always a function of all stored daily components. Tenant-
    // scoped by (user_id, listing_id) in the subquery. Only rows whose derived
    // value actually changes are touched (keeps re-imports a no-op here).
    await tx.execute(sql`
      UPDATE wishlist_snapshots AS w
      SET balance = s.run
      FROM (
        SELECT id,
               SUM(adds - deletes - purchases_and_activations - gifts)
                 OVER (ORDER BY date) AS run
        FROM wishlist_snapshots
        WHERE user_id = ${userId} AND listing_id = ${listingId}
      ) AS s
      WHERE w.id = s.id AND w.balance IS DISTINCT FROM s.run
    `);

    return existing.length;
  });

  const dateRange = { from: sorted[0]!.date, to: sorted[sorted.length - 1]!.date };

  // Audit AFTER commit (D-04). writeAudit never throws (swallows + logs).
  await writeAudit({
    userId,
    action: "wishlist.imported",
    ipAddress,
    metadata: { appId: listing.appId, listingId, rowCount: rows.length, dateRange, skipped },
  });

  return { rowCount: rows.length, updated, skipped, dateRange };
}

export interface WishlistSummary {
  balance: number;
  lastDate: string;
  recentDays: WishlistSnapshotDto[];
}

/**
 * Latest balance + date + the last ≤14 daily rows (DESC) for a listing.
 * Returns null when the listing has no snapshots. Tenant-scoped — a
 * cross-tenant listingId yields null (no rows match the userId filter).
 */
export async function getWishlistSummary(
  userId: string,
  listingId: string,
): Promise<WishlistSummary | null> {
  const rows = await listRecentSnapshots(userId, listingId, 14);
  if (rows.length === 0) return null;
  const latest = rows[0]!;
  return { balance: latest.balance, lastDate: latest.date, recentDays: rows };
}

/**
 * Tenant-scoped date-DESC list of the most recent `limit` snapshots for a
 * listing. Cross-tenant listingId yields an empty array.
 */
export async function listRecentSnapshots(
  userId: string,
  listingId: string,
  limit = 14,
): Promise<WishlistSnapshotDto[]> {
  const rows = await db
    .select()
    .from(wishlistSnapshots)
    .where(
      and(eq(wishlistSnapshots.userId, userId), eq(wishlistSnapshots.listingId, listingId)),
    )
    .orderBy(desc(wishlistSnapshots.date))
    .limit(limit);
  return rows.map(toWishlistSnapshotDto);
}
