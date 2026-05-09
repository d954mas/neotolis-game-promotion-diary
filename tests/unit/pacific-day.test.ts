// Phase 03.0.1 — Pacific calendar day boundary helpers.
//
// `pacificDayStart(now)` returns UTC instant of "00:00 PT today" — the cap
// window's lower bound. `nextPacificMidnight(now)` returns 00:00 PT tomorrow.
// DST-aware via Intl.DateTimeFormat — never naive +24h arithmetic.

import { describe, it, expect } from "vitest";
import { pacificDayStart, nextPacificMidnight } from "../../src/lib/server/services/quota.js";

describe("pacificDayStart", () => {
  it("returns 00:00 PT for a daytime PT instant (PST)", () => {
    // 2026-01-15 14:30 UTC = 2026-01-15 06:30 PST (UTC-8). PT day = 2026-01-15.
    const now = new Date("2026-01-15T14:30:00Z");
    const start = pacificDayStart(now);
    // 00:00 PT on 2026-01-15 = 08:00 UTC.
    expect(start.toISOString()).toBe("2026-01-15T08:00:00.000Z");
  });

  it("returns 00:00 PT for a daytime PT instant (PDT)", () => {
    // 2026-07-15 14:30 UTC = 2026-07-15 07:30 PDT (UTC-7). PT day = 2026-07-15.
    const now = new Date("2026-07-15T14:30:00Z");
    const start = pacificDayStart(now);
    // 00:00 PT on 2026-07-15 = 07:00 UTC.
    expect(start.toISOString()).toBe("2026-07-15T07:00:00.000Z");
  });

  it("handles late-night UTC that's still previous PT day", () => {
    // 2026-01-15 02:00 UTC = 2026-01-14 18:00 PST. PT day = 2026-01-14.
    const now = new Date("2026-01-15T02:00:00Z");
    const start = pacificDayStart(now);
    // 00:00 PT on 2026-01-14 = 08:00 UTC.
    expect(start.toISOString()).toBe("2026-01-14T08:00:00.000Z");
  });

  it("handles early UTC that's still previous PT day (PDT)", () => {
    // 2026-07-15 03:00 UTC = 2026-07-14 20:00 PDT. PT day = 2026-07-14.
    const now = new Date("2026-07-15T03:00:00Z");
    const start = pacificDayStart(now);
    // 00:00 PT on 2026-07-14 = 07:00 UTC.
    expect(start.toISOString()).toBe("2026-07-14T07:00:00.000Z");
  });
});

describe("nextPacificMidnight", () => {
  it("returns next-day 00:00 PT (PST mid-day)", () => {
    const now = new Date("2026-01-15T14:30:00Z"); // 06:30 PST on 2026-01-15
    const next = nextPacificMidnight(now);
    // Next PT midnight = 2026-01-16 00:00 PST = 2026-01-16 08:00 UTC.
    expect(next.toISOString()).toBe("2026-01-16T08:00:00.000Z");
  });

  it("returns next-day 00:00 PT (PDT mid-day)", () => {
    const now = new Date("2026-07-15T14:30:00Z"); // 07:30 PDT on 2026-07-15
    const next = nextPacificMidnight(now);
    // Next PT midnight = 2026-07-16 00:00 PDT = 2026-07-16 07:00 UTC.
    expect(next.toISOString()).toBe("2026-07-16T07:00:00.000Z");
  });

  it("returns same-day-PT 00:00 when current PT is the previous day", () => {
    // 02:00 UTC on 2026-01-15 is still 2026-01-14 in PT. Next PT midnight =
    // start of 2026-01-15 PT = 08:00 UTC.
    const now = new Date("2026-01-15T02:00:00Z");
    const next = nextPacificMidnight(now);
    expect(next.toISOString()).toBe("2026-01-15T08:00:00.000Z");
  });

  it("handles PDT spring-forward week without crashing", () => {
    // 2026 spring-forward: Sunday 2026-03-08 02:00 PT → 03:00 PT (PST → PDT).
    // Calling on the day before, day of, day after — should all return sane Date.
    const beforeDST = new Date("2026-03-07T20:00:00Z");
    const onDST = new Date("2026-03-08T20:00:00Z");
    const afterDST = new Date("2026-03-09T20:00:00Z");
    expect(nextPacificMidnight(beforeDST).getTime()).toBeGreaterThan(beforeDST.getTime());
    expect(nextPacificMidnight(onDST).getTime()).toBeGreaterThan(onDST.getTime());
    expect(nextPacificMidnight(afterDST).getTime()).toBeGreaterThan(afterDST.getTime());
  });
});
