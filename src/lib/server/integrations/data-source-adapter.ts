// DataSourceAdapter — Phase 2.1 contract for per-kind pollers (RESEARCH §2.1).
//
// One adapter per source_kind. Phase 2.1 ships the youtube_channel STUB only;
// Phase 3 fills in pollContent / pollStats alongside the polling worker.
// Adapters are PURE — no DB writes, no logging side effects, no global state.
// The events service decides author_is_me / source_id / dedup at INSERT time.
//
// pollStats accepts a nullable `source` because manual-paste pollable events
// (kind ∈ {youtube_video, reddit_post}, source_id IS NULL) must still receive
// stats history (CONTEXT D-05 / D-06). The Phase 3 worker enumerates
// `events WHERE kind IN ('youtube_video','reddit_post') AND deleted_at IS NULL`
// and calls `pollStats(event, source)` regardless of source_id.

import type { dataSources, events } from "../db/schema/index.js";

export type DataSourceRow = typeof dataSources.$inferSelect;
export type EventRow = typeof events.$inferSelect;

export type SourceKind =
  | "youtube_channel"
  | "reddit_account"
  | "twitter_account"
  | "telegram_channel"
  | "discord_server";

export type EventKind =
  | "youtube_video"
  | "twitter_post"
  | "telegram_post"
  | "discord_drop"
  | "reddit_post"
  | "conference"
  | "talk"
  | "press"
  | "other";

export interface RawEvent {
  externalId: string;
  url: string;
  title: string;
  occurredAt: Date;
  kind: EventKind;
  metadata: Record<string, unknown>;
}

export interface StatsSnapshot {
  polledAt: Date;
  metrics: Record<string, number>;
  status: "ok" | "rate_limited" | "auth_error" | "not_found" | "private";
}

export interface DataSourceAdapter {
  readonly kind: SourceKind;
  pollContent(source: DataSourceRow, since: Date): Promise<RawEvent[]>;
  pollStats(event: EventRow, source: DataSourceRow | null): Promise<StatsSnapshot>;
}
