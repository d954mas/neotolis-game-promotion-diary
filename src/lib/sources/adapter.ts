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
import type { DbOrTx } from "$lib/server/db/client.js";
import type { Hono } from "hono";

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
  /**
   * Per-key breakdown. `throttleState` is computed by the adapter using its
   * own internal thresholds (YouTube: 80%/95% of 10 000 daily; future Reddit
   * may use rolling-window thresholds). Consumers (admin /admin/quota) must
   * NOT recompute throttleState — they trust the adapter's classification.
   */
  keys?: Array<{
    apiKeyId: string;
    unitsUsed: number;
    throttleState: "ok" | "eighty" | "ninetyfive";
  }>;
  costEstimateUsd?: number;
}

export interface ObservabilityAuditEntry {
  action: string;
  occurredAt: Date;
  metadata: Record<string, unknown>;
}

/** Per-adapter quota counter declaration — adapters expose their per-user
 *  rolling quotas (e.g. youtube_metadata_fetches_per_day) so cross-source
 *  services/quota.ts iterates `allAdapters[*].observability.quotaCounters`
 *  instead of switching on a hard-coded list. Phase 03.1+ Reddit adapter
 *  declares its own counters; quota.ts code stays unchanged.
 *
 *  count() receives `dbCtx: DbOrTx` so it can be invoked under the per-user
 *  advisory lock inside withQuotaGuard's transaction (race-safe limit check).
 *  Counters that don't need in-tx semantics can ignore the parameter and
 *  query via the top-level `db` — but standard pattern is to pass `dbCtx`
 *  through so concurrent same-user requests serialize correctly. */
export interface AdapterQuotaCounter {
  /** Quota key — must match a key in services/quota.ts QUOTA_LIMITS. */
  kind: string;
  /** Count rows for `userId` since `since` (typically rolling 24h window).
   *  Uses `dbCtx` (db OR active tx) so the count joins the caller's
   *  advisory-lock'd transaction when invoked from withQuotaGuard. */
  count(dbCtx: DbOrTx, userId: string, since: Date): Promise<number>;
}

/** Per-user fair-share cap on operator's API budget. Both axes optional —
 *  adapter declares either, both, or neither. Capping prevents one user
 *  from monopolizing operator's shared API quota across all tenants.
 *
 *  - requestsPerDay — cap on API calls (quota units). Hits when one user
 *    has consumed their daily share of operator's API budget. Self-host
 *    operator typically not capped (1 user); SaaS hosted instance caps
 *    so other users get predictable share.
 *
 *  - eventsPerDay — cap on events INSERTed via user-initiated actions.
 *    Optional secondary cap для platforms with high events-per-request
 *    variance (Twitter pagination 1-100/req). YouTube has fixed 50:1
 *    ratio so requestsPerDay alone suffices; eventsPerDay omitted.
 *
 *  Counter source: audit_log SUM with metadata.{requests_used, events_inserted}.
 *  Cap kinds: 'incremental' | 'historical' | 'stats_refresh'. Excluded:
 *  'initial' (onboarding UX) and 'auto_passive' (cron pool, not user pool). */
export interface AdapterUserQuotaCap {
  requestsPerDay?: number;
  eventsPerDay?: number;
}

export interface AdapterObservability {
  auth: ObservabilityAuth;
  quota: {
    getDailyStats(date: Date): Promise<ObservabilityDailyStats>;
    getRecentAudit(limit: number): Promise<ObservabilityAuditEntry[]>;
  };
  /** Per-adapter rolling-window quota counters (Phase 03.0.1 D-19).
   *  Cross-source services/quota.ts iterates these to compute current
   *  usage; new sources add their counters here, no quota.ts edit needed. */
  quotaCounters?: ReadonlyArray<AdapterQuotaCounter>;
  /** Per-user fair-share cap. When present, refresh-content / refresh-poll
   *  endpoints check usage SUM from audit_log before enqueue and 429 on
   *  exhaustion. When undefined, cap not enforced (usage still tracked в
   *  audit metadata для visibility но не denial). */
  userQuotaCap?: AdapterUserQuotaCap;
  /**
   * Phase 03.0.1 (post-review) — adapter declares whether it maintains
   * in-process rate-limit state (e.g., RateLimiterMemory reservoirs that
   * lose state on worker restart). Worker bootstrap iterates and refuses
   * to start with WORKER_REPLICA_COUNT > 1 if ANY adapter sets this true,
   * because per-process reservoirs would each hold independent budgets →
   * N × envelope burn → quota overshoot. Pre-fix the assertion hardcoded
   * the YouTube migration message; making it adapter-declared lets the
   * generic worker bootstrap accumulate offending adapters and surface a
   * truthful error message when N>1 platforms ship in-process state.
   *
   * When false / omitted: adapter uses persistent counters only
   * (RateLimiterPostgres, DB-backed) — replica scaling is safe.
   */
  usesInProcessRateLimiter?: boolean;
}

/** Backfill window options — accepted by createSource and threaded into
 *  onSourceCreated. Forward-compatible with future adapter-specific extensions
 *  (e.g. Reddit may add "this_subreddit_ever" — opt-in per-adapter). */
export type BackfillWindow = "1d" | "7d" | "30d" | "90d" | "1y" | "everything";

/** Result of canonicalizeOnCreate — the adapter's chance to:
 *  - Rewrite handle_url to its canonical form (e.g. /watch?v=XYZ → /channel/UC…)
 *  - Resolve an external id (channel_id, account_id) at create time so the
 *    worker takes the fast path (no resolve quota burn on first backfill).
 *
 *  Returns the input unchanged if no canonicalization applies. */
export interface CanonicalizeResult {
  canonicalHandleUrl: string;
  resolvedExternalId: string | null;
}

/** Input shape consumed by canonicalizeOnCreate. Mirrors the relevant slice
 *  of CreateSourceInput; adapters never touch tenant-scoped fields. */
export interface CanonicalizeInput {
  handleUrl: string;
  channelId?: string | null;
}

/** Context for create-time adapter hooks (canonicalizeOnCreate, validateEventInput).
 *  Threads tenant + audit-trail context for adapters that need to write
 *  observability rows (e.g. metadata-fetch-log on YouTube canonicalize). */
export interface CreateContext {
  userId: string;
  ipAddress: string;
}

/** Post-create hook payload — minimum set the YouTube context-backfill enqueue
 *  needs. Adapters that don't need this fields ignore them. */
export interface SourceCreatedHookSource {
  id: string;
  userId: string;
  autoImport: boolean;
  handleUrl: string;
  metadata: Record<string, unknown>;
  kind: SourceKind;
}

/** Discriminated result of fetchEventPreviewMetadata — Phase 03.0.1 D-20.
 *  Maps to the legacy YouTube oEmbed result shape (events.ts:559-568) so
 *  the cross-source enrichFromUrl path is per-adapter without leaking
 *  YouTube-specific error vocab into other adapters' impl. */
export type EventPreviewMetadata =
  | {
      kind: "ok";
      title: string;
      authorName: string;
      authorUrl: string;
      thumbnailUrl?: string;
      html?: string;
    }
  | { kind: "private" }
  | { kind: "unavailable" }
  | { kind: "unreachable"; cause: string };

/** Live poll-state row consumed by dto.ts's per-event overlay (lastPolledAt /
 *  lastPollStatus rendering on /feed and /audit). Adapters that don't poll
 *  return an empty Map — the cross-source code merges per-adapter results. */
export interface AdapterPollState {
  publishedAt: Date | null;
  lastPolledAt: Date | null;
  lastPollStatus: string | null;
}

/** Hono app context type — re-exported here so adapter.registerRoutes can be
 *  typed without making cross-source code import server-internal types. */
export type AdapterAppContext = {
  Variables: {
    clientIp: string;
    clientProto: "http" | "https";
    userId?: string;
    sessionId?: string;
  };
};

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
  /**
   * Pull events newer than `since` from the upstream platform.
   *
   * Returns:
   *   - `events`: RawEvent[] — items pulled. Empty array means platform
   *     CONFIRMED no events newer than `since` (worker marks
   *     backfill_complete=true). NEVER return `[]` for inability-to-fetch
   *     — that mis-signals «no more events». Use throw instead.
   *   - `unitsUsed`: exact upstream HTTP request count made by the adapter
   *     (1 per chargedFetch call for YouTube; varies per platform). Worker
   *     writes this to audit_log.metadata.requests_used for the per-user
   *     cap counter. Pre-Phase-03.0.1 the worker estimated via
   *     `ceil(events/page_size)` which under-counted multi-page walks.
   *
   * Throws `AdapterError` when the adapter could NOT determine the answer
   * (rate-limit, network failure, parse error, auth-issue). Worker leaves
   * backfill_complete unchanged; pg-boss retries.
   *
   * Empty-vs-throws contract:
   *   YouTube / Reddit / Twitter satisfy this naturally — their listing
   *   endpoints return distinct `{items: []}` vs HTTP 4xx/5xx. Scrape-based
   *   platforms (Telegram, Discord) where empty page can't be distinguished
   *   from rate-limit failure may need a richer return type — see
   *   SOURCE-REFERENCE.md §8 for the proposed `hasMore` extension.
   *
   * v0.1 surface — preserved verbatim from legacy data-source-adapter.ts.
   * Plan 04/08 will move credential picking INSIDE the adapter (D-06 Thick
   * scope); until then the caller threads PickedKey down.
   */
  pollContent(
    source: PollableSource,
    since: Date,
  ): Promise<{ events: RawEvent[]; unitsUsed: number }>;
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

  /**
   * Reconcile in-process runtime state with persistent counters BEFORE the
   * worker processes any jobs. Called once at worker bootstrap, after queue
   * registration but before pg-boss starts dispatching.
   *
   * When to declare: adapters that maintain in-process rate-limit reservoirs
   * (e.g., RateLimiterMemory) lose state on worker restart. Without
   * reconciliation, a worker that crashed at 7000/8000 cron units re-starts
   * with a fresh 8000-unit pool and overshoots before the next throttle
   * threshold catches up.
   *
   * When to omit: adapters using only persistent state (RateLimiterPostgres,
   * DB-backed counters) — restart loses no state.
   *
   * Best-effort contract: errors are logged-and-continued by the bootstrap
   * caller. A failed reconciliation MUST NOT block worker boot.
   */
  reconcileRuntimeState?(): Promise<void>;

  /** Phase 03.0.1 D-18 — create-time adapter hooks. Cross-source createSource
   *  (services/data-sources.ts) calls these so per-source URL canonicalization
   *  + auto-import init don't live in the cross-source code. */

  /** Resolve handle_url to canonical form + extract external id, if applicable.
   *  YouTube: parse `/watch?v=…` / `/channel/UC…` / `@handle` URLs; for video
   *  URLs dereference the channel via fetchVideoMetadataByUrl.
   *  Default (when not implemented): cross-source code passes input through. */
  canonicalizeOnCreate?(input: CanonicalizeInput, ctx: CreateContext): Promise<CanonicalizeResult>;

  /** Post-create side effects (auto-import init, prerequisite cache warming).
   *  YouTube: enqueue YOUTUBE_CHANNEL_CONTEXT_BACKFILL when autoImport=true.
   *  Default (when not implemented): no-op. Failures logged at WARN by the
   *  adapter; never throw — fire-and-forget, the source row is the load-bearing
   *  return value. */
  onSourceCreated?(
    source: SourceCreatedHookSource,
    opts: { backfillWindow: BackfillWindow },
  ): Promise<void>;

  /** Phase 03.0.1 D-20 — adapter-driven event preview (POST /api/events/preview-url
   *  + ingest paste flow). After URL is parsed + routed, the adapter is asked
   *  to fetch a friendly preview (title / authorName / authorUrl).
   *  YouTube: fetchYoutubeOembed wrapper. */
  fetchEventPreviewMetadata?(canonicalUrl: string): Promise<EventPreviewMetadata>;

  /** Phase 03.0.1 D-21 — per-adapter event-input validation. Cross-source
   *  createEvent / updateEvent calls this when the merged event.kind matches
   *  this adapter's source kind (via eventKindToSourceKind). YouTube: require
   *  URL parseable as youtube_video. Throws AppError on invalid input. */
  validateEventInput?(input: { kind: string; url?: string | null }): void;

  /** Phase 03.0.1 D-22 — batch lookup of live poll-state for events of this
   *  adapter's kinds. dto.ts's overlayPollStateOnEvents iterates allAdapters
   *  and merges results. YouTube: SELECT publishedAt/lastPolledAt/lastPollStatus
   *  from youtube_videos by externalId IN (…). */
  fetchPollStateMap?(
    userId: string,
    externalIds: readonly string[],
  ): Promise<Map<string, AdapterPollState>>;

  /** Phase 03.0.1 D-23 — adapter-owned HTTP routes. Called once at app boot
   *  by createApp(); the adapter mounts its routes on the shared Hono
   *  instance. YouTube: mounts /api/youtube/fetch-metadata (preview button on
   *  /events/new). Synchronous mount per Hono's contract. */
  registerRoutes?(app: Hono<AdapterAppContext>): void;
}
