// Twitter/X create-source error handling (Wave-0 scaffold).
//
// Named it.skip placeholders — Plan 11-04 flips these live. An unresolvable /
// suspended / protected handle must return 422 and leave NO phantom data_source
// row behind (validate-before-INSERT, AGENTS.md no-half-write; Pitfall 4).
//
// Requirements: PLAT-03 (Pitfall 4 — no phantom source).
import { describe, it } from "vitest";

describe("twitter create-source error handling", () => {
  it.skip("[11-04] an unresolvable handle -> 422, no data_source row created", () => {});

  it.skip("[11-04] a suspended account -> 422, no data_source row created", () => {});

  it.skip("[11-04] a protected account -> 422, no data_source row created", () => {});
});
