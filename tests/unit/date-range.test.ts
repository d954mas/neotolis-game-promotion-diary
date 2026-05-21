import { describe, it, expect } from "vitest";
import {
  parseEventDate,
  startOfDay,
  endOfDay,
  dateInRange,
  dateRangeWindow,
  isCustomRange,
  fmtMonthDay,
} from "../../src/lib/feed/date-range.js";

/**
 * Date math helpers for the v2 /feed surface (Plan 03.4-02 Task 2).
 *
 * The module is pure: no `new Date()` calls inside dateInRange /
 * dateRangeWindow / isCustomRange — TODAY flows in from the SSR loader as
 * a parameter (D-24 future-date guard, timezone-safe between PT-server and
 * UTC-client).
 *
 * Tests use fixed Date inputs and assert local-calendar semantics. The
 * round-trip guard inside parseEventDate catches silent date rollover
 * ("2026-02-31" → null, not a March-3 date object).
 */
describe("parseEventDate", () => {
  it("returns Date for valid 'YYYY-MM-DD'", () => {
    const d = parseEventDate("2026-05-15");
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(4); // May = 4 (0-indexed)
    expect(d!.getDate()).toBe(15);
  });

  it("returns null for impossible calendar date (Feb 31 rolls over silently in JS)", () => {
    expect(parseEventDate("2026-02-31")).toBeNull();
  });

  it("returns null for non-date string", () => {
    expect(parseEventDate("not-a-date")).toBeNull();
    expect(parseEventDate("2026/05/15")).toBeNull();
    expect(parseEventDate("15-05-2026")).toBeNull();
  });

  it("returns null for empty / null / undefined input", () => {
    expect(parseEventDate("")).toBeNull();
    expect(parseEventDate(null)).toBeNull();
    expect(parseEventDate(undefined)).toBeNull();
  });
});

describe("startOfDay / endOfDay", () => {
  it("startOfDay zeroes hours/minutes/seconds/ms at local-tz day start", () => {
    const d = new Date(2026, 4, 15, 17, 30, 45, 123);
    const s = startOfDay(d);
    expect(s.getHours()).toBe(0);
    expect(s.getMinutes()).toBe(0);
    expect(s.getSeconds()).toBe(0);
    expect(s.getMilliseconds()).toBe(0);
    expect(s.getFullYear()).toBe(2026);
    expect(s.getMonth()).toBe(4);
    expect(s.getDate()).toBe(15);
  });

  it("endOfDay pegs hours=23, minutes=59, seconds=59, ms=999 at local-tz day end", () => {
    const d = new Date(2026, 4, 15, 0, 0, 0, 0);
    const e = endOfDay(d);
    expect(e.getHours()).toBe(23);
    expect(e.getMinutes()).toBe(59);
    expect(e.getSeconds()).toBe(59);
    expect(e.getMilliseconds()).toBe(999);
    expect(e.getDate()).toBe(15);
  });
});

describe("dateInRange", () => {
  // Fixed TODAY for deterministic windows. NOT new Date() — D-24 future-date
  // guard requires the server-provided TODAY to flow in as a parameter.
  const TODAY = new Date(2026, 4, 15); // May 15, 2026

  it("returns true for any date when filter.preset === 'all'", () => {
    expect(dateInRange("2020-01-01", { preset: "all" }, TODAY)).toBe(true);
    expect(dateInRange("2030-12-31", { preset: "all" }, TODAY)).toBe(true);
  });

  it("returns true when event is today and filter.preset === 'today'", () => {
    expect(dateInRange("2026-05-15", { preset: "today" }, TODAY)).toBe(true);
  });

  it("returns false when event is yesterday and filter.preset === 'today'", () => {
    expect(dateInRange("2026-05-14", { preset: "today" }, TODAY)).toBe(false);
  });

  it("returns true when event is inside a custom range; false outside", () => {
    const filter = { preset: "custom" as const, from: "2026-05-01", to: "2026-05-31" };
    expect(dateInRange("2026-05-15", filter, TODAY)).toBe(true);
    expect(dateInRange("2026-04-30", filter, TODAY)).toBe(false);
    expect(dateInRange("2026-06-01", filter, TODAY)).toBe(false);
  });

  it("respects inclusive boundaries on the custom range 'to' (end-of-day)", () => {
    const filter = { preset: "custom" as const, from: "2026-05-01", to: "2026-05-15" };
    // Event date equals `to` — must match (to is treated as end-of-day).
    expect(dateInRange("2026-05-15", filter, TODAY)).toBe(true);
    // Event date equals `from` — must match (from is treated as start-of-day).
    expect(dateInRange("2026-05-01", filter, TODAY)).toBe(true);
  });

  it("returns false when custom range has invalid from/to dates", () => {
    const badFilter = { preset: "custom" as const, from: "not-a-date", to: "2026-05-31" };
    expect(dateInRange("2026-05-15", badFilter, TODAY)).toBe(false);
  });

  it("accepts Date object input for occurredAt (the SSR loader passes Date)", () => {
    const filter = { preset: "custom" as const, from: "2026-05-01", to: "2026-05-31" };
    expect(dateInRange(new Date(2026, 4, 15), filter, TODAY)).toBe(true);
  });

  it("accepts ISO timestamp string input (slice to YYYY-MM-DD)", () => {
    const filter = { preset: "custom" as const, from: "2026-05-01", to: "2026-05-31" };
    expect(dateInRange("2026-05-15T14:30:00.000Z", filter, TODAY)).toBe(true);
  });
});

describe("dateRangeWindow", () => {
  // Use local-time TODAY at noon so DST flip does not shuffle the window
  // boundaries across runners in different zones.
  const TODAY = new Date(2026, 4, 15, 12, 0, 0); // May 15, 2026 noon

  it("'today' returns { from: startOfToday, to: endOfToday }", () => {
    const { from, to } = dateRangeWindow("today", TODAY);
    expect(from.getDate()).toBe(15);
    expect(from.getHours()).toBe(0);
    expect(to.getDate()).toBe(15);
    expect(to.getHours()).toBe(23);
  });

  it("'week' returns a rolling 7-day window (today inclusive)", () => {
    const { from, to } = dateRangeWindow("week", TODAY);
    // 7 days inclusive: May 9 .. May 15
    expect(from.getDate()).toBe(9);
    expect(from.getMonth()).toBe(4);
    expect(to.getDate()).toBe(15);
  });

  it("'month' returns a rolling 30-day window", () => {
    const { from, to } = dateRangeWindow("month", TODAY);
    // 30 days inclusive: Apr 16 .. May 15
    expect(from.getMonth()).toBe(3); // April
    expect(from.getDate()).toBe(16);
    expect(to.getDate()).toBe(15);
    expect(to.getMonth()).toBe(4);
  });

  it("'year' returns a rolling 365-day window", () => {
    const { from, to } = dateRangeWindow("year", TODAY);
    // 365 days inclusive: 2025-05-16 .. 2026-05-15
    expect(from.getFullYear()).toBe(2025);
    expect(from.getMonth()).toBe(4);
    expect(from.getDate()).toBe(16);
    expect(to.getFullYear()).toBe(2026);
    expect(to.getDate()).toBe(15);
  });
});

describe("isCustomRange", () => {
  it("returns true for { preset: 'custom', from, to }", () => {
    expect(isCustomRange({ preset: "custom", from: "2026-05-01", to: "2026-05-31" })).toBe(true);
  });

  it("returns false for { preset: 'month' } and other preset variants", () => {
    expect(isCustomRange({ preset: "month" })).toBe(false);
    expect(isCustomRange({ preset: "all" })).toBe(false);
    expect(isCustomRange({ preset: "today" })).toBe(false);
    expect(isCustomRange({ preset: "year" })).toBe(false);
  });
});

describe("fmtMonthDay", () => {
  it("formats a Date as 'MMM D' in en-US locale (locked)", () => {
    // May 15, 2026 → "May 15"
    expect(fmtMonthDay(new Date(2026, 4, 15))).toBe("May 15");
  });

  it("uses short month abbreviation for all twelve months", () => {
    expect(fmtMonthDay(new Date(2026, 0, 1))).toBe("Jan 1");
    expect(fmtMonthDay(new Date(2026, 11, 25))).toBe("Dec 25");
  });
});

describe("future-date guard (D-24)", () => {
  // The custom-range filter must not silently extend past TODAY.
  // Picker UI enforces this on input; the filter math also rejects an
  // event date FROM THE FUTURE (i.e. after TODAY) when the custom range
  // covers future dates.
  it("returns false for an event date strictly after TODAY when filter is preset='today'", () => {
    const TODAY = new Date(2026, 4, 15);
    expect(dateInRange("2026-05-16", { preset: "today" }, TODAY)).toBe(false);
  });

  it("does NOT include events past TODAY in any rolling preset window", () => {
    const TODAY = new Date(2026, 4, 15);
    expect(dateInRange("2026-05-16", { preset: "week" }, TODAY)).toBe(false);
    expect(dateInRange("2026-05-16", { preset: "month" }, TODAY)).toBe(false);
    expect(dateInRange("2026-05-16", { preset: "year" }, TODAY)).toBe(false);
  });
});
