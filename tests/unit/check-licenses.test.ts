import { describe, it, expect } from "vitest";
import {
  classifyLicense,
  FAIL_LICENSES,
  PERMISSIVE_LICENSES,
} from "../../src/lib/server/config/license-deny.js";

// D-19b — hermetic unit test for the compound-OR copyleft classifier. The
// pure classifier is tested HERE without shelling out to pnpm; the real
// `pnpm licenses list --prod --json` run happens only in CI
// (scripts/check-licenses.ts). Both import the classifier from the same
// single-source module (license-deny.ts), so this test pins the exact logic
// the CI gate executes.
describe("classifyLicense (AGPL/GPL deny-gate, compound-OR aware)", () => {
  it("FAILs hard copyleft / network-copyleft ids", () => {
    expect(classifyLicense("AGPL-3.0")).toBe("FAIL");
    expect(classifyLicense("GPL-3.0")).toBe("FAIL");
    expect(classifyLicense("GPL-2.0")).toBe("FAIL");
    expect(classifyLicense("SSPL-1.0")).toBe("FAIL");
  });

  it("PASSes a compound `OR` when any disjunct is permissive (pick the permissive arm)", () => {
    // The load-bearing rule: a dual-licensed dep with a copyleft arm still
    // PASSES because the consumer chooses the permissive arm.
    expect(classifyLicense("(MIT OR GPL-2.0)")).toBe("PASS");
    expect(classifyLicense("(MIT OR CC0-1.0)")).toBe("PASS");
    expect(classifyLicense("(BSD-2-Clause OR MIT OR Apache-2.0)")).toBe("PASS");
  });

  it("FAILs a compound `AND` whose conjunct is copyleft, even with a permissive OR-arm", () => {
    // Regression: `AND` is cumulative — a copyleft conjunct's obligation
    // applies no matter which OR-arm you pick. A flat token-bag scan (any-OR +
    // any-permissive → PASS) mis-passes all three of these.
    expect(classifyLicense("(MIT OR Apache-2.0) AND GPL-3.0")).toBe("FAIL");
    expect(classifyLicense("LGPL-3.0 AND GPL-3.0")).toBe("FAIL");
    expect(classifyLicense("MPL-2.0 AND GPL-3.0")).toBe("FAIL");
  });

  it("respects AND/OR precedence and parens for non-copyleft expressions", () => {
    expect(classifyLicense("MIT AND ISC")).toBe("PASS"); // all permissive → PASS
    expect(classifyLicense("MIT AND MPL-2.0")).toBe("WARN"); // worst-of an AND
    expect(classifyLicense("(MIT OR Apache-2.0) AND BSD-3-Clause")).toBe("PASS");
    expect(classifyLicense("MIT AND (LGPL-3.0 OR GPL-3.0)")).toBe("WARN"); // inner OR picks LGPL (WARN)
  });

  it("PASSes plain permissive ids", () => {
    expect(classifyLicense("MIT")).toBe("PASS");
    expect(classifyLicense("0BSD")).toBe("PASS");
    expect(classifyLicense("Apache-2.0")).toBe("PASS");
  });

  it("WARNs (does not FAIL) on weak/file-level copyleft", () => {
    expect(classifyLicense("LGPL-3.0")).toBe("WARN");
    expect(classifyLicense("MPL-2.0")).toBe("WARN");
  });

  it("does not let LGPL trip the GPL FAIL rule (whole-token match)", () => {
    // "LGPL-3.0" must classify WARN, never FAIL — the "GPL" FAIL id is matched
    // as a whole token / version-prefix, not as a substring.
    expect(classifyLicense("LGPL-2.1")).toBe("WARN");
    expect(classifyLicense("LGPL-3.0")).not.toBe("FAIL");
  });

  it("covers every prod-tree SPDX expression currently in the lockfile", () => {
    // The 10 license group keys pnpm emits for the current prod tree — none
    // are copyleft, so the gate PASSes the real tree. MPL-2.0 is the only
    // WARN. This pins the gate against the actual dependency surface.
    expect(classifyLicense("MIT")).toBe("PASS");
    expect(classifyLicense("Apache-2.0")).toBe("PASS");
    expect(classifyLicense("ISC")).toBe("PASS");
    expect(classifyLicense("BSD-2-Clause")).toBe("PASS");
    expect(classifyLicense("BSD-3-Clause")).toBe("PASS");
    expect(classifyLicense("0BSD")).toBe("PASS");
    expect(classifyLicense("(MIT OR WTFPL)")).toBe("PASS");
    expect(classifyLicense("(MIT OR CC0-1.0)")).toBe("PASS");
    expect(classifyLicense("(BSD-2-Clause OR MIT OR Apache-2.0)")).toBe("PASS");
    expect(classifyLicense("MPL-2.0")).toBe("WARN");
  });

  it("FAILs the `+` (or-later) suffix and bare / off-version copyleft ids", () => {
    // Regression: tokenMatchesId now strips a trailing SPDX `+`, and the deny
    // list uses bare family prefixes, so every GPL/AGPL form is caught — not
    // just the two versions that happened to be listed.
    expect(classifyLicense("GPL-2.0+")).toBe("FAIL");
    expect(classifyLicense("GPL-3.0+")).toBe("FAIL");
    expect(classifyLicense("AGPL-3.0+")).toBe("FAIL");
    expect(classifyLicense("GPL-1.0")).toBe("FAIL");
    expect(classifyLicense("GPL")).toBe("FAIL");
    expect(classifyLicense("AGPL")).toBe("FAIL");
    // `+` on a permissive arm stays permissive.
    expect(classifyLicense("Apache-2.0+")).toBe("PASS");
    // LGPL (incl. `+`) must still be WARN, never FAIL.
    expect(classifyLicense("LGPL-2.1+")).toBe("WARN");
  });

  it("exposes deny/permissive lists as the single source of truth", () => {
    expect(FAIL_LICENSES).toContain("AGPL");
    expect(FAIL_LICENSES).toContain("GPL");
    expect(PERMISSIVE_LICENSES).toContain("MIT");
  });
});
