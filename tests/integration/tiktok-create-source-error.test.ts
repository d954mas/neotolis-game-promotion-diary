// TikTok create-source error paths — duplicate source (422 duplicate_source with
// the TikTok-specific message), cross-tenant access returns 404 (never 403), and
// an unconfigured-provider add is rejected at the boundary (kind_not_yet_functional /
// not-configured) before any credit is spent.
//
// WAVE-0 SCAFFOLD: named `it.skip` placeholders the implementing plan (10-03)
// flips to live `it(...)`.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok create-source error paths — Wave-0 scaffold", () => {
  it.skip("[10-03] re-adding the same TikTok account returns 422 duplicate_source");
  it.skip("[10-03] another tenant's TikTok source returns 404 (never 403)");
  it.skip(
    "[10-03] adding a TikTok source while the provider is unconfigured is rejected pre-spend",
  );
});
