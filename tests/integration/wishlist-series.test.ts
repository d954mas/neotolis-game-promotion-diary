import { describe, it } from "vitest";

// WISH-04 / VIZ-03 — daily wishlist series + 24h/7d delta services
// (getWishlistSeries, computeWishlistDelta in wishlist-snapshots.ts).
//
// getWishlistSeries returns daily ASC {date,balance}[] + a real lastImportedAt
// (MAX(updatedAt)) for the honest "обновлено Xч назад" caption (D-13).
// computeWishlistDelta is a DAY attribute (D-05): given an event-day it returns
// balance(day+1)-balance(day) and balance(day+7)-balance(day) from the stored
// (already-cumulative) balance series — a windowed subtraction, not a re-sum.
// Both are tenant-scoped (eq(wishlistSnapshots.userId, userId)); cross-tenant →
// empty (404 semantics). The 24h/7d delta math is the highest-value test:
// seed a known balance series and assert the exact delta.
//
// Wave 0 scaffold (Nyquist invariant): named placeholders only — Plan 04-03
// implements the services. Model the seed/assert on
// tests/integration/wishlist-import.test.ts.
describe("wishlist series + delta (WISH-04 / VIZ-03)", () => {
  it.skip("getWishlistSeries returns daily ASC {date,balance}[] + real lastImportedAt (Plan 04-03)");

  it.skip("computeWishlistDelta returns correct 24h/7d day-level delta from the balance series (Plan 04-03 / D-05)");

  it.skip("computeWishlistDelta returns null when the post-event window has no data (Plan 04-03)");
});
