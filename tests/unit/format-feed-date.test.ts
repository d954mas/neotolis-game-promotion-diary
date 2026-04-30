import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { formatFeedDate } from "../../src/lib/util/format-feed-date.js";

/**
 * Plan 02.1-16 / Gap 5 — compact / relative date format for the /feed
 * surface. Four buckets (UI-SPEC §"Gap 5"):
 *   - same calendar day → "Today, HH:MM" (24h locale)
 *   - one calendar day back → "Yesterday"
 *   - same calendar year, older than yesterday → "MMM D" (Apr 25)
 *   - earlier years → "MMM D, YYYY" (Apr 25, 2025)
 *
 * Time is frozen via vi.setSystemTime so the bucket boundaries are
 * deterministic across CI machines. Locale-rendered strings keep the regex
 * tolerant (TZ skew across runners may shift "Apr 15" by ±1 day).
 */
describe("formatFeedDate (Plan 02.1-16 / Gap 5)", () => {
  // 2026-04-28 14:30:00 UTC. Choose a UTC anchor far from midnight in
  // common test runner zones (UTC, ET, CET, JST) so getDate()/getMonth()
  // stay on the 28th regardless of where the runner lives.
  const FROZEN_NOW = new Date("2026-04-28T14:30:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'Today, HH:MM' for same-day input", () => {
    const out = formatFeedDate(new Date("2026-04-28T09:05:00.000Z"));
    expect(out).toMatch(/^Today, \d{2}:\d{2}$/);
  });

  it("returns 'Yesterday' for one-calendar-day-back input", () => {
    const out = formatFeedDate(new Date("2026-04-27T18:00:00.000Z"));
    expect(out).toBe("Yesterday");
  });

  it("returns 'MMM D' for same-year older input", () => {
    const out = formatFeedDate(new Date("2026-04-15T12:00:00.000Z"));
    // Tolerant of TZ rendering — the runner may surface "Apr 14" or "Apr 15".
    expect(out).toMatch(/^Apr 1[45]$/);
  });

  it("returns 'MMM D, YYYY' for prior-year input", () => {
    const out = formatFeedDate(new Date("2025-12-25T12:00:00.000Z"));
    expect(out).toMatch(/^Dec (24|25), 2025$/);
  });

  it("accepts ISO string input", () => {
    const out = formatFeedDate("2026-04-28T09:05:00.000Z");
    expect(out).toMatch(/^Today, \d{2}:\d{2}$/);
  });

  it("returns '—' on null / undefined / invalid input", () => {
    expect(formatFeedDate(null)).toBe("—");
    expect(formatFeedDate(undefined)).toBe("—");
    expect(formatFeedDate("not-a-date")).toBe("—");
    expect(formatFeedDate(new Date("invalid"))).toBe("—");
  });
});
