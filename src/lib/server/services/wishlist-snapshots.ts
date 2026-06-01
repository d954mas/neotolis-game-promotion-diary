// Wishlist-snapshots service — tenant-scoped Steam wishlist CSV import +
// summary/recent reads (WISH-02).
//
// Cross-tenant access returns 404 (NotFoundError) via the listing ownership
// gate, NEVER 403.
//
// Import flow:
//   1. Ownership gate FIRST — a userId+gameId+listingId-scoped SELECT of
//      the parent listing. Absent → NotFoundError. Runs BEFORE any wishlist
//      write, so a cross-tenant attempt mutates nothing. The listing row also
//      yields `appId` for the audit metadata.
//   2. parseWishlistCsv — lets AppError(422, 'wishlist_csv_invalid_header')
//      propagate to mapErr.
//   3. Derive cumulative balance over date-ascending rows. The CSV is assumed
//      to be the full daily history from the game's launch, so the running sum
//      of (adds − deletes − purchasesAndActivations − gifts) is the absolute
//      outstanding-wishlist balance on each day.
//   4. Idempotent last-write-wins upsert on (listing_id, date).
//   5. AFTER the transaction commits, write the `wishlist.imported` audit row.
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
import {
  toWishlistSnapshotDto,
  type WishlistSnapshotDto,
  type WishlistSummaryDto,
} from "../dto.js";

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
  // reject before writing. SECURITY: the appId compared here is the LISTING's,
  // never one taken from the file contents, so a crafted file can't redirect
  // the import. A renamed file (no appId in the name) can't be checked, so we
  // allow it; the listing binding still scopes the data.
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
    // A header-valid file whose data rows were ALL malformed (skipped > 0) is a
    // FAILED import, not an empty one — surface 422 so the UI says "rows
    // couldn't be read" instead of a misleading "no rows found / success".
    // A genuinely empty data section (skipped === 0) keeps the empty result.
    if (skipped > 0) {
      throw new AppError(
        `wishlist_csv_no_valid_rows: ${skipped} malformed rows, none parseable`,
        "wishlist_csv_no_valid_rows",
        422,
      );
    }
    return { rowCount: 0, updated: 0, skipped, dateRange: { from: "", to: "" } };
  }

  // Date-ascending for a deterministic insert order + the reported dateRange.
  // ISO YYYY-MM-DD sorts lexicographically === chronologically.
  const sortedRaw = [...rows].sort((a, b) => a.date.localeCompare(b.date));

  // De-duplicate by date BEFORE building `values`: a single CSV can carry two
  // rows with the same DateLocal, which would produce two identical
  // (listingId, date) tuples in one INSERT and make `ON CONFLICT DO UPDATE`
  // raise Postgres 21000 ("ON CONFLICT DO UPDATE command cannot affect row a
  // second time"). Last occurrence wins — a later row in the file supersedes
  // an earlier same-date row. The Map preserves first-seen insertion order, so
  // re-sort after collecting to keep the date-ascending contract for `values`,
  // `importDates`, and `dateRange`.
  const byDate = new Map<string, (typeof sortedRaw)[number]>();
  for (const r of sortedRaw) byDate.set(r.date, r);
  const sorted = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  // INSERT carries a placeholder balance (0). Balance is derived in ONE place:
  // the cumulative recompute over the WHOLE stored series after the upsert
  // (below). Single source of truth — no per-file running sum that a partial
  // import (e.g. a 1-week range over a year already stored) could persist as a
  // wrong from-zero value.
  const values = sorted.map((r) => ({
    userId,
    listingId,
    date: r.date,
    adds: r.adds,
    deletes: r.deletes,
    purchasesAndActivations: r.purchasesAndActivations,
    gifts: r.gifts,
    balance: 0,
    source: "csv",
  }));

  const importDates = values.map((v) => v.date);

  const updated = await db.transaction(async (tx) => {
    // Serialize concurrent imports to the SAME listing. The upsert + whole-
    // series balance recompute below read-then-write the listing's snapshot
    // set, so two parallel imports under READ COMMITTED could each recompute
    // from a stale view and clobber the other's balances. A per-listing
    // advisory xact lock makes them queue instead of racing (released on
    // commit/rollback).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${listingId}, 0))`);

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
    // for this listing (date-ordered), not just the rows in this file — so it's
    // correct under partial / out-of-order / repeated imports. Tenant-scoped by
    // (user_id, listing_id) in the subquery. Only rows whose derived value
    // actually changes are touched (keeps re-imports a no-op here). Concurrent
    // imports to the same listing are serialized by the advisory xact lock
    // taken at the top of this transaction, so this recompute always sees a
    // consistent series.
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

  // rowCount reflects the DEDUPED row count (`sorted.length`), not the raw
  // parsed-row count — duplicate same-date rows collapse to one upserted row.
  const rowCount = sorted.length;

  // Audit AFTER commit. writeAudit never throws (swallows + logs).
  await writeAudit({
    userId,
    action: "wishlist.imported",
    ipAddress,
    metadata: { appId: listing.appId, listingId, rowCount, dateRange, skipped },
  });

  return { rowCount, updated, skipped, dateRange };
}

// One shape, one home: the summary wire type lives in dto.ts
// (WishlistSummaryDto). The service exports it under its existing name so
// callers (the /games loader) keep importing `WishlistSummary` unchanged.
export type WishlistSummary = WishlistSummaryDto;

/**
 * Latest balance + the coverage window (firstDate…lastDate) + the last ≤14
 * daily rows (DESC) for a listing. Returns null when the listing has no
 * snapshots. Tenant-scoped — a cross-tenant listingId yields null (no rows
 * match the userId filter).
 *
 * `firstDate` is the TRUE earliest snapshot date across the whole stored
 * series — NOT `recentDays[last]`, which is capped at 14 rows and so would
 * understate coverage for a longer series. The headline `balance` is a
 * running cumulative anchored at `firstDate`; surfacing it lets the UI show
 * the user the number covers "since {firstDate}" rather than implying it is
 * the absolute launch-to-now balance. One extra bounded MIN query (KISS).
 */
export async function getWishlistSummary(
  userId: string,
  listingId: string,
): Promise<WishlistSummary | null> {
  const rows = await listRecentSnapshots(userId, listingId, 14);
  if (rows.length === 0) return null;
  const latest = rows[0]!;
  // Dedicated MIN(date) over the WHOLE series — recentDays caps at 14, so its
  // oldest row is NOT the true coverage start for a longer series. An aggregate
  // SELECT always returns exactly one row, and rows.length > 0 above guarantees
  // a non-null MIN, so the `!` is sound.
  const [agg] = await db
    .select({ firstDate: sql<string>`min(${wishlistSnapshots.date})` })
    .from(wishlistSnapshots)
    .where(and(eq(wishlistSnapshots.userId, userId), eq(wishlistSnapshots.listingId, listingId)));
  return {
    balance: latest.balance,
    firstDate: agg!.firstDate,
    lastDate: latest.date,
    recentDays: rows,
  };
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
    .where(and(eq(wishlistSnapshots.userId, userId), eq(wishlistSnapshots.listingId, listingId)))
    .orderBy(desc(wishlistSnapshots.date))
    .limit(limit);
  return rows.map(toWishlistSnapshotDto);
}
