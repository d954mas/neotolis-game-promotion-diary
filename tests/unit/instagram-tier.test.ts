// PLACEHOLDER (Wave-0, it.skip) — activated by Plan 08-04.
// Requirements: BACK-04.
//
// Age tiering for IG reuses the platform-agnostic tier-resolver: feeding an IG
// publishedAt classifies into active/cold/frozen identically to YouTube. Pure
// unit test — no DB, no HTTP.
import { describe, it } from "vitest";
// import { resolveTier } from "$lib/server/services/tier-resolver.js";

describe("instagram tier resolution (reuses tier-resolver)", () => {
  it.skip("resolveTier classifies an IG publishedAt into active/cold/frozen identically to YouTube", async () => {
    // Plan 04: age < 24h -> active, 24h..28d -> cold, >= 28d -> frozen —
    // same thresholds, no IG-specific tier code.
  });
});
