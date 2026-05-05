// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-08.
// DELETE /api/me/account/purge is the Permanent-delete-now CTA path
// (DV-6 — un-hidden in Phase 3.0 alongside the worker that grinds
// through the daily 60-day cohort). Hard-deletes the user's rows in
// FK-correct order in a single tx. The audit row is written outside
// the tx so it survives even if the cascade transiently fails (Phase 1
// rule: audit is INSERT-only and crash-safe).
import { describe, it } from "vitest";

describe("account purge route (Plan 03.0-08)", () => {
  it.skip("DELETE /api/me/account/purge hard-deletes user/games/data_sources/events/api_keys_steam rows — activated in Plan 03.0-08", () => {});
  it.skip("audit purge.completed row written under purged user_id with metadata.row_counts — activated in Plan 03.0-08", () => {});
  it.skip("cross-tenant target → 404 (account routes have no :userId path param; cross-tenant impossible by construction) — activated in Plan 03.0-08", () => {});
  it.skip("anonymous → 401 — activated in Plan 03.0-08", () => {});
});
