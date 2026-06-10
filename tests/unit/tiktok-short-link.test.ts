// TikTok short-link resolution — vm.tiktok.com / vt.tiktok.com canonicalization
// (D-06). Pure unit test for the resolver's host gate + error mapping (the live
// HTTP follow is exercised at integration level).
//
// WAVE-0 SCAFFOLD: named `it.skip` placeholders the implementing plan (10-02,
// the TikTok short-link resolver) flips to live `it(...)`.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok short-link resolver (D-06) — Wave-0 scaffold", () => {
  it.skip("[10-02] a vm.tiktok.com short link resolves to the canonical /@handle/video/<id> URL");
  it.skip("[10-02] a vt.tiktok.com short link resolves to the canonical video URL");
  it.skip("[10-02] a non-short host passes through unchanged (null = not a short link)");
  it.skip("[10-02] a resolve timeout surfaces as an AdapterError(transient), not a crash");
});
