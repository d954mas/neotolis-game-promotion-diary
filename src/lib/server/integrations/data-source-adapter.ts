// DataSourceAdapter — Phase 2.1 contract for per-kind pollers (RESEARCH §2.1).
//
// One adapter per source_kind. Phase 2.1 ships the youtube_channel STUB only;
// Phase 3.0 (Plan 03.0-06) replaces the STUB with a real implementation that
// batches videos.list (≤50 ids per call, 1 quota unit per call — VERIFIED by
// the Plan 03.0-01 spike) and pages playlistItems.list against the channel's
// uploads playlist for backfill + auto-import.
//
// Adapters are PURE — no DB writes, no logging side effects, no global state.
// The events service decides author_is_me / source_id / dedup at INSERT time.
// Operator-side state (quota counters, key rotation) lives behind
// `pickKeyForJob` + `hashApiKeyId` (Plan 03.0-03 youtube-quota-tracker).
//
// pollStats accepts a nullable `source` because manual-paste pollable events
// (kind ∈ {youtube_video, reddit_post}, source_id IS NULL) must still receive
// stats history (CONTEXT D-05 / D-06). The Phase 3 worker enumerates
// `events WHERE kind IN ('youtube_video','reddit_post') AND deleted_at IS NULL`
// and calls `pollStats(events, source)` regardless of source_id.
//
// Phase 3.0 evolution of the interface (Plan 03.0-06):
//   - pollStats now takes a BATCH of events (typed minimally as
//     `{id,userId,externalId}[]`) so the adapter can issue one videos.list
//     per ≤50 ids — the 50× quota saving that gates the entire phase.
//   - StatsSnapshot.metrics is OPTIONAL (absent on non-ok statuses) and
//     gains an optional `metadata` field carrying `duration_seconds` +
//     `is_short` (D-NEW Shorts handling).
//   - SnapshotStatus is exported as a named type so callers (Plan 03.0-04
//     snapshot-writer, Plan 03.0-09 worker handlers) can switch on it
//     without re-stating the union.

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
  | "other"
  | "post";

export interface RawEvent {
  externalId: string;
  url: string;
  title: string;
  occurredAt: Date;
  kind?: EventKind;
  metadata?: Record<string, unknown>;
}

/** Discriminated outcome of a single per-event stats poll. */
export type SnapshotStatus = "ok" | "rate_limited" | "auth_error" | "not_found" | "private";

export interface StatsSnapshot {
  /** Optional event id correlation — set by the adapter when batching so the
   *  caller can re-align by id; preserved on input order otherwise. */
  eventId?: string;
  polledAt: Date;
  status: SnapshotStatus;
  /** Present on 'ok' status; absent on error statuses. */
  metrics?: { view_count?: number; like_count?: number; comment_count?: number };
  /** Phase 3.0 D-NEW Shorts handling — duration in seconds + is_short flag. */
  metadata?: { duration_seconds?: number; is_short?: boolean };
}

/** Minimal event projection consumed by pollStats — keeps the adapter
 *  decoupled from the full EventRow shape (which carries cipher columns +
 *  audit timestamps the adapter has no business reading). */
export interface PollableEvent {
  id: string;
  userId: string;
  externalId: string;
}

/** Minimal source projection consumed by pollContent — same rationale. */
export interface PollableSource {
  id: string;
  userId: string;
  metadata: Record<string, unknown>;
}

export interface DataSourceAdapter {
  readonly kind: SourceKind;
  pollContent(source: PollableSource, since: Date): Promise<RawEvent[]>;
  pollStats(
    events: PollableEvent[],
    source: { id: string; userId: string } | null,
  ): Promise<StatsSnapshot[]>;
}
