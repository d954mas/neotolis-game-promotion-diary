// TikTok not-configured degrade (SOC-05) — with TIKTOK_PROVIDER empty, the
// add-source TikTok chip is disabled, no scraper credits are spent, and boot
// still succeeds (self-host parity — empty-env state, not an APP_MODE branch).
//
// WAVE-0 SCAFFOLD: named `it.skip` placeholders the implementing plan (10-02/03)
// flips to live `it(...)`.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok not-configured degrade (SOC-05) — Wave-0 scaffold", () => {
  it.skip("[10-03] with TIKTOK_PROVIDER empty, the TikTok kind matrix entry is disabled");
  it.skip("[10-03] no TikTok provider request is issued while the provider is unconfigured");
});
