// D-05 quota banner 80% warning zone — flipped GREEN by plan 06-03.
//
// Asserts the SAME pure helpers QuotaStatusBanner.svelte renders with
// (quotaPct / quotaZone, extracted to $lib/quota-zone.ts) so there is no
// drift between "what the test asserts" and "what the bar paints":
//   quotaZone(pct): pct >= 100 → "error"; pct >= 80 → "warning"; else "ok".
//   quotaPct(used, cap): rounds (used/cap)*100, clamped to 0..100.

import { describe, it, expect } from "vitest";
import { quotaPct, quotaZone } from "../../src/lib/quota-zone.js";

describe("quota banner 80% warning zone (D-05)", () => {
  it("a platform at >=80% and <100% usage resolves to the warning zone [06-03]", () => {
    expect(quotaZone(80)).toBe("warning");
    expect(quotaZone(99)).toBe("warning");
    expect(quotaZone(79)).toBe("ok");
  });

  it("a platform at >=100% usage resolves to the error zone [06-03]", () => {
    expect(quotaZone(100)).toBe("error");
    expect(quotaZone(120)).toBe("error");
  });

  it("end-to-end: a platform at 8000/10000 usage renders the warning zone [06-03]", () => {
    // The D-05 assertion: a real platform at >=80% usage lands in warning.
    expect(quotaPct(8000, 10000)).toBe(80);
    expect(quotaZone(quotaPct(8000, 10000))).toBe("warning");
  });

  it("quotaPct clamps to 0..100 and guards a zero cap [06-03]", () => {
    expect(quotaPct(15000, 10000)).toBe(100);
    expect(quotaPct(0, 10000)).toBe(0);
    expect(quotaPct(5, 0)).toBe(0);
  });
});
