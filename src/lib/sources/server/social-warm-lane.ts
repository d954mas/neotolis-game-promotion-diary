// Shared warm/refresh-lane machinery for the PAID social scrapers (Instagram +
// TikTok today; ScrapeCreators prepaid credits). This is MONEY-PATH code: the
// goal is ONE source of truth with byte-identical BEHAVIOR per platform.
//
// Before this module the IG and TikTok warm lanes were a ~1000-line, comment-for-
// comment clone (each tiktok file self-labelled "clone of instagram/..."). The
// normalized diff (platform names / env prefixes / the cosmetic post_id-vs-aweme_id
// variable spelling sed'd out) showed the executable code was identical except for
// ONE real behavioral delta: TikTok threads `shares` (PLAT-02) through its snapshot
// write; IG's single-post endpoint exposes no share field. That delta lives in the
// per-platform `writeSnapshot` config callback below; everything else is shared.
//
// FOUR composable factories, each replacing one clone pair/quad:
//   1. createWarmEligibilitySelector  — the YOUNG-AND-STALE cost-bound predicate.
//   2. createServiceStatsEnqueuer     — the advisory-lock + skip-if-pending dedup
//      producer for adapter_refresh_queue service rows (4-way: also folds the
//      Telegram + YouTube producers, whose algorithm is mechanically identical).
//   3. createWarmRefreshHandler       — the hourly producer: provider/throttle gate
//      → select → enqueue (IG + TikTok; Telegram strips the gates so it keeps its
//      own thin handler).
//   4. createSocialRefreshLane        — the SQL lane worker (claimGate + dispatch +
//      per-row resolve/fetch/snapshot) over the two slots user_post/service_post.
//
// SEAM CONTRACT (load-bearing): each per-platform config passes the provider /
// throttle / spend / writeSnapshot functions IT imports from its OWN tree
// (instagram|tiktok/server/{provider/registry,quota,snapshots}.js). The per-tree
// integration tests vi.mock exactly those tree-local modules, so threading them in
// as config — rather than importing the neutral registry here — keeps every
// existing vi.mock seam working unchanged (same reasoning as the 9e3b963 provider-
// registry shim). This factory NEVER imports a platform tree directly.

import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { db, type Tx } from "$lib/server/db/client.js";
import { events } from "$lib/server/db/schema/events.js";
import { adapterRefreshQueue } from "$lib/server/db/schema/index.js";
import { logger } from "$lib/server/logger.js";
import {
  createAdapterBatchLaneWorker,
  type AdapterBatchLaneWorker,
  type AdapterBatchLaneWorkerTickResult,
  type AdapterLaneClaimGateContext,
  type AdapterLaneClaimGateResult,
  type AdapterLaneDispatchContext,
  type AdapterLaneWorkerRow,
} from "$lib/server/services/adapter-lane-worker.js";
import { AdapterError, categoryToSnapshotStatus } from "$lib/sources/errors.js";
import type { SocialPlatform, NormalizedSinglePost } from "$lib/sources/social-provider.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

// ─── 1. Warm-eligibility predicate ──────────────────────────────────────────

export interface WarmEligibilityConfig {
  /** events.kind value joined against the posts table (e.g. "instagram_post"). */
  eventKind: string;
  /** The public-data posts table. */
  postsTable: PgTable;
  /** posts.id PK column (instagram_posts.post_id / tiktok_posts.aweme_id). It
   *  joins events.external_id AND is the SELECT projection. */
  idColumn: PgColumn;
  publishedAtColumn: PgColumn;
  lastPolledAtColumn: PgColumn;
  lastPollStatusColumn: PgColumn;
  pollFailureCountColumn: PgColumn;
  /** Per-platform env knobs, read at CALL TIME (env values are runtime-resolved). */
  windowDays(): number;
  stalenessHours(): number;
  maxFailures(): number;
  /** OPTIONAL extra AND-predicate ANDed into the eligibility WHERE. Reddit binds
   *  `isNull(reddit_posts.deletion_detected_at)` so a post detected as removed stops
   *  being warm-refreshed (spending credit re-polling a dead post is pure waste).
   *  IG/TikTok/Twitter omit it — they have no deletion-detect column. */
  extraWhere?: SQL;
  /** OPTIONAL per-subject warm cap. When set (with `subjectColumn`), the eligible set
   *  is trimmed to the N newest posts per subject via a ROW_NUMBER window, so a single
   *  firehose subject (e.g. a busy subreddit added by mistake) can't fan its off-walk
   *  posts into an unbounded per-tick warm batch and dominate the shared prepaid budget.
   *  Reddit binds `subredditSlug` + 5; IG/TikTok/Twitter omit it → the plain path runs. */
  perSubjectCap?: number;
  /** The column to PARTITION BY for `perSubjectCap` (Reddit: reddit_posts.subredditSlug). */
  subjectColumn?: PgColumn;
}

/**
 * Build the warm-eligibility selector. A post is "warm" (earns a PAID single-post
 * refresh ~1×/day via the service_post lane) while it is YOUNG (published within
 * the warm window) AND STALE (last_polled_at older than the staleness gate, which
 * sits just over the free 24h account-poll interval so we never double-pay page-1
 * posts), minus genuinely-terminal (not_found/private) and persistently-failing
 * (poll_failure_count >= max) posts.
 *
 * auth_error is deliberately NOT excluded (#70 P1-A): the paid scrapers' HTTP
 * seam collapses transient (5xx/timeout/network) AND operator-issue
 * (budget-exhausted) into last_poll_status='auth_error'. Excluding it wholesale
 * (as YouTube's permanent-key-rejection constant does) would FREEZE a post out of
 * auto-refresh on a single blip; poll_failure_count bounds the churn instead.
 *
 * Cross-tenant by design: the scheduler fan-out is service-wide; the posts table
 * is public-data; the per-post writeSnapshot downstream is public-data. ONE row
 * per post regardless of how many tenants reference it.
 */
export function createWarmEligibilitySelector(
  config: WarmEligibilityConfig,
): (now: Date) => Promise<string[]> {
  return async function selectWarmPostIds(now: Date): Promise<string[]> {
    const windowStart = new Date(now.getTime() - config.windowDays() * DAY_MS);
    const staleBefore = new Date(now.getTime() - config.stalenessHours() * HOUR_MS);

    const eligibilityWhere = and(
      sql`${events.kind} = ${config.eventKind}`,
      isNotNull(events.externalId),
      isNull(events.deletedAt),
      // Young: within the warm window. NULL published_at (pre-backfill 'pending') is
      // excluded — we don't know the age yet; the account poll fills it.
      gt(config.publishedAtColumn, windowStart),
      // Stale: never polled, or last poll older than the staleness gate.
      or(isNull(config.lastPolledAtColumn), lt(config.lastPolledAtColumn, staleBefore)),
      // Terminal exclusion — own (not_found/private only). See header (#70 P1-A).
      sql`(${config.lastPollStatusColumn} IS NULL OR ${config.lastPollStatusColumn} NOT IN ('not_found','private'))`,
      // Bounded-failure exclusion — stop churning credits on a persistent failure.
      lt(config.pollFailureCountColumn, config.maxFailures()),
      // Optional per-platform extra predicate (Reddit: skip deletion-detected posts).
      config.extraWhere,
    );

    // Per-subject cap path (Reddit): keep only the N newest eligible posts per subject so
    // a firehose subreddit's off-walk posts can't fan into an unbounded warm batch. A
    // window function can't live in WHERE, so rank in a subquery then filter the outer.
    if (config.perSubjectCap !== undefined && config.subjectColumn !== undefined) {
      // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- scheduler fan-out is service-wide by design; the posts table is public-data (justification threaded per platform via config).
      const base = db
        .selectDistinct({
          id: config.idColumn,
          subject: config.subjectColumn,
          pub: config.publishedAtColumn,
        })
        .from(events)
        .innerJoin(config.postsTable, eq(events.externalId, config.idColumn))
        .where(eligibilityWhere)
        .as("warm_base");
      const ranked = db
        .select({
          id: base.id,
          rn: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${base.subject} ORDER BY ${base.pub} DESC NULLS LAST)`.as(
            "rn",
          ),
        })
        .from(base)
        .as("warm_ranked");
      const capped = await db
        .select({ id: ranked.id })
        .from(ranked)
        .where(sql`${ranked.rn} <= ${config.perSubjectCap}`);
      return capped.map((r) => r.id as string);
    }

    // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- scheduler fan-out is service-wide by design; one warm tick batches eligible posts across ALL tenants. The posts table is public-data; the per-post writeSnapshot downstream is public-data; tenant scope does not apply (justification threaded per platform via config).
    const rows = await db
      .selectDistinct({ id: config.idColumn })
      .from(events)
      .innerJoin(config.postsTable, eq(events.externalId, config.idColumn))
      .where(eligibilityWhere);
    return rows.map((r) => r.id as string);
  };
}

// ─── 2. service_post / service_video producer (advisory-lock + skip-if-pending) ─

export interface ServiceStatsEnqueuerConfig {
  adapterKind: string;
  queueName: string;
  /** hashtext lock-string prefix (e.g. "instagram_service_post:"). */
  lockPrefix: string;
  /** adapter_refresh_queue.type value ("post_stats" / "video_stats"). */
  rowType: string;
  /** payload JSON key the id is written under + the dedup scan reads
   *  (e.g. "post_id" / "video_id"). */
  payloadIdKey: string;
}

/**
 * Build the warm/cron stats producer: enqueue ONE dedup'd service row per id into
 * adapter_refresh_queue (user_id=NULL → public-data cron lane). Two invariants the
 * auto path MUST hold and this preserves byte-for-byte:
 *   - advisory-lock per id in DETERMINISTIC (sorted) order — serializes concurrent
 *     producer ticks and avoids deadlock. Kept as the per-row loop on purpose (NOT
 *     collapsed to a single statement) to minimize the money-path behavioral delta.
 *   - skip-if-pending dedup — between enqueue and processing last_polled_at is
 *     still stale, so the next warm tick would re-select the same post; the manual
 *     user_post path stays cooldown-only and is NOT routed through here.
 *
 * Mechanically identical across IG / TikTok / Telegram (post_id, no extra payload)
 * and YouTube (video_id + a per-call `flow` extra-payload field) — the 4-way
 * reuse-review finding. The optional `extraPayload` arg carries YouTube's `flow`,
 * which varies per call site (active/cold/backfill/rehab), so it is supplied at
 * call time rather than baked into the config.
 */
export function createServiceStatsEnqueuer<
  TExtra extends Record<string, unknown> = Record<string, never>,
>(config: ServiceStatsEnqueuerConfig): (ids: string[], extraPayload?: TExtra) => Promise<number> {
  return async function enqueueServiceStats(ids: string[], extraPayload?: TExtra): Promise<number> {
    const unique = [...new Set(ids.filter((id) => id.length > 0))];
    if (unique.length === 0) return 0;

    return db.transaction(async (tx) => {
      // Deterministic lock order (sorted) avoids deadlocks between concurrent ticks.
      for (const id of [...unique].sort()) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${config.lockPrefix + id}))`);
      }

      const payloadIdSql = sql`${adapterRefreshQueue.payload}->>${config.payloadIdKey}`;
      // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- justification threaded per platform via config
      const existing = await tx
        .select({ id: sql<string>`${payloadIdSql}` })
        .from(adapterRefreshQueue)
        .where(
          and(
            eq(adapterRefreshQueue.adapterKind, config.adapterKind),
            eq(adapterRefreshQueue.queueName, config.queueName),
            inArray(adapterRefreshQueue.status, ["pending", "processing"]),
            sql`${payloadIdSql} IN (${sql.join(
              unique.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        );
      const existingIds = new Set(existing.map((row) => row.id));

      const rows = unique
        .filter((id) => !existingIds.has(id))
        .map((id) => ({
          adapterKind: config.adapterKind,
          queueName: config.queueName,
          type: config.rowType,
          payload: { [config.payloadIdKey]: id, ...(extraPayload ?? {}) },
          userId: null,
          priority: 10,
          status: "pending" as const,
        }));

      if (rows.length === 0) return 0;
      const inserted = await tx
        .insert(adapterRefreshQueue)
        .values(rows)
        .returning({ id: adapterRefreshQueue.id });
      return inserted.length;
    });
  };
}

// ─── 3. Warm-refresh producer handler (gated: provider + throttle) ───────────

export interface WarmRefreshHandlerConfig {
  /** Lowercase platform string used in log lines + the provider/throttle seam. */
  platform: SocialPlatform;
  /** Provider name for the throttle read ("scrapecreators"). */
  provider: string;
  /** Tree-local getSocialProvider (so per-tree vi.mock intercepts). */
  getSocialProvider(platform: SocialPlatform): unknown | null;
  /** Tree-local getSocialThrottleState (so per-tree vi.mock intercepts). */
  getSocialThrottleState(
    platform: string,
    provider: string,
  ): Promise<"ok" | "eighty" | "ninetyfive">;
  /** The warm-eligibility selector (factory #1, bound in the tree). */
  selectWarmPostIds(now: Date): Promise<string[]>;
  /** The service-stats producer (factory #2, bound in the tree). */
  enqueueServiceStats(ids: string[]): Promise<number>;
}

/**
 * Build the hourly warm-refresh producer. Fires on poll.cron {tier:"warm"} BEFORE
 * the account-picker. Two skip-gates, then select → enqueue:
 *   - provider unconfigured → skip (the lane worker's isEnabled gates OFF, so an
 *     enqueued row would orphan as pending forever — #70 ultrareview P1).
 *   - throttle >= "eighty" → skip (warm is NON-ESSENTIAL background spend, like
 *     the cold tier). The hourly cadence + the staleness gate + skip-if-pending
 *     dedup mean a post gets at most ~1 paid refresh/day.
 *
 * IG + TikTok only. Telegram is free — it strips both gates, so it keeps its own
 * thin handler rather than passing no-op gates here.
 */
export function createWarmRefreshHandler(
  config: WarmRefreshHandlerConfig,
): (job: { id?: string }) => Promise<void> {
  const { platform } = config;
  return async function handleWarmRefresh(job: { id?: string }): Promise<void> {
    // Don't enqueue work the lane can't run: the refresh lane worker is disabled
    // (isEnabled) when the provider is unconfigured, so service_post rows would
    // orphan as pending forever (#70 ultrareview P1). Mirror the manual canRun gate.
    if (config.getSocialProvider(platform) === null) {
      logger.debug(
        { jobId: job.id },
        `${platform}.poll.cron tier=warm: provider unconfigured — skip (lane disabled)`,
      );
      return;
    }

    const throttle = await config.getSocialThrottleState(platform, config.provider);
    if (throttle === "ninetyfive" || throttle === "eighty") {
      logger.info(
        { jobId: job.id, throttle },
        `${platform}.poll.cron tier=warm: budget throttled — skipping non-essential warm refresh`,
      );
      return;
    }

    const postIds = await config.selectWarmPostIds(new Date());
    if (postIds.length === 0) {
      logger.debug({ jobId: job.id }, `${platform}.poll.cron tier=warm: no warm posts due`);
      return;
    }

    const enqueued = await config.enqueueServiceStats(postIds);
    logger.info(
      { jobId: job.id, selected: postIds.length, enqueued },
      `${platform}.poll.cron tier=warm: service_post rows enqueued`,
    );
  };
}

// ─── 4. SQL refresh lane worker (claimGate + dispatch + per-row processing) ───

const REFRESH_SLOTS = ["user_post", "service_post"] as const;
export type SocialRefreshQueueName = (typeof REFRESH_SLOTS)[number];

const MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 5 * 60_000;
const STALE_RECOVERY_INTERVAL_MS = 60_000;
const THROTTLE_DEFER_MS = 5 * 60_000;

/** The minimal provider seam the lane needs — the single-post by-URL fetch.
 *  `pacerAlreadyAcquired` is threaded ONLY by platforms whose claimGate acquires a
 *  global QPS pacer (Twitter): it tells the HTTP seam the lane already holds the slot
 *  for this tick, so the seam must NOT double-acquire. IG/TikTok have no pacer and
 *  leave it undefined — their seams ignore it. */
interface RefreshProvider {
  fetchPostByUrl(
    platform: string,
    url: string,
    opts: { origin: "cron" | "user"; pacerAlreadyAcquired?: boolean },
  ): Promise<NormalizedSinglePost | null>;
}

/** The claimGate permit shape (Twitter's QPS-pacer seam — the only pacer platform):
 *  `pacerAlreadyAcquired` is true iff the lane acquired the global pacer slot in the
 *  claimGate this tick, so the per-row HTTP seam skips its own acquire. */
interface SocialRefreshPermit {
  pacerAlreadyAcquired: boolean;
}

export interface SocialRefreshLaneConfig {
  /** adapter_refresh_queue.adapter_kind (e.g. "instagram_account"). */
  adapterKind: string;
  /** Lowercase platform string used in log lines + the provider/spend seam. */
  platform: SocialPlatform;
  /** Provider name for the spend read ("scrapecreators"). */
  provider: string;
  /** Lane concurrency knob (env.SOCIAL_REFRESH_LANE_CONCURRENCY). NOT a
   *  batch-in-one-request size — the single-post endpoint is 1 request = 1 post,
   *  so this is the parallelism of dispatch's Promise.allSettled. */
  maxBatchSize: number;
  /** Tree-local getSocialProvider (so per-tree vi.mock intercepts). */
  getSocialProvider(platform: SocialPlatform): RefreshProvider | null;
  /** Some providers can only search a bounded newest-feed page. For those adapters a
   * null match is inconclusive, not proof that the post is deleted/private. */
  nullResultIsInconclusive?: boolean;
  /** Tree-local PROVIDER-WIDE spend read (so per-tree vi.mock intercepts). The
   *  claimGate's 95% defer must see the JOINT spend across every platform sharing
   *  the provider's prepaid pool (D-01) — a platform-filtered read under-counts and
   *  lets rows through to a reserve that then denies them (`rate_limited` snapshot
   *  instead of a clean defer-to-reset). Per-platform reads stay in the UI /
   *  attribution paths only. */
  getSocialProviderSpendToday(
    provider: string,
  ): Promise<{ creditsUsed: number; dailyCap: number; prepaidBalance: number }>;
  /** OPTIONAL global QPS pacer acquire, run AFTER the budget gate passes (Twitter
   *  only). A denied slot DEFERS the row (stays pending → retried) instead of letting
   *  it reach the seam, fail rate-limited, write a snapshot, and complete `done` with no
   *  retry — which is how a manual Refresh-Now silently no-ops under contention. When
   *  acquired, the permit threads `pacerAlreadyAcquired` so the seam does NOT
   *  re-acquire. Runs on the claim `tx` so a claim-tx rollback rolls the slot back too.
   *  IG/TikTok/Reddit omit this (no QPS pacer) and keep their budget-only gate. */
  acquirePacerSlot?(tx: Tx): Promise<{ acquired: boolean; waitMs: number }>;
  /** Resolve the post's permalink from the public-data posts cache, or null on a
   *  cache miss (e.g. a paste before the first account poll → graceful skip). The
   *  claimed row rides along so a tenant-owned fallback (Reddit's events lookup)
   *  can scope by row.userId — single-param implementations just ignore it. */
  resolvePermalink(postId: string, row: AdapterLaneWorkerRow): Promise<string | null>;
  /** Resolve the MANUAL (user_post) row's post id from its event, TENANT-SCOPED. */
  resolveUserPostId(row: AdapterLaneWorkerRow): Promise<string | null>;
  /** Write a per-post snapshot. This is the ONE genuine per-platform delta: TikTok
   *  threads `shares` (PLAT-02) into its snapshot; IG nulls it. Each tree binds its
   *  own writeSnapshot with the right key field (postId/awemeId) + metric set. */
  writeSnapshot(args: {
    postId: string;
    permalink: string;
    post: NormalizedSinglePost | null;
    status: "ok" | "not_found" | "auth_error" | "rate_limited" | "private";
  }): Promise<void>;
}

export interface SocialRefreshLane {
  tick(): Promise<AdapterBatchLaneWorkerTickResult>;
  resetForTest(): void;
}

/**
 * Build the per-post refresh lane worker. Two slots over adapter_refresh_queue:
 *   - "user_post"    — MANUAL "Refresh now". Payload {event_id, post_id},
 *                      user_id SET. Resolved TENANT-SCOPED; fetch charges the USER pool.
 *   - "service_post" — CRON warm auto-refresh. Payload {post_id}, user_id NULL.
 *                      PUBLIC-DATA, NO event lookup; fetch charges the OPERATOR (cron) pool.
 *
 * Claims up to maxBatchSize rows of ONE slot per tick (batchScope "global" — across
 * users) and refreshes them CONCURRENTLY: the single-post endpoint can't batch, so
 * scale comes from concurrency. Each post is independent → dispatch uses
 * Promise.allSettled, writes a per-post snapshot (ok or non-ok), and NEVER throws —
 * the lane worker then marks every claimed row `done` (no batch-wide retry that
 * would re-fetch + re-charge the successes). A transient failure lands a non-ok
 * snapshot (which stamps last_polled_at so the RefreshNowButton stop-loop settles)
 * and is recovered by the user re-clicking or the next scheduled poll.
 *
 * The credit reserve happens INSIDE provider.fetchPostByUrl (origin-scoped), so the
 * claimGate is a throttle gate ONLY (defer at 95%), never a second reserve.
 */
export function createSocialRefreshLane(config: SocialRefreshLaneConfig): SocialRefreshLane {
  const { platform } = config;

  // Throttle gate (D2): NOT a reserve (the single reserve happens inside
  // fetchPostByUrl), so no double-charge. It distinguishes the two "exhausted"
  // states getSocialThrottleState would both report as "ninetyfive" (#69 P1-B):
  //   - Prepaid balance <= 0 is the MONOTONIC hard ceiling — it never resets, so a
  //     defer would loop forever and the RefreshNowButton would spin indefinitely.
  //     RUN instead: dispatch's in-fetch reserve fails → a non-ok snapshot → the
  //     row completes and the button settles (post shows unavailable).
  //   - Daily cap >= 95% (balance still funded) resets at midnight Pacific — DEFER;
  //     it recovers on its own (mirrors the YouTube/Reddit "wait for reset" defer).
  //
  // Two-pool coupling (#70 P2-B, accepted): getSocialProviderSpendToday SUMS both pools, so
  // this coarse gate can defer a service_post tick on user-pool spend (or vice-versa).
  // That's fine — the real per-pool ceiling is the in-fetch origin-scoped reserve
  // (user_post→user pool, service_post→cron pool); this stays a cheap tick throttle.
  async function claimThrottleSlot(
    ctx: AdapterLaneClaimGateContext<SocialRefreshQueueName>,
  ): Promise<AdapterLaneClaimGateResult<SocialRefreshPermit>> {
    // Budget gate FIRST — a budget-defer must NOT consume a pacer slot (it would pace
    // out unrelated twitter traffic by a slot interval without making any fetch). Only
    // once budget passes do we touch the pacer. PROVIDER-WIDE spend (D-01 joint cap)
    // — mirrors the reserve's own joint band math.
    const { creditsUsed, dailyCap, prepaidBalance } = await config.getSocialProviderSpendToday(
      config.provider,
    );
    if (prepaidBalance > 0 && dailyCap > 0 && creditsUsed >= Math.floor(dailyCap * 0.95)) {
      return {
        action: "defer",
        retryAfterMs: THROTTLE_DEFER_MS,
        reason: `${platform} daily cap at 95%`,
      };
    }

    // Global QPS pacer (Twitter): acquire AFTER budget passes, on the claim tx so a
    // claim-tx rollback rolls the slot back too. A denied slot DEFERS — the row stays
    // pending and is retried, so a manual Refresh-Now is never consumed against a busy
    // slot. Acquiring here (not at the seam) keeps the slot on the claim tx; the permit
    // then tells the seam to skip its own acquire so the slot isn't double-spent.
    // IG/TikTok/Reddit pass no acquirePacerSlot → pacerAlreadyAcquired stays false.
    let pacerAlreadyAcquired = false;
    if (config.acquirePacerSlot !== undefined) {
      const slot = await config.acquirePacerSlot(ctx.tx);
      if (!slot.acquired) {
        return {
          action: "defer",
          retryAfterMs: slot.waitMs,
          reason: `${platform} QPS pacer busy`,
        };
      }
      pacerAlreadyAcquired = true;
    }

    return { action: "run", permit: { pacerAlreadyAcquired } };
  }

  // allSettled + per-row snapshot + NEVER throw → the lane worker marks every
  // claimed row `done` (independent posts; a per-row failure must not re-fetch the
  // successes via a batch-wide throw-to-retry).
  async function dispatchRefreshBatch(
    rows: AdapterLaneWorkerRow[],
    ctx: AdapterLaneDispatchContext<SocialRefreshPermit>,
  ): Promise<void> {
    const pacerAlreadyAcquired = ctx.permit?.pacerAlreadyAcquired ?? false;
    await Promise.allSettled(rows.map((row) => processOne(row, pacerAlreadyAcquired)));
  }

  async function processOne(
    row: AdapterLaneWorkerRow,
    pacerAlreadyAcquired: boolean,
  ): Promise<void> {
    try {
      const postId =
        row.queueName === "service_post"
          ? resolveServicePostId(row)
          : await config.resolveUserPostId(row);
      if (postId === null) return; // skip reasons are logged inside the resolvers
      const permalink = await config.resolvePermalink(postId, row);
      if (permalink === null) {
        // Accepted wasted slot: the pacer slot was claimed in the claimGate but this
        // row no-ops on a cache miss. Rare, and a cache-miss row would no-op anyway.
        logger.info({ postId }, `${platform} refresh: post not cached yet — skip`);
        return;
      }
      // user_post → user pool (the clicking user pays); service_post → cron pool
      // (operator-funded warm auto-refresh, like YouTube service_video).
      const origin = row.queueName === "service_post" ? "cron" : "user";
      await refreshPost(postId, permalink, origin, pacerAlreadyAcquired);
    } catch (err) {
      // #70 P1: a failure must NEVER vanish silently into allSettled. A resolution
      // failure (a DB select threw) has no postId yet → it can't write a snapshot,
      // so LOG it here. refreshPost owns its own non-ok snapshot for fetch/write
      // failures (it has the postId). The row still completes `done`; recovery is
      // the warm predicate re-selecting the stale post next scheduler tick (auto
      // path) or a manual re-click (user_post).
      logger.warn(
        { rowId: row.id, queueName: row.queueName, err: String((err as Error)?.message ?? err) },
        `${platform} refresh: row failed before snapshot — recovered by re-selection`,
      );
    }
  }

  // CRON warm path: the post id is in the payload directly. PUBLIC-DATA — no event
  // lookup, no userId (mirrors youtube loadVideoWork's service_video branch).
  function resolveServicePostId(row: AdapterLaneWorkerRow): string | null {
    const postId = row.payload?.post_id;
    return typeof postId === "string" ? postId : null;
  }

  // Fetch one post + write its snapshot. Owns its own try/catch so a per-row failure
  // lands a VISIBLE non-ok snapshot (stamps last_polled_at — the manual button
  // settles; the warm predicate's poll_failure_count bound advances) and NEVER
  // throws (the lane marks the row done; no batch-wide retry that would re-fetch +
  // re-charge the successes). `origin` picks the credit pool (user vs cron).
  async function refreshPost(
    postId: string,
    permalink: string,
    origin: "cron" | "user",
    pacerAlreadyAcquired: boolean,
  ): Promise<void> {
    const provider = config.getSocialProvider(platform);
    if (provider === null) return; // unconfigured — isEnabled gates the lane; defensive.

    try {
      // fetchPostByUrl reserves one prepaid credit internally from the `origin` pool.
      // pacerAlreadyAcquired tells the seam the claimGate already holds the QPS slot.
      const post = await provider.fetchPostByUrl(platform, permalink, {
        origin,
        pacerAlreadyAcquired,
      });
      if (post === null) {
        if (config.nullResultIsInconclusive === true) {
          logger.info(
            { postId },
            `${platform} refresh: bounded provider lookup was inconclusive`,
          );
          return;
        }
        // Deleted / private — the envelope carried no media object.
        await config.writeSnapshot({ postId, permalink, post: null, status: "not_found" });
        return;
      }
      await config.writeSnapshot({ postId, permalink, post, status: "ok" });
    } catch (err) {
      // An AdapterError maps to its category; an unexpected throw (a programmer bug)
      // degrades to "auth_error" and is logged.
      const status =
        err instanceof AdapterError ? categoryToSnapshotStatus(err.category) : "auth_error";
      if (!(err instanceof AdapterError)) {
        logger.warn(
          { postId, err: String((err as Error)?.message ?? err) },
          `${platform} refresh: unexpected error`,
        );
      }
      // Best-effort: if the original failure WAS the snapshot write (DB down), this
      // re-write also fails — swallow so the row still completes, don't re-throw.
      await config.writeSnapshot({ postId, permalink, post: null, status }).catch((e) => {
        logger.warn(
          { postId, err: String((e as Error)?.message ?? e) },
          `${platform} refresh: snapshot write failed`,
        );
      });
    }
  }

  const worker: AdapterBatchLaneWorker = createAdapterBatchLaneWorker<
    SocialRefreshQueueName,
    SocialRefreshPermit
  >({
    adapterKind: config.adapterKind,
    slots: REFRESH_SLOTS,
    fallthrough: REFRESH_SLOTS,
    maxAttempts: MAX_ATTEMPTS,
    maxBatchSize: config.maxBatchSize,
    batchScope: "global",
    staleProcessingMs: STALE_PROCESSING_MS,
    staleRecoveryIntervalMs: STALE_RECOVERY_INTERVAL_MS,
    claimGate: claimThrottleSlot,
    dispatch: dispatchRefreshBatch,
    // Observability (#70 P3-A): one INFO per drained tick, tagged by slot, so warm
    // (service_post) credit spend is visible in Loki/Grafana SEPARATE from manual
    // (user_post) spend — the lane is where credits are actually burned.
    emitDrained: ({ queueName, entriesProcessed, durationMs }) => {
      logger.info(
        { queueName, entriesProcessed, durationMs },
        `${platform} refresh lane: tick drained`,
      );
    },
  });

  return {
    tick: () => worker.tick(),
    resetForTest: () => worker.resetForTest(),
  };
}

export { REFRESH_SLOTS };
