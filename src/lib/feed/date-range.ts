// Date math helpers for the v2 /feed surface (Plan 03.4-02 Task 2).
//
// Server-provided TODAY (passed from +page.server.ts) flows in as a
// parameter to every range helper. We NEVER call `new Date()` inside this
// module (except inside parseEventDate where it's required to construct a
// Date object from a YYYY-MM-DD string and apply the round-trip guard).
// Reason: timezone drift between PT-server and UTC-client must never pick
// a different "today" — the SSR loader picks once and threads that single
// instant through to every consumer (D-24 future-date guard).
//
// Semantics are ported from the prototype at docs/design/v2/ui-kit/app.jsx
// lines 312-362, with two changes:
//   1. TODAY is a parameter, not a module-level constant.
//   2. parseEventDate accepts strict 'YYYY-MM-DD' (the wire format), not the
//      prototype's "MMM D" abbreviation (which assumed mock-data context).
//
// All comparisons use local-tz calendar semantics (getFullYear/getMonth/
// getDate via the Date constructor), so DST transitions don't flip an
// event across the boundary day.

import type { DateRangeFilter } from "./url-state.js";

export function parseEventDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  const [, yStr, mStr, dStr] = match;
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const dt = new Date(y, m - 1, d);
  // Round-trip guard catches "2026-02-31" silent rollover (JS Date
  // constructor accepts it and silently rolls to March 3).
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) {
    return null;
  }
  return dt;
}

export function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

export function endOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(23, 59, 59, 999);
  return r;
}

export function dateRangeWindow(
  preset: "today" | "week" | "month" | "year",
  today: Date,
): { from: Date; to: Date } {
  const to = endOfDay(today);
  const fromBase = startOfDay(today);
  switch (preset) {
    case "today":
      return { from: fromBase, to };
    case "week": {
      const f = new Date(fromBase);
      f.setDate(f.getDate() - 6); // 7 days inclusive
      return { from: f, to };
    }
    case "month": {
      const f = new Date(fromBase);
      f.setDate(f.getDate() - 29); // 30 days inclusive
      return { from: f, to };
    }
    case "year": {
      const f = new Date(fromBase);
      f.setDate(f.getDate() - 364); // 365 days inclusive
      return { from: f, to };
    }
  }
}

export function dateInRange(
  occurredAt: string | Date,
  filter: DateRangeFilter,
  today: Date,
): boolean {
  if (filter.preset === "all") return true;
  // Normalize string input (possibly an ISO timestamp) to its YYYY-MM-DD
  // calendar day — sliced before parseEventDate so '2026-05-15T14:30:00Z'
  // resolves to the local May-15 calendar day.
  const ev =
    typeof occurredAt === "string"
      ? parseEventDate(occurredAt.slice(0, 10))
      : startOfDay(occurredAt);
  if (!ev) return false;

  if (filter.preset === "custom") {
    const from = parseEventDate(filter.from);
    const to = parseEventDate(filter.to);
    if (!from || !to) return false;
    return ev >= startOfDay(from) && ev <= endOfDay(to);
  }

  const { from, to } = dateRangeWindow(filter.preset, today);
  return ev >= from && ev <= to;
}

export function isCustomRange(
  filter: DateRangeFilter,
): filter is { preset: "custom"; from: string; to: string } {
  return filter.preset === "custom";
}

export function fmtMonthDay(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
