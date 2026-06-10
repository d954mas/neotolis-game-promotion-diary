// TikTok account subject entity (CHECKLIST §1a) — tiktok_accounts is UPSERTed
// from the create-time profile resolve + the free feed owner object with NO
// extra credit, COALESCE-preserving prior good metadata on a partial parse, and
// keyed on the stable account_id (rename-proof, the Telegram channelKey lesson).
// It is OUR truth for the account's own upstream metadata, NOT a denorm of
// data_sources.display_name.
//
// WAVE-0 SCAFFOLD: named `it.skip` placeholders the implementing plan (10-04)
// flips to live `it(...)`.
//
// Requirements: PLAT-02.
import { describe, it } from "vitest";

describe("tiktok account subject entity (CHECKLIST §1a) — Wave-0 scaffold", () => {
  it.skip("[10-04] the create-time profile resolve UPSERTs tiktok_accounts keyed on account_id");
  it.skip(
    "[10-04] the walker opportunistically refreshes username/avatar from the free feed owner",
  );
  it.skip("[10-04] a changed @handle appends the old value to handle_aliases (rename history)");
  it.skip("[10-04] a partial parse COALESCE-preserves prior good nickname/avatar (no blanking)");
});
