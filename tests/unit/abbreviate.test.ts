import { describe, it, expect } from "vitest";
import { abbreviate } from "../../src/lib/components/charts/abbreviate.js";

// D-11 number abbreviation for chart axis/labels. The full value lives in the
// tooltip/panel; this is the compact form (paired with tabular-nums in CSS).
describe("abbreviate", () => {
  it("leaves sub-1000 values unchanged (no decimal, no suffix)", () => {
    expect(abbreviate(0)).toBe("0");
    expect(abbreviate(42)).toBe("42");
    expect(abbreviate(999)).toBe("999");
  });

  it("abbreviates thousands, stripping a trailing .0", () => {
    expect(abbreviate(1000)).toBe("1k");
    expect(abbreviate(1234)).toBe("1.2k");
    expect(abbreviate(47000)).toBe("47k");
  });

  it("abbreviates millions", () => {
    expect(abbreviate(1200000)).toBe("1.2M");
  });

  it("preserves the sign on negative values", () => {
    expect(abbreviate(-1234)).toBe("-1.2k");
  });
});
