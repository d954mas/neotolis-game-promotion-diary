import { describe, it, expect } from "vitest";
import { youtubeChannelAdapter } from "../../src/lib/server/integrations/youtube-channel-adapter.js";
import type {
  DataSourceRow,
  EventRow,
} from "../../src/lib/server/integrations/data-source-adapter.js";

// Plan 02.1-03 Task 2 — DataSourceAdapter STUB.
//
// The youtube_channel adapter ships in 2.1 as a STUB so Wave 1 services have
// a contract to compile against; Phase 3 fills in pollContent / pollStats
// alongside the polling worker. Both methods must throw with the documented
// "implemented in Phase 3" message so any Wave 1 service that accidentally
// imports + invokes them fails loudly instead of silently returning nothing.

describe("youtubeChannelAdapter (Phase 2.1 STUB)", () => {
  it("kind is the youtube_channel literal (narrowed via `as const`)", () => {
    expect(youtubeChannelAdapter.kind).toBe("youtube_channel");
  });

  it("pollContent throws with the documented Phase 3 message", async () => {
    const fakeSource = {} as DataSourceRow;
    await expect(youtubeChannelAdapter.pollContent(fakeSource, new Date())).rejects.toThrow(
      /youtube_channel\.pollContent: implemented in Phase 3/,
    );
  });

  it("pollStats throws with the documented Phase 3 message (source nullable)", async () => {
    const fakeEvent = {} as EventRow;
    await expect(youtubeChannelAdapter.pollStats(fakeEvent, null)).rejects.toThrow(
      /youtube_channel\.pollStats: implemented in Phase 3/,
    );
  });
});

// Phase 3.0 Wave 0 placeholder — assertions activate in Plan 03.0-06.
// Plan 03.0-06 replaces the Phase 2.1 STUB methods with real
// videos.list / playlistItems.list adapters. The contract:
// - pollContent uses uploads_playlist_id from data_sources.metadata to
//   page playlistItems.list (1 unit per page) and returns RawEvent[].
// - pollStats batches up to 50 video ids into ONE videos.list call (1
//   unit total — the 50× saving that gates the entire phase per
//   CONTEXT D-02).
// - error mapping: 403 quotaExceeded → status:rate_limited (worker
//   defers + scheduler pauses); 403 forbidden → status:auth_error
//   (event tier flips to Unavailable); 404 → status:not_found (same).
// - quotaUser=hash(userId) param sent on every call so YouTube's
//   per-user fairness gate splits the operator's quota evenly across
//   tenants instead of letting one whale starve the others.
describe("youtube-channel-adapter live impl (Plan 03.0-06)", () => {
  it.skip("pollContent issues playlistItems.list and returns RawEvent[] — activated in Plan 03.0-06", () => {});
  it.skip("pollStats issues videos.list batched (50 ids) for 1 unit — activated in Plan 03.0-06", () => {});
  it.skip("pollStats maps 403 quotaExceeded → status:rate_limited — activated in Plan 03.0-06", () => {});
  it.skip("pollStats maps 403 forbidden → status:auth_error — activated in Plan 03.0-06", () => {});
  it.skip("pollStats maps 404 → status:not_found — activated in Plan 03.0-06", () => {});
  it.skip("pollStats sends quotaUser=hash(userId) param — activated in Plan 03.0-06", () => {});
});
