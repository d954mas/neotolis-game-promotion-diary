// Timezone-correctness for the wishlist charts' date-only handling (#1).
//
// The bug: date-only "YYYY-MM-DD" wishlist days were handed to the ECharts
// `type:"time"` axis as STRINGS. ECharts parses a bare date string as
// `new Date("2026-05-01")` = UTC midnight; in a negative-offset timezone
// (America/New_York is UTC-4 in May) UTC midnight is the PREVIOUS evening
// locally, so the point/marker rendered a day early and the axis label, the
// tooltip day-lookup, and the event/delta matching all drifted by one.
//
// The fix: `dayToLocalMs(day)` = `new Date(y, mo-1, d).getTime()` (LOCAL
// midnight), fed for every date-only x-coordinate; and `eventDay()` now derives
// the LOCAL calendar day (isoDay) instead of the UTC slice. These tests run
// under America/New_York and prove no off-by-one.
//
// Setting process.env.TZ at module load (BEFORE importing the helpers) makes V8
// resolve `new Date(y, mo, d)` / getFullYear()/getMonth()/getDate() against
// America/New_York for this test process — mirroring a US user's browser.
process.env.TZ = "America/New_York";

import { describe, it, expect } from "vitest";
import {
  dayToLocalMs,
  isoDay,
  eventDay,
} from "../../src/lib/components/charts/wishlist-chart-shared.js";

describe("wishlist chart date-only handling under America/New_York (#1)", () => {
  it("sanity: the test process runs in a negative-offset timezone", () => {
    // 2026-05-01 12:00 UTC is still May 1 LOCALLY in NY (08:00 EDT); the
    // timezone offset is positive minutes (behind UTC). If this fails the env
    // didn't take and the rest of the assertions wouldn't prove anything.
    const offsetMin = new Date("2026-05-01T12:00:00Z").getTimezoneOffset();
    expect(offsetMin).toBeGreaterThan(0); // UTC-4/-5 → +240/+300
  });

  it("dayToLocalMs → isoDay round-trips the SAME calendar day (no off-by-one)", () => {
    // The load-bearing assertion: the value handed to the time axis
    // (dayToLocalMs) maps back to the exact day the lookup keys use (isoDay) —
    // "2026-05-01", NOT "2026-04-30" (which the old UTC-string path produced).
    expect(isoDay(new Date(dayToLocalMs("2026-05-01")))).toBe("2026-05-01");
  });

  it("dayToLocalMs builds LOCAL midnight for the requested day", () => {
    const d = new Date(dayToLocalMs("2026-05-01"));
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(4); // May (0-indexed)
    expect(d.getDate()).toBe(1); // the 1st locally — NOT the 30th of April
    expect(d.getHours()).toBe(0); // local midnight
  });

  it("a date that would shift under UTC parsing stays put under dayToLocalMs", () => {
    // new Date("2026-12-15") = UTC midnight = 2026-12-14 19:00 EST locally →
    // the OLD bug would render Dec 14. dayToLocalMs keeps it on Dec 15.
    const buggyUtc = new Date("2026-12-15"); // what ECharts did with the string
    expect(buggyUtc.getDate()).toBe(14); // proves the bug exists in the naive path
    expect(new Date(dayToLocalMs("2026-12-15")).getDate()).toBe(15); // fixed
  });

  it("eventDay derives the LOCAL calendar day, consistent with the axis", () => {
    // 2026-05-01 02:00 UTC = 2026-04-30 22:00 EDT locally → the LOCAL day is
    // April 30. eventDay must agree with isoDay (local), NOT toISOString (UTC,
    // which would have said May 1) so the event marker lands on the same day key
    // the wishlist points + the axis use.
    expect(eventDay({ occurredAt: "2026-05-01T02:00:00Z" })).toBe("2026-04-30");
    // And a mid-day-UTC instant stays on its local day.
    expect(eventDay({ occurredAt: "2026-05-01T16:00:00Z" })).toBe("2026-05-01");
  });

  it("eventDay's day-key round-trips back to the same axis coordinate", () => {
    // The full chain that has to agree: an event's local day-key → dayToLocalMs
    // → isoDay must return the SAME key, so buildDayGroups' key and the marker's
    // convertToPixel coordinate point at one identical day.
    const key = eventDay({ occurredAt: "2026-05-01T16:00:00Z" });
    expect(isoDay(new Date(dayToLocalMs(key)))).toBe(key);
  });
});
