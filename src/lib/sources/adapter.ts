// DataSourceAdapter — the per-source interface implementations register
// against the registry.
//
// Surface includes:
//   - parseUrl(url) — per-adapter URL detection (first-match-wins).
//   - observability — per-adapter quota/audit/auth API for /admin/quota tabs.
//   - registerQueues / scheduleCronTicks / backfillSource — adapter owns its
//     queue topology and cron schedules (per-kind queues).
//   - canRefreshPoll — optional dispatch hint for the generic
//     POST /api/sources/:id/refresh-content endpoint.
//
// The v0.1 adapter methods (pollContent / pollStats / pollStatsByVideoId)
// keep legacy `PickedKey` + `quotaUser` signatures because callers
// (poll-active / poll-cold / poll-user / rehab-unavailable) still thread
// a pre-resolved key down for the `youtube_service_quota_usage` row keyed
// under the same apiKeyId the adapter burned (load-bearing with N≥2 keys).
// Moving picking INSIDE the adapter requires either returning apiKeyId
// on every StatsSnapshot or threading ctx into pickCredentials — both
// are non-trivial behavioral changes deferred until the supporting
// infrastructure is in place.
//
// AdapterContext is defined here because parseUrl-iteration callers and
// backfillSource consume it directly; the legacy methods don't take it yet.

import type { dataSources, events } from "$lib/server/db/schema/index.js";
import type { DbOrTx } from "$lib/server/db/client.js";
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
 *  picking + rate-limit budget split happen inside the adapter. Consumed by
 *  parseUrl-iterators and backfillSource; the v0.1 poll methods still take
 *  PickedKey directly. */
export interface AdapterContext {
  userId: string | null;
  origin: "cron" | "user";
  /** How the playlist walker decides when to stop.
   *  - "depth" (default): items with publishedAt <= since are dropped AND
   *    end the walk. Use for deep walks where `since` is the historical floor
   *    (e.g. user widened backfill_target_since to epoch — walker stops at
   *    epoch via endOfPlaylist, or at 30d-ago when since=30d-ago).
   *  - "overlap": items are NOT dropped by publishedAt alone. Walker stops
   *    after K consecutive items that are BOTH already in the youtube_videos
   *    cache AND have publishedAt <= since. Use for incremental walks
   *    (channel previously walked; we just want what's new). Backdated
   *    uploads with publishedAt below newestKnown but NOT yet in cache
   *    survive — they get collected because cache-miss means "we have not
   *    seen this video before". */
  walkStop?: "depth" | "overlap";
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
 */
export interface PickedKey {
  apiKey: string;
  apiKeyId: string;
}

/** Per-adapter URL detection result — first-match-wins iteration. */
export interface ParsedUrl {
  kind: EventKind;
  externalId: string;
  metadata?: Record<string, unknown>;
}

/** Per-adapter source-URL detection result — drives /sources/new auto-detect
 *  for adapters where one input shape maps to multiple SourceKinds.
 *  Reddit: `reddit.com/user/X` → reddit_account; `reddit.com/r/X` → reddit_subreddit.
 *  Implemented optionally — YouTube cross-source flow uses `canonicalizeOnCreate`
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
 *  instead of switching on a hard-coded list. New adapters declare their
 *  own counters; quota.ts code stays unchanged.
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
 *  adapter declares either, both, neither, OR the Reddit two-axis shape.
 *  Capping prevents one user from monopolizing operator's shared API quota
 *  across all tenants.
 *
 *  - requestsPerDay — cap on API calls (YouTube; 24h rolling).
 *  - eventsPerDay — cap on user-INSERTed events (YouTube; 24h rolling).
 *
 *  Reddit (Phase 03.1, two-axis sliding window — DV-RDT-7):
 *  - sourceActionsPerWindow — register/refresh-source quota (default 1).
 *  - postRefreshesPerWindow — manual post refresh quota (default 25).
 *  - windowMinutes — sliding-window length for source/post axes (default 5).
 *
 *  Counter source (Reddit): COUNT(audit_log) with metadata.flow=`source.refresh_content_requested`
 *  for sourceActionsPerWindow; INSERT into `reddit_refresh_queue` with `user_id=$user`
 *  rows in last `windowMinutes` for postRefreshesPerWindow. Excluded: cron-driven entries
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
   *  exhaustion. When undefined, cap not enforced (usage still tracked в
   *  audit metadata для visibility но не denial). */
  userQuotaCap?: AdapterUserQuotaCap;
  /**
   * Adapter declares whether it maintains in-process rate-limit state
   * (e.g., RateLimiterMemory reservoirs that lose state on worker
   * restart). Worker bootstrap iterates and refuses to start with
   * WORKER_REPLICA_COUNT > 1 if ANY adapter sets this true, because
   * per-process reservoirs would each hold independent budgets →
   * N × envelope burn → quota overshoot. Making the property
   * adapter-declared lets the generic worker bootstrap accumulate
   * offending adapters and surface a truthful error message when
   * N>1 platforms ship in-process state.
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
   *  ≥ this date when seeding events for the new subscriber. */
  backfillTargetSince: Date | null;
  /** Whether the new subscriber owns this channel — drives events.author_is_me
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
   *     cap counter. Estimating via `ceil(events/page_size)` would
   *     under-count multi-page walks.
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
   * v0.1 surface: caller threads PickedKey down. Credential picking may
   * later move INSIDE the adapter (thick-adapter direction).
   */
  pollContent(
    source: PollableSource,
    since: Date,
    ctx?: { origin?: "cron" | "user"; walkStop?: "depth" | "overlap" },
  ): Promise<{
    events: RawEvent[];
    unitsUsed: number;
    /**
     * Optional resume cursor. Adapter that paginates internally MAY return a
     * nextPageToken so the next pollContent call resumes from the saved
     * position. Worker persists in source.metadata.lastBackfillPageToken
     * and threads back through PollableSource.metadata on the next call.
     * Undefined means «no resume needed» (single-page adapters or
     * end-of-playlist reached).
     */
    nextPageToken?: string;
    /**
     * Adapter signaled the underlying source has no more older content
     * (e.g., walked off end of YouTube uploads playlist). Worker uses
     * this to set backfill_complete=true regardless of «walked past
     * since» heuristics.
     */
    endOfPlaylist?: boolean;
  }>;
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
  /** Widened-contract surface. */
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

  /** Create-time adapter hooks. Cross-source createSource
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

  /** Adapter-driven event preview (POST /api/events/preview-url + ingest
   *  paste flow). After URL is parsed + routed, the adapter is asked
   *  to fetch a friendly preview (title / authorName / authorUrl).
   *
   *  `ctx.userId` is the authenticated viewer (cross-source layer always
   *  has it — both call paths are mounted under tenantScope). Adapters
   *  whose preview burns a rate-limited unit (Reddit's /comments/<id>.json)
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

  /** Sync stats fetch on manual event paste.
   *
   *  After createEventFromPaste creates the events row from oEmbed data
   *  (title only, no stats), this method is called to fetch view/like/
   *  comment counts via videos.list and write a snapshot row. UI's /feed
   *  loader JOINs youtube_video_snapshots so the user sees stats
   *  immediately after paste — no «click Refresh now» round-trip required.
   *
   *  Cost: 1 quota unit (charged to user pool via chargedFetch with
   *  origin='user'). Cache-aware via youtube_video_snapshots
   *  on-conflict-do-nothing (per-minute uniqueness). Errors swallowed by
   *  caller — paste is the load-bearing path, stats are nice-to-have.
   *
   *  Returns null on rate-limited / auth-error / not-found — caller
   *  treats as «stats unavailable, will be polled later». */
  fetchEventStats?(
    externalId: string,
    ctx: { userId: string },
  ): Promise<{
    viewCount: number;
    likeCount: number;
    commentCount: number;
    /** Optional per-adapter signal that the event's author matches one
     *  of the user's registered, owned sources. When set, createEvent
     *  UPDATEs events.author_is_me unless the caller passed an explicit
     *  value. Reddit: t3.author === reddit_account.metadata.username.
     *  YouTube: inheritance happens via enrichFromUrl's findActiveSourceByHandleUrl,
     *  NOT via this field — YouTube returns undefined here. */
    authorIsMe?: boolean;
  } | null>;

  /** Adapter-driven Refresh-Now enqueue. The cross-source
   *  `requestRefreshPoll` service runs the validation / cooldown / cap
   *  gates uniformly, then asks the adapter to actually enqueue the
   *  refresh job. YouTube: pg-boss send to YOUTUBE_POLL_USER. Reddit:
   *  INSERT a user_post row into reddit_refresh_queue. Future adapters
   *  implement whatever shape fits their backend. */
  enqueueRefreshPoll?(input: {
    eventId: string;
    userId: string;
    externalId: string;
    eventKind: EventKind;
  }): Promise<void>;

  /** Per-adapter event-input validation. Cross-source createEvent /
   *  updateEvent calls this when the merged event.kind matches this
   *  adapter's source kind (via eventKindToSourceKind). YouTube: require
   *  URL parseable as youtube_video. Throws AppError on invalid input. */
  validateEventInput?(input: { kind: string; url?: string | null }): void;

  /** Batch lookup of live poll-state for events of this adapter's kinds.
   *  dto.ts's overlayPollStateOnEvents iterates allAdapters and merges
   *  results. YouTube: SELECT publishedAt/lastPolledAt/lastPollStatus
   *  from youtube_videos by externalId IN (…). */
  fetchPollStateMap?(
    userId: string,
    externalIds: readonly string[],
  ): Promise<Map<string, AdapterPollState>>;

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
   * MUST filter internally to its own kind(s) — callers do NOT pre-filter
   * (avoids the "did I forget to filter for adapter X?" footgun).
   *
   * Mutates `dtos` in place; returns void. Errors are swallowed by the
   * adapter (logged at WARN); a failed enrichment query MUST NOT break
   * the feed render — the cards just render without the enrichment.
   *
   * Future adapters (Reddit / Twitter / Telegram / Discord) implement this
   * against their own metadata tables. Adapters that have no enrichment
   * can omit the method entirely (optional via `?:`); the caller's
   * `if (adapter.enrichFeedDtos)` gate skips undefined methods.
   *
   * Deliberately NOT called from GET /api/events/deleted — DeletedEventsPanel
   * renders a compact KindIcon + strikethrough-title view that needs none
   * of the enrichment data. See events.ts for the load-bearing skip comment.
   */
  enrichFeedDtos?(userId: string, dtos: EventDto[]): Promise<void>;
}
