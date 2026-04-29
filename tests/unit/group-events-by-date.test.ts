import { describe, it, expect } from "vitest";
import { groupEventsByDate } from "../../src/lib/util/group-events-by-date.js";

// Plan 02.1-19 — pure utility behind /feed's Google-Photos-style date
// grouping. Five tests cover the contract surface (empty, same-day,
// multi-day, UTC-boundary, mixed Date|string inputs).

describe("groupEventsByDate (Plan 02.1-19)", () => {
  it("Test 1: empty input returns empty list", () => {
    expect(groupEventsByDate([])).toEqual([]);
  });

  it("Test 2: rows from same UTC calendar date land in one group preserving input order", () => {
    const rows = [
      { id: "a", occurredAt: new Date("2026-04-28T23:00:00.000Z") },
      { id: "b", occurredAt: new Date("2026-04-28T12:00:00.000Z") },
      { id: "c", occurredAt: new Date("2026-04-28T01:00:00.000Z") },
    ];
    const groups = groupEventsByDate(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.date).toBe("2026-04-28");
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("Test 3: rows from 3 different dates produce 3 groups in input order (no re-sort)", () => {
    const rows = [
      { id: "jun15", occurredAt: new Date("2026-06-15T10:00:00.000Z") },
      { id: "may10", occurredAt: new Date("2026-05-10T10:00:00.000Z") },
      { id: "apr01", occurredAt: new Date("2026-04-01T10:00:00.000Z") },
    ];
    const groups = groupEventsByDate(rows);
    expect(groups).toHaveLength(3);
    expect(groups[0]!.date).toBe("2026-06-15");
    expect(groups[1]!.date).toBe("2026-05-10");
    expect(groups[2]!.date).toBe("2026-04-01");
    expect(groups[0]!.rows[0]!.id).toBe("jun15");
    expect(groups[1]!.rows[0]!.id).toBe("may10");
    expect(groups[2]!.rows[0]!.id).toBe("apr01");
  });

  it("Test 4: UTC-boundary — events at 23:50Z and 00:10Z next-day land in DIFFERENT groups", () => {
    // Document the contract: occurredAt is stored UTC; the user's local-tz
    // boundary would require client-side regrouping which Plan 02.1-19
    // does not ship (filed as Phase 6 polish).
    const rows = [
      { id: "next-day-early", occurredAt: new Date("2026-04-29T00:10:00.000Z") },
      { id: "prev-day-late", occurredAt: new Date("2026-04-28T23:50:00.000Z") },
    ];
    const groups = groupEventsByDate(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.date).toBe("2026-04-29");
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["next-day-early"]);
    expect(groups[1]!.date).toBe("2026-04-28");
    expect(groups[1]!.rows.map((r) => r.id)).toEqual(["prev-day-late"]);
  });

  it("Test 5: mixed Date + ISO-string occurredAt inputs both group correctly", () => {
    const rows = [
      { id: "iso", occurredAt: "2026-04-28T10:00:00.000Z" },
      { id: "obj", occurredAt: new Date("2026-04-28T08:00:00.000Z") },
    ];
    const groups = groupEventsByDate(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.date).toBe("2026-04-28");
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(["iso", "obj"]);
  });
});
