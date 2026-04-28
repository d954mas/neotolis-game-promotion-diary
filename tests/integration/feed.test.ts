import { describe, it } from "vitest";
// Phase 2.1 Wave 0 placeholder — Plan 02.1-05 (listFeedPage service) + Plan 02.1-06 (GET /api/events route) flip these to live.

describe("FEED-01: GET /api/events chronological pool with URL filters", () => {
  it.skip("Plan 02.1-06: GET /api/events returns ALL user events sorted occurredAt DESC, id DESC; cursor null when fewer than FEED_PAGE_SIZE+1");
  it.skip("Plan 02.1-06: GET /api/events?source=:id filters to events with that source_id");
  it.skip("Plan 02.1-06: GET /api/events?kind=youtube_video filters by kind");
  it.skip("Plan 02.1-06: GET /api/events?game=:id filters by game_id");
  it.skip("Plan 02.1-06: GET /api/events?attached=true returns only events with game_id IS NOT NULL");
  it.skip("Plan 02.1-06: GET /api/events?attached=false returns events with game_id IS NULL AND metadata.inbox.dismissed != true");
  it.skip("Plan 02.1-06: GET /api/events?authorIsMe=true filters by author_is_me");
  it.skip("Plan 02.1-06: GET /api/events?from=ISO&to=ISO filters by occurredAt range");
  it.skip("Plan 02.1-06: GET /api/events combination filter source+kind+attached works");
  it.skip("Plan 02.1-06: GET /api/events with cursor returns next FEED_PAGE_SIZE rows; cursor is base64url JSON {at,id}");
  it.skip("Plan 02.1-06: GET /api/events cursor opacity does not let user A see user B's row IDs (P19 — userId WHERE clause first)");
  it.skip("Plan 02.1-06: GET /api/events response items have userId stripped (toEventDto projection)");
});
