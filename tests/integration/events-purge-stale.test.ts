/**
 * Integration tests for purgeStaleDeletedEvents() — extends Phase 03.0
 * purge.daily cron handler (D-20).
 *
 * Wave 1 Plan 05 ships the service function; Wave 1 Plan 06 adds the
 * call in src/worker/handlers/purge-daily.ts.
 *
 * Contract anchors:
 *   - D-20 — extend existing Phase 03.0 purgeAccount cron worker; add a
 *            new step purgeStaleDeletedEvents() to the daily 4am PT cron;
 *            single audit row per purge cycle events.purge_stale
 *   - D-14 — ONE audit row per bulk operation (per-tenant cursor)
 *
 * Wave 1 activation: un-comment the service import below; Wave 1 Plan 05
 * lands purgeStaleDeletedEvents in
 * src/lib/server/services/purge-account.ts. Wave 1 Plan 06 wires it into
 * src/worker/handlers/purge-daily.ts.
 */

import { describe, it } from "vitest";
// Wave 1 Plan 05 ACTIVATES this import:
// import { purgeStaleDeletedEvents } from "../../src/lib/server/services/purge-account.js";

describe("purgeStaleDeletedEvents (Wave 1 Plan 05/06)", () => {
  it.skip(
    "Wave 1 Plan 05: hard-deletes events with deletedAt < now() - 30d (D-20)",
    async () => {},
  );
  it.skip(
    "Wave 1 Plan 05: preserves events with deletedAt within 30d (still recoverable)",
    async () => {},
  );
  it.skip(
    "Wave 1 Plan 05: preserves events with deletedAt IS NULL (live events untouched)",
    async () => {},
  );
  it.skip(
    "Wave 1 Plan 05: writes ONE audit row events.purge_stale per affected user_id (per-tenant cursor invariant — D-14)",
    async () => {},
  );
  it.skip(
    "Wave 1 Plan 05: audit metadata includes affected_count and purged_at; affected_ids included only when N<=100",
    async () => {},
  );
  it.skip(
    "Wave 1 Plan 05: returns { affected_count: N } total across all tenants",
    async () => {},
  );
  it.skip(
    "Wave 1 Plan 05: idempotent — re-running on empty trash returns affected_count: 0; no audit row",
    async () => {},
  );
});
