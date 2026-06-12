// ISO-8601 duration parser + the Shorts duration PREFILTER (user-locked
// 2026-06-12). Duration is ONLY a prefilter: it can SKIP the redirect probe for
// over-ceiling videos, but never decides "short" on its own.

import { describe, it, expect } from "vitest";
import {
  parseIso8601Duration,
  durationPrefilter,
  SHORTS_DURATION_CEILING_SECONDS,
} from "../../../../src/lib/sources/youtube/server/duration.js";

describe("parseIso8601Duration", () => {
  it("parses seconds-only 'PT15S' → 15", () => {
    expect(parseIso8601Duration("PT15S")).toBe(15);
  });

  it("parses minutes+seconds 'PT4M13S' → 253", () => {
    expect(parseIso8601Duration("PT4M13S")).toBe(253);
  });

  it("parses hours+minutes+seconds 'PT1H2M3S' → 3723", () => {
    expect(parseIso8601Duration("PT1H2M3S")).toBe(3723);
  });

  it("parses minutes-only 'PT1M' → 60", () => {
    expect(parseIso8601Duration("PT1M")).toBe(60);
  });

  it("parses hours-only 'PT2H' → 7200", () => {
    expect(parseIso8601Duration("PT2H")).toBe(7200);
  });

  it("parses zero 'PT0S' → 0 (a real value, distinct from null)", () => {
    expect(parseIso8601Duration("PT0S")).toBe(0);
  });

  it("returns null for an empty string", () => {
    expect(parseIso8601Duration("")).toBeNull();
  });

  it("returns null for a bare 'PT' (no H/M/S component)", () => {
    expect(parseIso8601Duration("PT")).toBeNull();
  });

  it("returns null for garbage / non-ISO input", () => {
    expect(parseIso8601Duration("4 minutes")).toBeNull();
    expect(parseIso8601Duration("P1D")).toBeNull(); // day component unsupported
    expect(parseIso8601Duration("PT1S2M")).toBeNull(); // wrong component order
  });
});

describe("durationPrefilter", () => {
  it("the ceiling is 181s (3min + 1s slack)", () => {
    expect(SHORTS_DURATION_CEILING_SECONDS).toBe(181);
  });

  it("just over the ceiling (182s) → skip-video (never a Short, no probe)", () => {
    expect(durationPrefilter(182)).toBe("skip-video");
  });

  it("a long video (10min) → skip-video", () => {
    expect(durationPrefilter(600)).toBe("skip-video");
  });

  it("exactly at the ceiling (181s) → probe (still a candidate)", () => {
    expect(durationPrefilter(181)).toBe("probe");
  });

  it("a short runtime (15s) → probe — duration alone CANNOT say 'short'", () => {
    // The whole point of the user-locked design: a ≤3min video is only a
    // CANDIDATE; the redirect probe is the decider.
    expect(durationPrefilter(15)).toBe("probe");
  });

  it("an unknown duration (null) → probe (no contentDetails → still classify)", () => {
    expect(durationPrefilter(null)).toBe("probe");
  });
});
