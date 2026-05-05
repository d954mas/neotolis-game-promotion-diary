// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-04.
// Service-layer cooldown gate that throws AppError 429 with metadata
// {minutesLeft} so the HTTP boundary in Plan 03.0-08 can surface a
// Retry-After header without parsing message strings. The 5min window
// matches RefreshNowButton's tooltip copy (UI-SPEC §RefreshNowButton).
import { describe, it } from "vitest";

describe("refresh-poll cooldown service (Plan 03.0-04)", () => {
  it.skip("service throws AppError 429 too_many_refreshes when within 5min window — activated in Plan 03.0-04", () => {});
  it.skip("service.metadata payload includes minutesLeft — activated in Plan 03.0-04", () => {});
  it.skip("5min after last refresh → service permits refresh again — activated in Plan 03.0-04", () => {});
});
