// Telegram backfill walker — integration tests (real Postgres via ./helpers.js).
//
// PLACEHOLDER (Phase 9 Plan 01 Wave 0). The skipped `it`s below enumerate the
// resumable-walker assertions from 09-RESEARCH.md §Data Path (?before cursor);
// the walker (page -> persist cursor -> next page -> end-of-history ->
// backfill_complete=true, drained via adapter_refresh_queue lane rows) lands in
// Plan 04/05.
//
// Skipped suites pass vacuously so the integration suite stays green in Wave 0.

import { describe, it } from "vitest";

describe.skip("telegram backfill walker (filled in Plan 04/05)", () => {
  it.skip("persists the ?before cursor, fetches the next page, and never re-fetches a page");
  it.skip(
    "sets backfill_complete=true on end-of-history (zero [data-post] blocks or no more-wrap cursor)",
  );
});
