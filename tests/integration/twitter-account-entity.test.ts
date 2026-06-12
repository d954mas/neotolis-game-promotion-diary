// Twitter/X account subject entity (Wave-0 scaffold).
//
// Named it.skip placeholders — Plan 11-03 flips these live. twitter_accounts is
// upserted from the FREE feed owner object + the create-time PAID profile resolve,
// keyed on the rename-proof numeric account id, with handle changes appended to
// handle_aliases (mirrors the TikTok/IG account-entity upsert).
//
// Requirements: PLAT-03 (CHECKLIST §1a subject entity).
import { describe, it } from "vitest";

describe("twitter account subject entity", () => {
  it.skip("[11-03] upserts twitter_accounts from the free feed owner object (zero extra credit)", () => {});

  it.skip("[11-03] the create-time profile resolve fills the richer fields (name/avatar/follower_count)", () => {});

  it.skip("[11-03] keyed on the rename-proof numeric account_id, never the renameable @handle", () => {});

  it.skip("[11-03] a changed @handle appends the old value to handle_aliases", () => {});

  it.skip("[11-03] a partial/failed parse COALESCE-preserves the prior good metadata", () => {});
});
