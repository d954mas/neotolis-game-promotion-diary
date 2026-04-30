// youtube_channel adapter — Phase 2.1 STUB.
//
// Ships the DataSourceAdapter shape so Wave 1 services have a contract to
// compile against. Phase 3 fills in pollContent / pollStats alongside the
// polling worker; both methods throw the documented "implemented in Phase 3"
// error so any Wave 1 caller that accidentally invokes them fails loudly
// instead of silently returning nothing.

import type {
  DataSourceAdapter,
  DataSourceRow,
  EventRow,
  RawEvent,
  StatsSnapshot,
} from "./data-source-adapter.js";

export const youtubeChannelAdapter: DataSourceAdapter = {
  kind: "youtube_channel" as const,

  // Phase 3 fills this in: googleapis playlistItems.list against
  // metadata.uploads_playlist_id, paginate by pageToken. Dedup is the
  // events service's job (UNIQUE(user_id, kind, source_id, external_id)).
  async pollContent(_source: DataSourceRow, _since: Date): Promise<RawEvent[]> {
    throw new Error("youtube_channel.pollContent: implemented in Phase 3 alongside the worker");
  },

  // Phase 3 fills this in: googleapis videos.list batched (50 ids per call,
  // 1 quota unit, 50× saving over per-video calls — verified by the Phase 3
  // spike). Source is nullable so manual-paste pollable events (CONTEXT D-05
  // / D-06) get the same treatment as source-attached events.
  async pollStats(_event: EventRow, _source: DataSourceRow | null): Promise<StatsSnapshot> {
    throw new Error("youtube_channel.pollStats: implemented in Phase 3 alongside the worker");
  },
};
