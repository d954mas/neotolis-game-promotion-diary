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
