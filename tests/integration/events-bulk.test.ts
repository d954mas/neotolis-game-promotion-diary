/**
 * Integration tests for /api/events/bulk PATCH + DELETE.
 *
 * Wave 1 Plan 05 ships the bulkEdit / bulkDelete / bulkDeleteForever
 * service functions; Wave 1 Plan 06 mounts the Hono route. This file
 * lands as Wave 0 it.skip scaffolding so Plan 05 + 06 have a concrete
 * target.
 *
 * Contract anchors:
 *   - D-12 — tri-state {gameStates, offTopicState} apply in single tx
 *   - D-13 — cross-tenant ids silently filtered (NOT 403/404)
 *   - D-14 — ONE audit row per bulk operation (NOT N per event)
 *   - D-15 — bulk DELETE doesn't count against events_per_day; bulk
 *            PATCH counts as Math.ceil(N/10) against events_per_day
 *   - D-21 — ?force=true hard-deletes already-soft-deleted only
 *
 * Wave 1 activation: un-comment the service imports below; Wave 1 Plan 05
 * lands bulkEdit / bulkDelete / bulkDeleteForever in
 * src/lib/server/services/events.ts. Wave 1 Plan 06 mounts the route in
 * src/lib/server/http/routes/events.ts via the existing Hono `app`.
 */

import { describe, it } from "vitest";
// Wave 1 Plan 06 ACTIVATES this import:
// import { app } from "../../src/lib/server/http/app.js";
// Wave 1 Plan 05 ACTIVATES these imports:
// import {
//   bulkEdit,
//   bulkDelete,
//   bulkDeleteForever,
// } from "../../src/lib/server/services/events.js";

describe("/api/events/bulk PATCH (Wave 1 Plan 06)", () => {
  it.skip("Wave 1 Plan 06: PATCH bulk with gameStates={g1:'on', g2:'off', g3:'mixed'} applies tri-state semantics (D-12)", async () => {});
  it.skip("Wave 1 Plan 06: PATCH bulk with offTopicState='on' sets metadata.triage.offTopic=true for all owned ids", async () => {});
  it.skip("Wave 1 Plan 06: PATCH bulk with offTopicState='mixed' leaves metadata.triage.offTopic alone per event", async () => {});
  it.skip("Wave 1 Plan 06: PATCH bulk silently filters cross-tenant ids; affected_count reflects subset (D-13)", async () => {});
  it.skip("Wave 1 Plan 06: PATCH bulk writes EXACTLY ONE audit row events.bulk_edit with affected_ids in metadata (D-14)", async () => {});
  it.skip("Wave 1 Plan 06: PATCH bulk return shape strips ciphertext via toEventDto projection", async () => {});
  it.skip("Wave 1 Plan 06: PATCH bulk with empty diff (all 'mixed' / no changes) returns affected_count=0 + no audit row", async () => {});
  it.skip("Wave 1 Plan 06: PATCH bulk cross-tenant gameId in gameStates silently dropped before tx (no NotFoundError leak)", async () => {});
});

describe("/api/events/bulk DELETE (Wave 1 Plan 06)", () => {
  it.skip("Wave 1 Plan 06: DELETE bulk soft-deletes N owned events; ev_OtherUser untouched (D-13)", async () => {});
  it.skip("Wave 1 Plan 06: DELETE bulk writes ONE audit row events.bulk_delete with affected_ids (D-14)", async () => {});
  it.skip("Wave 1 Plan 06: DELETE bulk on already-soft-deleted events skips them (deletedAt isNull filter)", async () => {});
  it.skip("Wave 1 Plan 06: DELETE bulk doesn't count against events_per_day quota (D-15)", async () => {});
});

describe("/api/events/bulk?force=true DELETE (Wave 1 Plan 06)", () => {
  it.skip("Wave 1 Plan 06: DELETE ?force=true hard-deletes only already-soft-deleted owned ids (D-21)", async () => {});
  it.skip("Wave 1 Plan 06: DELETE ?force=true on live (not-yet-soft-deleted) event silently filtered out (D-21)", async () => {});
  it.skip("Wave 1 Plan 06: DELETE ?force=true writes audit row events.delete_forever (D-14)", async () => {});
});
