// Telegram warm auto-refresh eligibility — integration tests (real Postgres via
// ./helpers.js).
//
// PLACEHOLDER (Phase 9 Plan 01 Wave 0). The skipped `it`s below enumerate the
// warm-eligibility assertions from 09-RESEARCH.md §Validation Architecture; the
// warm predicate + producer (young AND stale, minus terminal / persistently-
// failing, enqueues a dedup'd service_post lane row with NO throttle gate since
// Telegram is free) lands in Plan 04/05. Boundaries come from
// TELEGRAM_WARM_WINDOW_DAYS (7) and TELEGRAM_WARM_STALENESS_HOURS (12).
//
// Skipped suites pass vacuously so the integration suite stays green in Wave 0.

import { describe, it } from "vitest";

describe.skip("telegram warm eligibility (filled in Plan 04/05)", () => {
  it.skip("includes a young (<7d) AND stale (last_polled_at older than 12h) post");
  it.skip("excludes a fresh post (last_polled_at within 12h)");
  it.skip("excludes an old post (older than the 7d warm window)");
  it.skip("excludes a terminal post (last_poll_status in not_found / private)");
  it.skip("respects the 7d window and 12h staleness boundaries exactly");
  it.skip(
    "warm producer enqueues a dedup'd service_post adapter_refresh_queue row with NO throttle gate (Telegram is free)",
  );
});
