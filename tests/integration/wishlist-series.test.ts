import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { seedUserDirectly } from "./helpers.js";

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
// Real Postgres, no DB mocks. Snapshots are INSERTED DIRECTLY (not via the CSV
// import, which recomputes balance) so the seeded {date, balance, updatedAt}
// are exactly the values the readers must surface — the cleanest way to assert
// the windowed-subtraction math and the real-import-time caption.

const sfx = (): string => randomBytes(4).toString("hex");

vi.mock("../../src/lib/server/integrations/steam-api.js", () => ({
  fetchSteamAppDetails: vi.fn(),
}));

const { createGame } = await import("../../src/lib/server/services/games.js");
const { addSteamListing } = await import("../../src/lib/server/services/game-steam-listings.js");
const { fetchSteamAppDetails } = await import("../../src/lib/server/integrations/steam-api.js");
const { getWishlistSeries, computeWishlistDelta } =
  await import("../../src/lib/server/services/wishlist-snapshots.js");
const { wishlistSnapshots } = await import("../../src/lib/server/db/schema/wishlist-snapshots.js");
const { db } = await import("../../src/lib/server/db/client.js");

vi.mocked(fetchSteamAppDetails).mockResolvedValue(null);

interface Seed {
  userId: string;
  listingId: string;
}

async function seedListing(emailPrefix: string, appId: number): Promise<Seed> {
  const user = await seedUserDirectly({ email: `${emailPrefix}-${sfx()}@test.local` });
  const game = await createGame(user.id, { title: "Series Game" }, "127.0.0.1");
  const listing = await addSteamListing(user.id, { gameId: game.id, appId }, "127.0.0.1");
  return { userId: user.id, listingId: listing.id };
}

/** Insert daily snapshots with explicit balances (and optional updatedAt). */
async function seedSnapshots(
  s: Seed,
  rows: { date: string; balance: number; updatedAt?: Date }[],
): Promise<void> {
  await db.insert(wishlistSnapshots).values(
    rows.map((r) => ({
      userId: s.userId,
      listingId: s.listingId,
      date: r.date,
      adds: 0,
      deletes: 0,
      purchasesAndActivations: 0,
      gifts: 0,
      balance: r.balance,
      source: "csv",
      ...(r.updatedAt ? { updatedAt: r.updatedAt } : {}),
    })),
  );
}

describe("wishlist series + delta (WISH-04 / VIZ-03)", () => {
  it("getWishlistSeries returns daily ASC {date,balance}[] + real lastImportedAt", async () => {
    const s = await seedListing("wl-series", 700);
    // 30 daily snapshots, balance growing; INSERTED out of order to prove ASC.
    const rows = Array.from({ length: 30 }, (_, i) => ({
      date: `2026-04-${String(i + 1).padStart(2, "0")}`,
      balance: 100 + i * 5,
    }));
    const maxImport = new Date("2026-04-30T08:00:00.000Z");
    // Give the last-inserted row the latest updatedAt; others earlier.
    const withTimes = rows.map((r, i) => ({
      ...r,
      updatedAt: i === 29 ? maxImport : new Date("2026-04-15T00:00:00.000Z"),
    }));
    await seedSnapshots(s, [...withTimes].reverse());

    const series = await getWishlistSeries(s.userId, s.listingId);

    expect(series.points).toHaveLength(30);
    // ASC by date.
    expect(series.points[0]).toEqual({ date: "2026-04-01", balance: 100 });
    expect(series.points[29]).toEqual({ date: "2026-04-30", balance: 245 });
    expect(series.points.map((p) => p.date)).toEqual([...series.points.map((p) => p.date)].sort());
    // lastImportedAt = real MAX(updatedAt), ISO — NOT now().
    expect(series.lastImportedAt).toBe(maxImport.toISOString());
  });

  it("getWishlistSeries clips points to an inclusive {from,to} range", async () => {
    const s = await seedListing("wl-range", 701);
    await seedSnapshots(s, [
      { date: "2026-03-01", balance: 10 },
      { date: "2026-03-05", balance: 20 },
      { date: "2026-03-10", balance: 30 },
      { date: "2026-03-15", balance: 40 },
    ]);

    const clipped = await getWishlistSeries(s.userId, s.listingId, {
      from: "2026-03-05",
      to: "2026-03-10",
    });

    expect(clipped.points).toEqual([
      { date: "2026-03-05", balance: 20 },
      { date: "2026-03-10", balance: 30 },
    ]);
    // lastImportedAt reflects the WHOLE listing's freshness, not the clip.
    expect(clipped.lastImportedAt).not.toBeNull();
  });

  it("getWishlistSeries returns { points: [], lastImportedAt: null } for a listing with no snapshots", async () => {
    const s = await seedListing("wl-empty", 702);
    const series = await getWishlistSeries(s.userId, s.listingId);
    expect(series).toEqual({ points: [], lastImportedAt: null });
  });

  it("computeWishlistDelta returns correct 24h/7d day-level delta from the balance series (D-05)", async () => {
    const s = await seedListing("wl-delta", 703);
    // Known series: D0:100, D1:110, D2:115, D7:200.
    await seedSnapshots(s, [
      { date: "2026-05-01", balance: 100 }, // D0 (eventDate)
      { date: "2026-05-02", balance: 110 }, // D1
      { date: "2026-05-03", balance: 115 }, // D2
      { date: "2026-05-08", balance: 200 }, // D7
    ]);

    const delta = await computeWishlistDelta(s.userId, s.listingId, "2026-05-01");

    expect(delta.delta24h).toBe(10); // balance(D1) - balance(D0) = 110 - 100
    expect(delta.delta7d).toBe(100); // balance(D7) - balance(D0) = 200 - 100
    expect(delta.windowFrom).toBe("2026-05-01");
    expect(delta.windowTo).toBe("2026-05-08"); // eventDate + 7d
  });

  it("computeWishlistDelta is a DAY attribute — same eventDate yields identical delta regardless of event", async () => {
    const s = await seedListing("wl-day-attr", 704);
    await seedSnapshots(s, [
      { date: "2026-05-01", balance: 100 },
      { date: "2026-05-02", balance: 110 },
      { date: "2026-05-08", balance: 180 },
    ]);

    // Two "different events" on the same date → the function takes only the
    // date, so the deltas are byte-identical (no eventId in the contract).
    const a = await computeWishlistDelta(s.userId, s.listingId, "2026-05-01");
    const b = await computeWishlistDelta(s.userId, s.listingId, "2026-05-01");
    expect(a).toEqual(b);
    expect(a.delta24h).toBe(10);
    expect(a.delta7d).toBe(80);
  });

  it("computeWishlistDelta tolerates a gap — uses the FIRST snapshot strictly after the event-day in the window", async () => {
    const s = await seedListing("wl-gap", 705);
    // D1 missing; D2 exists within the 24h..no — D2 is +1 outside the 24h
    // window. Construct: D0 then D1-MISSING but a row at D0+1? Use a row that
    // falls INSIDE the 24h window after the event but isn't exactly day+1's
    // canonical balance: here D0=2026-05-01, next snapshot 2026-05-02 (=day+1)
    // is the first-in-window for 24h. For 7d, the first-after row anchors.
    await seedSnapshots(s, [
      { date: "2026-05-01", balance: 50 }, // D0
      { date: "2026-05-04", balance: 90 }, // first row strictly after D0 within 7d (gap over D1..D3)
    ]);

    const delta = await computeWishlistDelta(s.userId, s.listingId, "2026-05-01");
    // No snapshot in (D0, D0+1] → delta24h null (the only post-event row is D+3).
    expect(delta.delta24h).toBeNull();
    // 7d window: first row strictly after D0 is 2026-05-04 → 90 - 50 = 40.
    expect(delta.delta7d).toBe(40);
  });

  it("computeWishlistDelta returns null deltas when the post-event window has no data", async () => {
    const s = await seedListing("wl-nowin", 706);
    // Only the event-day itself; nothing after.
    await seedSnapshots(s, [{ date: "2026-05-01", balance: 100 }]);

    const delta = await computeWishlistDelta(s.userId, s.listingId, "2026-05-01");
    expect(delta.delta24h).toBeNull();
    expect(delta.delta7d).toBeNull();
    expect(delta.windowFrom).toBe("2026-05-01");
    expect(delta.windowTo).toBe("2026-05-08");
  });

  it("computeWishlistDelta anchors baseBalance on the most recent snapshot AT-OR-BEFORE the event-day (carry-forward)", async () => {
    const s = await seedListing("wl-carry", 707);
    // No snapshot exactly on eventDate 2026-05-03; the cumulative balance from
    // 2026-05-01 carries forward as the base.
    await seedSnapshots(s, [
      { date: "2026-05-01", balance: 70 }, // most recent at-or-before eventDate
      { date: "2026-05-04", balance: 95 }, // first after eventDate, within 24h
    ]);

    const delta = await computeWishlistDelta(s.userId, s.listingId, "2026-05-03");
    // baseBalance = 70 (carry-forward from 05-01); first-in-24h = 05-04 = 95.
    expect(delta.delta24h).toBe(25);
    expect(delta.delta7d).toBe(25);
  });
});
