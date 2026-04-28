import { describe, it } from "vitest";
// Phase 2.1 Wave 0 placeholder — Plan 02.1-05 (dismissFromInbox service) + Plan 02.1-06 (PATCH route) flip these to live.

describe("INBOX-01: inbox flow + dismissal", () => {
  it.skip("Plan 02.1-05: an event created via paste with no attached game has game_id=NULL and surfaces in attached=false filter");
  it.skip("Plan 02.1-06: PATCH /api/events/:id/dismiss-inbox sets metadata.inbox.dismissed=true, returns 200 with updated EventDto");
  it.skip("Plan 02.1-06: dismissed event no longer appears in attached=false; still findable via attached=false&showDismissed=... (advanced filter NOT shipped in 2.1 — assert 'not in inbox view' only)");
  it.skip("Plan 02.1-06: PATCH /api/events/:id/dismiss-inbox on event with game_id IS NOT NULL returns 422 'not_in_inbox'");
  it.skip("Plan 02.1-06: cross-tenant PATCH /api/events/:id/dismiss-inbox returns 404 not_found");
  it.skip("Plan 02.1-06: PATCH /api/events/:id/dismiss-inbox writes audit_action='event.dismissed_from_inbox'");
  it.skip("Phase 3 Plan: auto-imported events arrive with source_id != NULL AND game_id=NULL — covered in Phase 3 smoke (deferred per CONTEXT D-11)");
});
