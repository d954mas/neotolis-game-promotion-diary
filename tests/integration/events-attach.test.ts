import { describe, it } from "vitest";
// Phase 2.1 Wave 0 placeholder — Plan 02.1-05 (attachToGame service) + Plan 02.1-06 (PATCH route) flip these to live.

describe("GAMES-04a (reframed): per-event game attachment", () => {
  it.skip("Plan 02.1-06: PATCH /api/events/:id/attach { gameId } sets events.game_id, returns 200 EventDto");
  it.skip("Plan 02.1-06: PATCH /api/events/:id/attach { gameId: null } clears events.game_id (move-to-inbox)");
  it.skip("Plan 02.1-06: PATCH /api/events/:id/attach validates the gameId belongs to userId BEFORE the update (Pitfall 4 — call getGameById first; cross-tenant attach returns 404 not 500)");
  it.skip("Plan 02.1-06: cross-tenant PATCH /api/events/:id/attach returns 404 not_found (NotFoundError)");
  it.skip("Plan 02.1-06: PATCH /api/events/:id/attach writes audit_action='event.attached_to_game' with metadata.event_id + metadata.game_id");
  it.skip("Plan 02.1-06: anonymous PATCH /api/events/:id/attach returns 401 unauthorized");
  it.skip("Plan 02.1-06: PATCH /api/events/:id/attach { gameId } on non-existent gameId returns 404 not_found");
});
