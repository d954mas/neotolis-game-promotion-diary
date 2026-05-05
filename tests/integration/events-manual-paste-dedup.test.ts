// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-04.
// Manual-paste dedup is enforced by a partial unique index
// (user_id, kind, external_id) WHERE deleted_at IS NULL — soft-deleted
// rows are invisible to the constraint so a user can re-paste a
// previously-deleted URL. Cross-tenant uniqueness is by construction
// (user_id is in the index). Plan 03.0-04 maps the resulting 23505 to
// AppError 422 duplicate_event (D-15 — the Phase 2 try/catch-around-
// INSERT exception applies).
import { describe, it } from "vitest";

describe("events manual-paste dedup (Plan 03.0-04)", () => {
  it.skip("second manual paste of same external_id → 422 duplicate_event — activated in Plan 03.0-04", () => {});
  it.skip("soft-deleted dupe is INVISIBLE to the partial unique index (deleted_at filter) — activated in Plan 03.0-04", () => {});
  it.skip("different user pasting same URL → succeeds (user-scoped uniqueness) — activated in Plan 03.0-04", () => {});
});
