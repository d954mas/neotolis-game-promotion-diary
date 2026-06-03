// PURE wishlist-delta math — no DB, no userId, no timezone state. Lives in a
// client-safe util (NOT the server service) because BOTH sides compute it:
//   - the server `computeWishlistDelta` (DB-backed) delegates here, and
//   - the /games/[gameId] page builds its per-day delta map on the CLIENT.
//
// Why the client owns the per-day map (the timezone fix): "which calendar day
// did an event happen on" is INHERENTLY timezone-dependent for an instant
// (`occurredAt`). The server container runs UTC and cannot know the viewer's
// zone, so a server-side day-bucket (toISOString) mismatches the client's local
// `eventDay` for events near midnight in a negative-offset zone — the post-event
// delta then silently fails to resolve. The day STRING is the only TZ-sensitive
// input; this math is pure string comparison once the day is chosen, so the
// client picks the local day (eventDay) and calls straight in.

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
