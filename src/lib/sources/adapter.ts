// SourceAdapter - the per-source interface implementations register
// against the registry.
//
// Surface includes:
//   - parseUrl(url) - per-adapter URL detection (first-match-wins).
//   - observability - per-adapter quota/audit/auth API for /admin/quota tabs.
//   - registerQueues / scheduleCronTicks / backfillSource - adapter owns its
//     queue topology and cron schedules (per-kind queues).
//   - refreshQueue - optional Refresh Now capability for pollable event kinds.
//
// AdapterContext is defined here because parseUrl-iteration callers and
// backfillSource consume it directly.

import type { dataSources, events } from "$lib/server/db/schema/index.js";
import type { DbOrTx, Tx } from "$lib/server/db/client.js";
import type { EventDto } from "$lib/server/dto.js";
import type { Hono } from "hono";

export type DataSourceRow = typeof dataSources.$inferSelect;
export type EventRow = typeof events.$inferSelect;

export type SourceKind =
  | "youtube_channel"
  | "reddit_account"
  | "reddit_subreddit"
  | "twitter_account"
  | "telegram_channel"
  | "discord_server"
  | "instagram_account";

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
  | "post"
  | "instagram_post";

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
 *  picking + rate-limit budget split happen inside the adapter. Consumed by
 *  parseUrl-iterators and backfillSource; the v0.1 poll methods still take
 *  PickedKey directly. */
export interface AdapterContext {
  userId: string | null;
  origin: "cron" | "user";
  /** Optional transaction handle for adapter-owned durable enqueue paths. */
  tx?: DbOrTx;
  /** How the playlist walker decides when to stop.
   *  - "depth" (default): items with publishedAt <= since are dropped AND
   *    end the walk. Use for deep walks where `since` is the historical floor
   *    (e.g. user widened backfill_target_since to epoch - walker stops at
   *    epoch via endOfPlaylist, or at 30d-ago when since=30d-ago).
   *  - "overlap": items are NOT dropped by publishedAt alone. Walker stops
   *    after K consecutive items that are BOTH already in the youtube_videos
   *    cache AND have publishedAt <= since. Use for incremental walks
   *    (channel previously walked; we just want what's new). Backdated
   *    uploads with publishedAt below newestKnown but NOT yet in cache
   *    survive - they get collected because cache-miss means "we have not
   *    seen this video before". */
  walkStop?: "depth" | "overlap";
}

/**
 * PickedKey - YouTube operator key selected by a DB quota reservation or
 * explicit quota helper. Batched videos.list calls receive this object from
 * their caller so the key used for HTTP matches the apiKeyId recorded in
 * youtube_service_quota_usage.
 */
export interface PickedKey {
  apiKey: string;
  apiKeyId: string;
}

/** Per-adapter URL detection result - first-match-wins iteration. */
export interface ParsedUrl {
  kind: EventKind;
  externalId: string;
  metadata?: Record<string, unknown>;
}

/** Per-adapter source-URL detection result - drives /sources/new auto-detect
 *  for adapters where one input shape maps to multiple SourceKinds.
 *  Reddit: `reddit.com/user/X` -> reddit_account; `reddit.com/r/X` -> reddit_subreddit.
 *  Implemented optionally - YouTube cross-source flow uses `canonicalizeOnCreate`
 *  (synchronous + per-URL canonicalization) instead. */
export interface ParsedSourceUrl {
  kind: SourceKind;
  handle: string;
  externalUrl: string;
}

export interface ObservabilityAuth {
  kind:
    | "operator-static-key"
    | "operator-oauth-app-only"
    | "scrape"
    | "operator-oauth-with-user-override"
    | "public-json-no-auth";
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
   * NOT recompute throttleState - they trust the adapter's classification.
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

/** Per-adapter quota counter declaration - adapters expose their per-user
 *  rolling quotas (e.g. youtube_metadata_fetches_per_day) so cross-source
 *  services/quota.ts iterates `allAdapters[*].observability.quotaCounters`
 *  instead of switching on a hard-coded list. New adapters declare their
 *  own counters; quota.ts code stays unchanged.
 *
 *  count() receives `dbCtx: DbOrTx` so it can be invoked under the per-user
 *  advisory lock inside withQuotaGuard's transaction (race-safe limit check).
 *  Counters that don't need in-tx semantics can ignore the parameter and
 *  query via the top-level `db` - but standard pattern is to pass `dbCtx`
 *  through so concurrent same-user requests serialize correctly. */
export interface AdapterQuotaCounter {
  /** Quota key - must match a key in services/quota.ts QUOTA_LIMITS. */
  kind: string;
  /** Count rows for `userId` since `since` (typically rolling 24h window).
   *  Uses `dbCtx` (db OR active tx) so the count joins the caller's
   *  advisory-lock'd transaction when invoked from withQuotaGuard. */
  count(dbCtx: DbOrTx, userId: string, since: Date): Promise<number>;
}

/** Per-user fair-share cap on operator's API budget. Both axes optional  -
 *  adapter declares either, both, neither, OR the Reddit two-axis shape.
 *  Capping prevents one user from monopolizing operator's shared API quota
 *  across all tenants.
 *
 *  - requestsPerDay - cap on API calls (YouTube; 24h rolling).
 *  - eventsPerDay - cap on user-INSERTed events (YouTube; 24h rolling).
 *
 *  Reddit (Phase 03.1, two-axis sliding window — DV-RDT-7):
 *  - sourceActionsPerWindow — register/refresh-source quota (default 5,
 *    v0.1 UAT recalibration; was 1 in the initial draft).
 *  - postRefreshesPerWindow — manual post refresh quota (default 30,
 *    v0.1 UAT recalibration; was 25).
 *  - windowMinutes — sliding-window length for source/post axes (default 15,
 *    v0.1 UAT recalibration; was 5). Authoritative value lives in
 *    src/lib/sources/reddit/server/quota.ts REDDIT_USER_CAP — both
 *    surfaces import from there so this jsdoc stays informational.
 *
 *  Counter source (Reddit): adapter_refresh_queue rows with
 *  adapter_kind='reddit_account' and user_id=$user in the last
 *  `windowMinutes`. Excluded: cron-driven entries
 *  (queue rows with user_id IS NULL). */
export interface AdapterUserQuotaCap {
  requestsPerDay?: number;
  eventsPerDay?: number;
  sourceActionsPerWindow?: number;
  postRefreshesPerWindow?: number;
  windowMinutes?: number;
}

export interface AdapterObservability {
  auth: ObservabilityAuth;
  quota: {
    getDailyStats(date: Date): Promise<ObservabilityDailyStats>;
    getRecentAudit(limit: number): Promise<ObservabilityAuditEntry[]>;
  };
  /** Per-adapter rolling-window quota counters.
   *  Cross-source services/quota.ts iterates these to compute current
   *  usage; new sources add their counters here, no quota.ts edit needed. */
  quotaCounters?: ReadonlyArray<AdapterQuotaCounter>;
  /** Per-user fair-share cap. When present, refresh-content / refresh-poll
   *  endpoints check usage SUM from audit_log before enqueue and 429 on
   *  exhaustion. When undefined, cap not enforced (usage still tracked in
   *  audit metadata for visibility but not denial). */
  userQuotaCap?: AdapterUserQuotaCap;
  /** Adapter-owned sliding-window quota implementation. Declare this when
   *  userQuotaCap.windowMinutes is set so the generic quota service does not
   *  import source-specific modules. */
  slidingWindowQuota?: {
    check(
      dbCtx: DbOrTx,
      userId: string,
      action: "source-action" | "post-refresh",
    ): Promise<{
      allowed: boolean;
      cap: number;
      used: number;
      window: string;
      resetInSeconds: number;
      errorCode: string;
      message: string;
      audit: {
        userId: string;
        axis: string;
        cap: number;
        used: number;
      };
    }>;
    writeExhaustedAudit(args: {
      userId: string;
      ipAddress: string;
      axis: string;
      cap: number;
      used: number;
    }): Promise<void>;
  };
  /**
   * Adapter declares that its whole runtime must be owned by one worker
   * replica. Use this only when some load-bearing state is still
   * process-local and cannot be protected by a DB claim gate or persistent
   * counter. Worker bootstrap uses a per-adapter session advisory lock so
   * unrelated adapters can still run in parallel.
   *
   * When false / omitted: adapter uses persistent counters or DB claim gates
   * for load-bearing limits, so parallel worker replicas can be clean-safe.
   */
  requiresSingletonRuntime?: boolean;
}

/** Backfill window options - accepted by createSource and threaded into
 *  onSourceCreated. Forward-compatible with future adapter-specific extensions
 *  (e.g. Reddit may add "this_subreddit_ever" - opt-in per-adapter). */
export type BackfillWindow = "1d" | "7d" | "30d" | "90d" | "1y" | "everything";

/** Result of canonicalizeOnCreate - the adapter's chance to:
 *  - Rewrite handle_url to its canonical form (e.g. /watch?v=XYZ -> /channel/UC...)
 *  - Resolve an external id (channel_id, account_id) at create time so the
 *    worker takes the fast path (no resolve quota burn on first backfill).
 *  - Surface a display name the adapter already fetched while resolving (e.g.
 *    Instagram resolveAccount returns full_name/username) so createSource
 *    persists it on data_sources.display_name instead of leaving the row
 *    showing the bare id. Omit / null when the adapter resolves the display
 *    name later on the worker (YouTube channel title).
 *
 *  Returns the input unchanged if no canonicalization applies. */
export interface CanonicalizeResult {
  canonicalHandleUrl: string;
  resolvedExternalId: string | null;
  /** Display name resolved at create time, when the adapter already has it.
   *  createSource uses it ONLY when the caller did not supply an explicit
   *  displayName (a user-typed name always wins). Omit / null → no change. */
  displayName?: string | null;
}

/** Input shape consumed by canonicalizeOnCreate. Mirrors the relevant slice
 *  of CreateSourceInput; adapters never touch tenant-scoped fields. */
export interface CanonicalizeInput {
  kind: SourceKind;
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

/** Local, no-upstream source input normalization before createSource's cheap
 *  duplicate/quota gates.
 *
 *  Use this for deterministic parsing/canonicalization that must happen
 *  before exact handle_url duplicate checks, such as Reddit's
 *  reddit.com/u/X -> https://www.reddit.com/user/X and metadata.username
 *  injection. This hook MUST NOT burn upstream API quota; use
 *  canonicalizeOnCreate for I/O-backed canonicalization such as resolving
 *  a YouTube video URL to its channel id. */
export interface NormalizeSourceInput {
  kind: SourceKind;
  handleUrl: string;
  channelId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface NormalizeSourceResult {
  handleUrl: string;
  channelId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Post-create hook payload - minimum set the YouTube context-backfill enqueue
 *  needs. Adapters that don't need this fields ignore them.
 *
 *  Includes channelId, backfillTargetSince, isOwnedByMe so adapters can
 *  implement zero-quota onboarding (bulk INSERT events for new subscriber
 *  from existing channel cache without making any HTTP calls). */
export interface SourceCreatedHookSource {
  id: string;
  userId: string;
  autoImport: boolean;
  handleUrl: string;
  metadata: Record<string, unknown>;
  kind: SourceKind;
  /** Resolved channel id (UCxxx for YouTube). NULL when canonicalize did
   *  not resolve a synchronous identifier (e.g., /@handle URLs defer
   *  resolution to the worker). Required for zero-quota onboarding. */
  channelId: string | null;
  /** Per-user backfill target boundary. Adapter filters cache rows
   *  >= this date when seeding events for the new subscriber. */
  backfillTargetSince: Date | null;
  /** Whether the new subscriber owns this channel - drives events.author_is_me
   *  on the seeded rows. Default true. */
  isOwnedByMe: boolean;
}

/** Discriminated result of fetchEventPreviewMetadata.
 *  Maps to the YouTube oEmbed result shape so the cross-source
 *  enrichFromUrl path is per-adapter without leaking YouTube-specific
 *  error vocab into other adapters' impl. */
export type EventPreviewMetadata =
  | {
      kind: "ok";
      title: string;
      authorName: string;
      authorUrl: string;
      occurredAt?: Date;
      thumbnailUrl?: string;
      html?: string;
    }
  | { kind: "private" }
  | { kind: "unavailable" }
  | { kind: "unreachable"; cause: string };

/** Chartable metric series for VIZ-01 (D-14 reference deliverable). The
 *  adapter declares WHICH metrics it exposes (YouTube → view/like/comment;
 *  Reddit → score/num_comments) and reads its own snapshot table by
 *  externalId. Public-data tables (youtube_video_snapshots /
 *  reddit_post_snapshots): NO userId scope in the query — the tenant
 *  guarantee comes from the caller's event SELECT, exactly as enrichFeedDtos
 *  documents. Adapters touching tenant tables MUST scope by userId.
 *  Returns [] when `event.kind` is not this adapter's kind (self-filtering;
 *  the caller does NOT pre-filter). points are ASC by polledAt. */
export interface EventMetricSeries {
  metricKey: string; // "view_count" | "like_count" | "comment_count" | "score" | "num_comments"
  labelKey: string; // Paraglide key handle for the legend, e.g. "chart_metric_views"
  // value is null when the snapshot's count was NULL — the metric was hidden or
  // unavailable at poll time (likes hidden, comments off, removed post). null is
  // a GAP on the chart (connectNulls:false), NEVER coerced to 0 (a false drop).
  points: { polledAt: string; value: number | null }[]; // ASC by polledAt
}

/** Live poll-state row consumed by dto.ts's per-event overlay (lastPolledAt /
 *  lastPollStatus rendering on /feed and /audit). Adapters that don't poll
 *  return an empty Map - the cross-source code merges per-adapter results. */
export interface AdapterPollState {
  publishedAt: Date | null;
  lastPolledAt: Date | null;
  lastPollStatus: string | null;
}

/** Hono app context type - re-exported here so adapter.registerRoutes can be
 *  typed without making cross-source code import server-internal types. */
export type AdapterAppContext = {
  Variables: {
    clientIp: string;
    clientProto: "http" | "https";
    userId?: string;
    sessionId?: string;
  };
};

/** Minimal pg-boss surface the adapter consumes - keeps the adapter decoupled
 *  from pg-boss major-version type drift. Widen if a new adapter needs more
 *  verbs. */
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
    options?: { singletonKey?: string; singletonSeconds?: number; priority?: number },
  ): Promise<string | null>;
  createQueue(name: string): Promise<unknown>;
}

export interface RefreshQueueCapability {
  canRefresh(eventKind: EventKind): boolean;
  /** Optional adapter-owned hard gate before enqueueing a user refresh.
   *  Use this only for platform envelopes that are load-bearing for the
   *  adapter (YouTube 95% daily hard stop). Dashboard-only observability
   *  signals must not be wired as write-path policy. */
  canRun?(ctx: SyncStatsGuardContext): Promise<AdapterCapabilityGuardResult>;
  enqueue(input: {
    eventId: string;
    userId: string;
    externalId: string;
    eventKind: EventKind;
    /** Optional transaction handle from the caller when enqueue must commit
     *  atomically with caller-owned state such as cooldown markers. SQL-backed
     *  queues write directly through it; pg-boss-backed adapters should use
     *  the transactional outbox from the same tx. */
    tx?: DbOrTx;
  }): Promise<{ queue: string; jobId: string | null }>;
}

export interface AdapterLaneQueueDeclaration<TLane extends string = string> {
  readonly strategy: "fixed-slot-round-robin";
  readonly adapterKind: SourceKind;
  readonly slots: readonly TLane[];
  readonly fallthrough: readonly TLane[];
  readonly batchScope?: "global" | "user";
}

export type AdapterScheduledWorkerReplicaPolicy = "singleton" | "parallel";

export interface AdapterScheduledWorker {
  readonly name: string;
  readonly intervalMs: number;
  readonly replicaPolicy: AdapterScheduledWorkerReplicaPolicy;
  readonly readyMessage: string;
  readonly disabledMessage: string;
  readonly laneQueue?: AdapterLaneQueueDeclaration;
  isEnabled(): boolean;
  tick(): Promise<unknown>;
}

export interface AdapterWorkQueueCapability {
  readonly scheduledWorkers: ReadonlyArray<AdapterScheduledWorker>;
}

export type AdapterCapabilityGuardResult =
  | { action: "run" }
  | {
      action: "skip";
      reason: string;
      retryAfterMs?: number;
      status?: number;
      code?: string;
      metadata?: Record<string, unknown>;
    };

export interface SyncStatsGuardContext {
  eventId?: string;
  externalId: string;
  userId: string;
  eventKind: EventKind;
  now: Date;
}

export interface BackfillSourceGuardContext {
  source: PollableSource;
  userId: string;
  origin: AdapterContext["origin"];
  now: Date;
}

export interface SyncStatsCapability {
  /** Optional adapter-owned guard for the sync fast path.
   *
   *  Cross-source callers run generic tenant/per-user gates, then ask the
   *  adapter whether this specific fast-path call may burn upstream quota.
   *  Use this for platform envelopes that are load-bearing for the adapter
   *  (YouTube 95% daily hard stop). Omit it when observability thresholds
   *  are dashboard-only signals (Reddit synthetic daily usage). */
  canRun?(ctx: SyncStatsGuardContext): Promise<AdapterCapabilityGuardResult>;
  fetch(
    externalId: string,
    ctx: { userId: string; ipAddress?: string },
  ): Promise<{
    viewCount: number;
    likeCount: number;
    commentCount: number;
    /** Optional per-adapter signal that the event's author matches one
     *  of the user's registered, owned sources. When set, createEvent
     *  UPDATEs events.author_is_me unless the caller passed an explicit
     *  value. Reddit: t3.author === reddit_account.metadata.username.
     *  YouTube: inheritance happens via enrichFromUrl's findActiveSourceByHandleUrl,
     *  NOT via this field - YouTube returns undefined here. */
    authorIsMe?: boolean;
  } | null>;
}

export interface SourceAdapter {
  readonly kind: SourceKind;
  parseUrl(url: string): ParsedUrl | null;
  /** Adapter-side source URL parsing. Cross-source `/sources/new` flow
   *  iterates `allAdapters[*].parseSourceUrl?.(input)` (first non-null wins)
   *  to auto-detect the SourceKind when one input shape maps to multiple
   *  kinds. YouTube doesn't need this (canonicalizeOnCreate handles its
   *  single SourceKind=youtube_channel case); Reddit needs it because
   *  reddit.com/user/X vs reddit.com/r/X resolve to different SourceKinds.
   *  Default (when undefined): SourceCreateService asks user to pick kind
   *  via /sources/new UI. */
  parseSourceUrl?(input: string): ParsedSourceUrl | null;
  readonly observability: AdapterObservability;
  registerQueues(boss: MinimalBoss): Promise<void>;
  scheduleCronTicks(boss: MinimalBoss): Promise<void>;
  backfillSource(
    source: PollableSource,
    ctx: AdapterContext,
  ): Promise<{ jobId: string | null; queue: string }>;
  /** Optional adapter-owned hard gate before enqueueing source backfill.
   *  Use this only for platform envelopes that are load-bearing for the
   *  adapter. Dashboard-only observability signals must not be wired as
   *  write-path policy. */
  canBackfillSource?(ctx: BackfillSourceGuardContext): Promise<AdapterCapabilityGuardResult>;
  /** Adapter-owned Refresh Now capability. The cross-source
   *  `requestRefreshPoll` service runs tenant/cooldown/quota gates and
   *  delegates the backend-specific enqueue here. Adapters that cannot
   *  refresh events omit the capability. */
  refreshQueue?: RefreshQueueCapability;
  /** Adapter-owned non-pg-boss worker loops. Use this for API calls where
   *  the dequeue order itself is part of the quota contract (for example
   *  Reddit's fixed 8-slot/min lane schedule). Generic worker bootstrap
   *  starts each declared loop and owns shutdown; the adapter owns the
   *  queue table, lane policy, and tick implementation. */
  workQueue?: AdapterWorkQueueCapability;

  /**
   * Reconcile in-process runtime state with persistent counters BEFORE the
   * worker processes any jobs. Called once at worker bootstrap, before
   * queue handlers are registered, so pg-boss cannot dispatch jobs with
   * stale runtime state.
   *
   * When to declare: adapters that maintain process-local load-bearing
   * state and can reconstruct it from persistent counters at boot.
   *
   * When to omit: adapters using only persistent state or DB-backed claim
   * gates. Restart loses no state.
   *
   * Best-effort contract: errors are logged-and-continued by the bootstrap
   * caller. A failed reconciliation MUST NOT block worker boot.
   */
  reconcileRuntimeState?(): Promise<void>;

  /** Create-time adapter hooks. Cross-source createSource
   *  (services/data-sources.ts) calls these so per-source URL canonicalization
   *  + auto-import init don't live in the cross-source code. */

  /** Pure/cheap source input normalization before duplicate/quota prechecks.
   *  Must not perform upstream I/O. */
  normalizeSourceOnCreate?(
    input: NormalizeSourceInput,
    ctx: CreateContext,
  ): Promise<NormalizeSourceResult>;

  /** Resolve handle_url to canonical form + extract external id, if applicable.
   *  YouTube: parse `/watch?v=...` / `/channel/UC...` / `@handle` URLs; for video
   *  URLs dereference the channel via fetchVideoMetadataByUrl.
   *  Default (when not implemented): cross-source code passes input through. */
  canonicalizeOnCreate?(input: CanonicalizeInput, ctx: CreateContext): Promise<CanonicalizeResult>;

  /** Post-create side effects (auto-import init, prerequisite cache warming).
   *  Runs inside the createSource transaction. Use the provided tx for DB
   *  writes and enqueue durable jobs through the shared outbox. Default
   *  (when not implemented): no-op. */
  onSourceCreated?(
    source: SourceCreatedHookSource,
    opts: { backfillWindow: BackfillWindow; tx: Tx },
  ): Promise<void>;

  /** Hook fired by `updateSource` when the user widens `backfillTargetSince`
   *  past the prior value (e.g. "30 days" → "everything"). Adapters with
   *  walker state — be it per-user (YouTube channel state) or cross-tenant
   *  (Reddit cache rows) — reset their pagination cursor and re-enqueue
   *  whatever they need to deepen the walk.
   *
   *  Cross-source code knows nothing about how each adapter persists its
   *  walker state: it just calls this hook on the right registry adapter
   *  whenever a widen is detected. Adapters without walker state (no-op
   *  default).
   *
   *  Runs inside the updateSource transaction. Failures bubble up — the
   *  PATCH on data_sources rolls back too, so the user can retry without
   *  inconsistent state. Use the supplied `tx` for DB writes; enqueue
   *  durable jobs through the shared outbox if the adapter is pg-boss-
   *  backed. */
  resetWalkerStateOnWidening?(
    source: SourceCreatedHookSource,
    ctx: {
      previousTarget: Date | null;
      newTarget: Date;
      triggerUserId: string;
      ipAddress: string;
      tx: Tx;
    },
  ): Promise<void>;

  /** Adapter-driven event preview (POST /api/events/preview-url + ingest
   *  paste flow). After URL is parsed + routed, the adapter is asked
   *  to fetch a friendly preview (title / authorName / authorUrl).
   *
   *  `ctx.userId` is the authenticated viewer (cross-source layer always
   *  has it - both call paths are mounted under tenantScope). Adapters
   *  whose preview burns a rate-limited unit (Reddit's /api/info.json)
   *  use it to enforce per-user caps and write the cap-counter row;
   *  adapters whose preview is a cheap oEmbed (YouTube) accept it but
   *  ignore it. The optional shape lets older adapters land before they
   *  thread the field through their implementations.
   *
   *  YouTube: fetchYoutubeOembed wrapper. */
  fetchEventPreviewMetadata?(
    canonicalUrl: string,
    ctx: { userId: string; ipAddress: string },
  ): Promise<EventPreviewMetadata>;

  /** Explicit sync stats capability for manual event paste.
   *
   *  This is the allowed fast path: the caller runs quota gates before
   *  invoking it, and the adapter implementation must write the same
   *  snapshot/audit/accounting rows the queued path would. Adapters that
   *  cannot or should not do sync upstream work omit the capability. */
  syncStats?: SyncStatsCapability;

  /** Per-adapter event-input validation. Cross-source createEvent /
   *  updateEvent calls this when the merged event.kind matches this
   *  adapter's source kind (via eventKindToSourceKind). YouTube: require
   *  URL parseable as youtube_video. Throws AppError on invalid input. */
  validateEventInput?(input: { kind: string; url?: string | null }): void;

  /** Batch lookup of live poll-state for events of this adapter's kinds.
   *  dto.ts's overlayPollStateOnEvents iterates allAdapters and merges
   *  results. YouTube: SELECT publishedAt/lastPolledAt/lastPollStatus
   *  from youtube_videos by externalId IN (...). */
  fetchPollStateMap?(
    userId: string,
    externalIds: readonly string[],
  ): Promise<Map<string, AdapterPollState>>;

  /** Per-event chartable metric series for VIZ-01 (D-14 reference pattern).
   *  Same optional/self-filtering contract as enrichFeedDtos: the adapter
   *  filters internally to its own kind(s) — the caller (the /events/[id]
   *  loader iterating allAdapters) does NOT pre-filter. Returns [] when
   *  event.kind isn't this adapter's kind. Reads the immutable *_snapshots
   *  history ORDER BY polled_at ASC (POLL-04), never a mutable
   *  current-value column. `labelKey` references the m.chart_metric_* keys. */
  fetchEventMetricSeries?(
    userId: string,
    event: { kind: EventKind; externalId: string | null },
  ): Promise<EventMetricSeries[]>;

  /** Adapter-owned HTTP routes. Called once at app boot by createApp();
   *  the adapter mounts its routes on the shared Hono instance. YouTube:
   *  mounts /api/youtube/fetch-metadata (preview button on /events/new).
   *  Synchronous mount per Hono's contract. */
  registerRoutes?(app: Hono<AdapterAppContext>): void;

  /**
   * Enrich the supplied feed DTOs in-place with adapter-specific data
   * (stats, channel/author metadata, anything that lives in per-kind
   * metadata tables and renders on FeedCard).
   *
   * Cross-source callsites (/feed loader, GET /api/events, /games/[id])
   * iterate allAdapters and call this method per adapter. The adapter
   * MUST filter internally to its own kind(s) - callers do NOT pre-filter
   * (avoids the "did I forget to filter for adapter X?" footgun).
   *
   * Mutates `dtos` in place; returns void. Errors are swallowed by the
   * adapter (logged at WARN); a failed enrichment query MUST NOT break
   * the feed render - the cards just render without the enrichment.
   *
   * Future adapters (Reddit / Twitter / Telegram / Discord) implement this
   * against their own metadata tables. Adapters that have no enrichment
   * can omit the method entirely (optional via `?:`); the caller's
   * `if (adapter.enrichFeedDtos)` gate skips undefined methods.
   *
   * Deliberately NOT called from GET /api/events/deleted - DeletedEventsPanel
   * renders a compact KindIcon + strikethrough-title view that needs none
   * of the enrichment data. See events.ts for the load-bearing skip comment.
   */
  enrichFeedDtos?(userId: string, dtos: EventDto[]): Promise<void>;
}
