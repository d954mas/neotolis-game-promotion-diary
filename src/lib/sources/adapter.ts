// Widened DataSourceAdapter — Phase 03.0.1 D-01..D-17. Supersedes
// src/lib/server/integrations/data-source-adapter.ts (deleted in Plan 03 once
// youtubeAdapter is registered).
//
// Plan 01 landed this file co-existing with the legacy interface; Plan 03
// wires the YouTube adapter in and deletes the legacy file.
//
// Differences from the legacy interface (see data-source-adapter.ts):
//   - parseUrl(url) — per-adapter URL detection (D-15 first-match-wins).
//   - observability — per-adapter quota/audit/auth API for /admin/quota tabs
//     (D-08).
//   - registerQueues / scheduleCronTicks / backfillSource — adapter owns its
//     queue topology and cron schedules (D-10 per-kind queues).
//   - canRefreshPoll — optional dispatch hint for the generic
//     POST /api/sources/:id/refresh-content endpoint (Plan 10).
//
// Plan 03 deviation note (Rule 3 — blocking issue): the v0.1 adapter methods
// (pollContent / pollStats / pollStatsByVideoId) keep their legacy `PickedKey`
// + `quotaUser` signatures because callers (poll-active / poll-cold /
// poll-user / rehab-unavailable) still thread a pre-resolved key down for the
// `youtube_service_quota_usage` row keyed under the same apiKeyId the adapter
// burned (PickedKey jsdoc rationale; load-bearing with N≥2 keys). Moving
// picking INSIDE the adapter (D-06 Thick scope) requires either returning
// apiKeyId on every StatsSnapshot or threading ctx into pickCredentials —
// both are non-trivial behavioral changes that land in Plan 04 (services
// move) / Plan 08 (observability + reservoir) once the supporting
// infrastructure is in place. Plan 01's widened-interface comment ("ctx
// instead of PickedKey") was aspirational; Plan 03 reconciles to reality.
//
// AdapterContext is still defined here because parseUrl-iteration callers
// (Plan 06) and backfillSource (Plan 10) consume it directly; the legacy
// methods just don't take it yet.

import type { dataSources, events } from "$lib/server/db/schema/index.js";

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

export type SnapshotStatus = "ok" | "rate_limited" | "auth_error" | "not_found" | "private";

export interface RawEvent {
  externalId: string;
  url: string;
  title: string;
  occurredAt: Date;
  kind?: EventKind;
  metadata?: Record<string, unknown>;
}

export interface StatsSnapshot {
  eventId?: string;
  polledAt: Date;
  status: SnapshotStatus;
  metrics?: { view_count?: number; like_count?: number; comment_count?: number };
  metadata?: { duration_seconds?: number; is_short?: boolean };
}

export interface PollableEvent {
  id: string;
  userId: string;
  externalId: string;
}

export interface PollableSource {
  id: string;
  userId: string;
  metadata: Record<string, unknown>;
}

/** AdapterContext threads tenant + origin into adapter calls so credential
 *  picking + rate-limit budget split happen inside the adapter (D-06, D-09).
 *  Plan 03: parseUrl-iterators (Plan 06) and backfillSource (Plan 10) consume
 *  this; the v0.1 poll methods still take PickedKey directly until Plan 04/08
 *  refactors picking inside. */
export interface AdapterContext {
  userId: string | null;
  origin: "cron" | "user";
}

/**
 * PickedKey — adapter callers pre-pick a key from the quota tracker and
 * thread it down. Without this, the adapter would call `pickKeyForJob`
 * internally per chunk and drift the round-robin index against the
 * caller's tracking — counter rows in `youtube_service_quota_usage` would
 * end up keyed under the caller's pick while the actual HTTP burned a
 * different key (visible only with N≥2 keys; silent at indie scale).
 *
 * Threading the pick through the call chain ties one batch to one key:
 * a 100-video batch fans out into 2 chunks but both HTTP calls hit the
 * same key, the same counter row updates, and the operator's
 * /admin/quota dashboard reflects predictable round-robin balance.
 *
 * Phase 03.0.1 Plan 03 keeps PickedKey in the contract. Plan 04/08 will
 * either return apiKeyId on every snapshot or thread AdapterContext into
 * pickCredentials inside the adapter — both follow the Thick-adapter D-06
 * direction but require schema-level changes that don't fit Plan 03's
 * relocation-only scope.
 */
export interface PickedKey {
  apiKey: string;
  apiKeyId: string;
}

/** Per-adapter URL detection result — D-15 first-match-wins iteration. */
export interface ParsedUrl {
  kind: EventKind;
  externalId: string;
  metadata?: Record<string, unknown>;
}

export interface ObservabilityAuth {
  kind:
    | "operator-static-key"
    | "operator-oauth-app-only"
    | "scrape"
    | "operator-oauth-with-user-override";
  requiresUserSetup: boolean;
  isOperatorConfigured: boolean;
}

export interface ObservabilityDailyStats {
  unitsUsed: number;
  dailyLimit: number;
  pctOfDaily: number;
  throttleState: "ok" | "eighty" | "ninetyfive";
  keys?: Array<{ apiKeyId: string; unitsUsed: number }>;
  costEstimateUsd?: number;
}

export interface ObservabilityAuditEntry {
  action: string;
  occurredAt: Date;
  metadata: Record<string, unknown>;
}

export interface AdapterObservability {
  auth: ObservabilityAuth;
  quota: {
    getDailyStats(date: Date): Promise<ObservabilityDailyStats>;
    getRecentAudit(limit: number): Promise<ObservabilityAuditEntry[]>;
  };
}

/** Minimal pg-boss surface the adapter consumes — keeps the adapter decoupled
 *  from pg-boss major-version type drift (Phase 1 Plan 03 MinimalBoss
 *  pattern). Plan 03 widens this if youtubeAdapter needs more verbs. */
export interface MinimalBoss {
  work(
    name: string,
    opts: { batchSize?: number },
    handler: (jobs: unknown[]) => Promise<void>,
  ): Promise<unknown>;
  schedule(
    name: string,
    cron: string,
    payload?: object,
    options?: { tz?: string; key?: string },
  ): Promise<unknown>;
  send(
    name: string,
    payload: object,
    options?: { singletonKey?: string; priority?: number },
  ): Promise<string | null>;
  createQueue(name: string): Promise<unknown>;
}

export interface DataSourceAdapter {
  readonly kind: SourceKind;
  /** v0.1 surface — preserved verbatim from legacy data-source-adapter.ts.
   *  Plan 04/08 will move credential picking INSIDE the adapter (D-06 Thick
   *  scope); until then the caller threads PickedKey down. */
  pollContent(source: PollableSource, since: Date): Promise<RawEvent[]>;
  /** User-driven stats polling (Refresh now button). quotaUser fingerprint
   *  is derived from userId inside the adapter (per-user burst-shaper
   *  bucket). Caller pre-picks a key and threads it through; adapter never
   *  picks on its own (avoids round-robin drift — see PickedKey jsdoc). */
  pollStats(
    events: PollableEvent[],
    source: { id: string; userId: string } | null,
    picked: PickedKey,
  ): Promise<StatsSnapshot[]>;
  /** Service-driven stats polling (poll-active / poll-cold cron tick).
   *  Per-video, not per-event — multiple tenants referencing one video share
   *  the same HTTP. quotaUser is a constant per tier ("neotolis-svc-active"
   *  or "neotolis-svc-cold") so Google's burst-shaper buckets service polls
   *  away from user-driven Refresh now polls. */
  pollStatsByVideoId(
    videoIds: string[],
    quotaUser: string,
    picked: PickedKey,
  ): Promise<StatsSnapshot[]>;
  /** Phase 03.0.1 widened-contract surface (Plans 06/08/05/07/10). */
  parseUrl(url: string): ParsedUrl | null;
  readonly observability: AdapterObservability;
  registerQueues(boss: MinimalBoss): Promise<void>;
  scheduleCronTicks(boss: MinimalBoss): Promise<void>;
  backfillSource(
    source: PollableSource,
    ctx: AdapterContext,
  ): Promise<{ jobId: string | null; queue: string }>;
  /** Whether this adapter can handle a refresh-poll for the given event kind. */
  canRefreshPoll?(eventKind: EventKind): boolean;
}
