import { describe, test, expect } from "vitest";

import { computeWishlistDeltaFromPoints } from "../../src/lib/server/services/wishlist-snapshots.js";

// Pure unit lock for the VIZ-03 headline math: the 24h / 7d wishlist change
// AFTER an event-day, computed as a windowed subtraction of the cumulative
// `balance` series (LATEST snapshot in the window − the base balance carried
// forward to the event-day). The DB-backed computeWishlistDelta delegates here,
// so this fixes the contract independently of Postgres. Mirrors the integration
// fixture (D0:100 → D7:200 ⇒ delta7d = 100) plus the edge cases the windowed
// subtraction has to get right: empty windows, carry-forward base, no base,
// negative deltas, and the inclusive window boundaries (incl. month crossing).

type Pt = { date: string; balance: number };

describe("computeWishlistDeltaFromPoints", () => {
  test("canonical: base on the event-day, latest-in-window after (matches the integration fixture)", () => {
    const points: Pt[] = [
      { date: "2026-05-01", balance: 100 }, // base (on event-day)
      { date: "2026-05-02", balance: 110 }, // == event +1d → the 24h edge
      { date: "2026-05-03", balance: 115 },
      { date: "2026-05-08", balance: 200 }, // == event +7d → the 7d edge (inclusive)
    ];
    const d = computeWishlistDeltaFromPoints(points, "2026-05-01");
    expect(d.delta24h).toBe(10); // 110 − 100
    expect(d.delta7d).toBe(100); // 200 − 100
    expect(d.windowFrom).toBe("2026-05-01");
    expect(d.windowTo).toBe("2026-05-08");
  });

  test("latest-in-window wins (not the first post-event point)", () => {
    const points: Pt[] = [
      { date: "2026-05-01", balance: 100 },
      { date: "2026-05-04", balance: 130 },
      { date: "2026-05-06", balance: 170 }, // latest within the 7d window
    ];
    const d = computeWishlistDeltaFromPoints(points, "2026-05-01");
    expect(d.delta7d).toBe(70); // 170 − 100, NOT 130 − 100
  });

  test("empty window: no snapshots after the event-day → null deltas (never a stale guess)", () => {
    const points: Pt[] = [{ date: "2026-05-01", balance: 100 }];
    const d = computeWishlistDeltaFromPoints(points, "2026-05-01");
    expect(d.delta24h).toBeNull();
    expect(d.delta7d).toBeNull();
    expect(d.windowFrom).toBe("2026-05-01");
    expect(d.windowTo).toBe("2026-05-08");
  });

  test("negative delta when wishlists drop after the event", () => {
    const points: Pt[] = [
      { date: "2026-05-01", balance: 200 },
      { date: "2026-05-05", balance: 180 },
    ];
    const d = computeWishlistDeltaFromPoints(points, "2026-05-01");
    expect(d.delta7d).toBe(-20);
    expect(d.delta24h).toBeNull(); // nothing in (05-01, 05-02]
  });

  test("carry-forward base: event-day falls between snapshots → base is the most recent at-or-before", () => {
    const points: Pt[] = [
      { date: "2026-05-01", balance: 50 }, // base carried forward to 05-03
      { date: "2026-05-06", balance: 90 },
    ];
    const d = computeWishlistDeltaFromPoints(points, "2026-05-03");
    expect(d.delta7d).toBe(40); // 90 − 50 (06 is within (05-03, 05-10])
    expect(d.delta24h).toBeNull(); // nothing in (05-03, 05-04]
  });

  test("no base: event-day before every snapshot → null deltas", () => {
    const points: Pt[] = [{ date: "2026-05-06", balance: 90 }];
    const d = computeWishlistDeltaFromPoints(points, "2026-05-01");
    expect(d.delta24h).toBeNull();
    expect(d.delta7d).toBeNull();
  });

  test("month-crossing 7d window: windowTo and inclusion are correct across the boundary", () => {
    const points: Pt[] = [
      { date: "2026-05-28", balance: 100 },
      { date: "2026-06-04", balance: 150 }, // == 05-28 +7d (next month), inclusive
    ];
    const d = computeWishlistDeltaFromPoints(points, "2026-05-28");
    expect(d.windowTo).toBe("2026-06-04");
    expect(d.delta7d).toBe(50);
  });

  test("a snapshot exactly ON the event-day is the base, not an after-point", () => {
    const points: Pt[] = [
      { date: "2026-05-01", balance: 100 }, // on event-day → base
      { date: "2026-05-08", balance: 140 },
    ];
    const d = computeWishlistDeltaFromPoints(points, "2026-05-01");
    expect(d.delta7d).toBe(40); // 140 − 100; the 05-01 point did not count as "after"
  });

  test("empty series → null deltas with a well-formed window", () => {
    const d = computeWishlistDeltaFromPoints([], "2026-05-01");
    expect(d.delta24h).toBeNull();
    expect(d.delta7d).toBeNull();
    expect(d.windowFrom).toBe("2026-05-01");
    expect(d.windowTo).toBe("2026-05-08");
  });
});
