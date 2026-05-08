// Widened DataSourceAdapter — Phase 03.0.1 D-01..D-17. Supersedes
// src/lib/server/integrations/data-source-adapter.ts (deleted in Plan 03 once
// youtubeAdapter is registered). Plan 01 lands the type contract co-existing
// with the legacy interface; no behavior change yet.
//
// Plan 01 keeps this file PURELY structural — the runtime registry in
// registry.ts is empty until Plan 03 wires `youtubeAdapter`. Tests in
// tests/unit/sources/registry.test.ts assert that empty-registry state
// (getAdapter throws on every kind) so the contract is exercised pre-wiring.
//
// Differences from the legacy interface (see data-source-adapter.ts):
//   - pollContent / pollStats / pollStatsByVideoId now take an `AdapterContext`
//     instead of a `PickedKey` parameter — credential picking moves INSIDE the
//     adapter via `pickCredentials(ctx)` (D-06 Thick adapter scope).
//   - parseUrl(url) — per-adapter URL detection (D-15 first-match-wins).
//   - observability — per-adapter quota/audit/auth API for /admin/quota tabs
//     (D-08).
//   - registerQueues / scheduleCronTicks / backfillSource — adapter owns its
//     queue topology and cron schedules (D-10 per-kind queues).
//   - canRefreshPoll — optional dispatch hint for the generic
//     POST /api/sources/:id/refresh-content endpoint (Plan 10).

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
 *  picking + rate-limit budget split happen inside the adapter (D-06, D-09). */
export interface AdapterContext {
  userId: string | null;
  origin: "cron" | "user";
}

/** Per-adapter URL detection result — D-15 first-match-wins iteration. */
export interface ParsedUrl {
  kind: EventKind;
  externalId: string;
  metadata?: Record<string, unknown>;
}

export interface ObservabilityAuth {
  kind: "operator-static-key" | "operator-oauth-app-only" | "scrape" | "operator-oauth-with-user-override";
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
  work(name: string, opts: { batchSize?: number }, handler: (jobs: unknown[]) => Promise<void>): Promise<unknown>;
  schedule(name: string, cron: string, payload?: object, options?: { tz?: string; key?: string }): Promise<unknown>;
  send(name: string, payload: object, options?: { singletonKey?: string; priority?: number }): Promise<string | null>;
  createQueue(name: string): Promise<unknown>;
}

export interface DataSourceAdapter {
  readonly kind: SourceKind;
  pollContent(source: PollableSource, since: Date, ctx: AdapterContext): Promise<RawEvent[]>;
  pollStats(events: PollableEvent[], source: PollableSource | null, ctx: AdapterContext): Promise<StatsSnapshot[]>;
  pollStatsByVideoId(externalIds: string[], ctx: AdapterContext): Promise<StatsSnapshot[]>;
  parseUrl(url: string): ParsedUrl | null;
  readonly observability: AdapterObservability;
  registerQueues(boss: MinimalBoss): Promise<void>;
  scheduleCronTicks(boss: MinimalBoss): Promise<void>;
  backfillSource(source: PollableSource, ctx: AdapterContext): Promise<{ jobId: string | null; queue: string }>;
  /** Whether this adapter can handle a refresh-poll for the given event kind. */
  canRefreshPoll?(eventKind: EventKind): boolean;
}
