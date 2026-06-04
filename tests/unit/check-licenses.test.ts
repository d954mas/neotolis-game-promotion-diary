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

  it("exposes deny/permissive lists as the single source of truth", () => {
    expect(FAIL_LICENSES).toContain("AGPL-3.0");
    expect(FAIL_LICENSES).toContain("GPL-3.0");
    expect(PERMISSIVE_LICENSES).toContain("MIT");
  });
});
