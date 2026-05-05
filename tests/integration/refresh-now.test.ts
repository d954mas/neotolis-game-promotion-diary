// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-08.
// POST /api/events/:id/refresh-poll is the user-side affordance for
// "refresh this event's stats right now". The route enqueues to
// poll.user (its own queue so user-pressed work doesn't compete with
// Active / Cold cron-scheduled work) and persists last_user_refresh_at
// for the 5-min cooldown gate. Cross-tenant + anonymous + cooldown
// behaviors are all asserted here; the unit-level cooldown service
// behavior is in refresh-poll-cooldown.test.ts.
import { describe, it } from "vitest";

describe("refresh-now route (Plan 03.0-08)", () => {
  it.skip("POST /api/events/:id/refresh-poll 200 enqueues to poll.user — activated in Plan 03.0-08", () => {});
  it.skip("POST refresh-poll persists events.metadata.last_user_refresh_at — activated in Plan 03.0-08", () => {});
  it.skip("second click within 5min → 429 with retry-after metadata — activated in Plan 03.0-08", () => {});
  it.skip("cross-tenant event id → 404 — activated in Plan 03.0-08", () => {});
  it.skip("anonymous → 401 — activated in Plan 03.0-08", () => {});
});
