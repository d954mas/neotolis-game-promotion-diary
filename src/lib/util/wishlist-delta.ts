// PURE wishlist-delta math — no DB, no userId, no timezone state. Client-safe so
// BOTH the server `computeWishlistDelta` (DB-backed) and the /games page (which
// builds its per-day map client-side) share it. The day STRING is the only
// TZ-sensitive input — which calendar day an `occurredAt` instant falls on is
// timezone-dependent, and the UTC container can't know the viewer's zone, so the
// caller picks it (the page uses the local `eventDay`); past that it's pure
// string comparison.

import type { WishlistDelta } from "$lib/server/dto.js";

/**
 * Date-only arithmetic anchored on the passed string — NEVER `new Date()` "now".
 * The UTC-noon anchor keeps the result on the intended calendar day across any
 * host timezone (a midnight anchor could roll back a day under a negative-offset
 * zone). Used to compute the 24h/7d delta windows from an event day.
 */
export function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * PURE windowed-subtraction delta from an ALREADY-LOADED date-ASC cumulative
 * balance series. `eventDate` is an opaque "YYYY-MM-DD" day key — the caller is
 * responsible for choosing it in a consistent zone (the client uses the local
 * `eventDay`). Compared as a STRING against each point's date, so it carries no
 * timezone of its own.
 *
 * Tenant scoping is the CALLER's responsibility: `points` must come from a
 * tenant-scoped read (getWishlistSeries).
 */
export function computeWishlistDeltaFromPoints(
  points: { date: string; balance: number }[],
  eventDate: string,
): WishlistDelta {
  const windowFrom = eventDate;
  const windowTo = addDaysIso(eventDate, 7);

  // baseBalance = balance ON eventDate, else the most recent AT-OR-BEFORE it
  // (cumulative carry-forward). points is date-ASC, so the last point with
  // date <= eventDate is the anchor.
  let baseBalance: number | null = null;
  for (const p of points) {
    if (p.date <= eventDate) baseBalance = p.balance;
    else break;
  }

  // LATEST snapshot STRICTLY AFTER eventDate within the inclusive window end —
  // the window-edge balance (points is date-ASC, so the last match wins).
  const latestInWindow = (endDate: string): number | null => {
    let found: number | null = null;
    for (const p of points) {
      if (p.date > eventDate && p.date <= endDate) found = p.balance;
    }
    return found;
  };

  const after24h = latestInWindow(addDaysIso(eventDate, 1));
  const after7d = latestInWindow(windowTo);

  return {
    delta24h: baseBalance !== null && after24h !== null ? after24h - baseBalance : null,
    delta7d: baseBalance !== null && after7d !== null ? after7d - baseBalance : null,
    windowFrom,
    windowTo,
  };
}
