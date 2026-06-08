// Telegram listing poll — integration tests (real Postgres via ./helpers.js).
//
// PLACEHOLDER (Phase 9 Plan 01 Wave 0). The skipped `it`s below enumerate the
// listing-poll assertions from 09-RESEARCH.md §Validation Architecture; the
// listing-poll handler (writes telegram_posts + telegram_post_snapshots,
// idempotent within-minute snapshot) lands in Plan 04/05.
//
// Skipped suites pass vacuously so the integration suite stays green in Wave 0.

import { describe, it } from "vitest";

describe.skip("telegram listing poll (filled in Plan 04/05)", () => {
  it.skip("writes a telegram_posts row + a telegram_post_snapshots row per parsed post");
  it.skip("is idempotent on (post_id, polled_at-minute) via INSERT ... ON CONFLICT DO NOTHING");
});
