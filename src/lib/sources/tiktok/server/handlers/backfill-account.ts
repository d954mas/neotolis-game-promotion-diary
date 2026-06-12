// tiktok.backfill.account queue handler — the account-scoped resumable walker
// (clone of instagram/server/handlers/backfill-account.ts, COLLAPSED to a single
// feed).
//
// One walk-step per tick; fan-out INSERT to ALL active subscribers of the
// account.
//
// SINGLE-FEED DELTA (RESEARCH Pattern 2): Instagram juggles BOTH a posts and a
// reels feed (two cursors, complete only when BOTH exhausted). TikTok is ONE feed
// — `/v3/tiktok/profile/videos` returns one `max_cursor` + one `has_more`
// (10-SPIKE.md Call 1). So this walker drops IG's posts/reels two-state machinery:
// ONE cursor loop, `backfill_complete` = the single feed exhausted (has_more !== 1
// or an empty page).
//
// Other divergences mirror IG (encoded here):
//   - channelKey = the resolved TikTok account_id (NEVER the user-pasted handle —
//     handles rename; account_id is intrinsic). Lives on data_sources.metadata.
//     accountId; the walker reads the handle from metadata.handle only as the
//     provider query param.
//   - ONE page per tick (BACK-02). The running collected-count is persisted across
//     ticks (BACK-01): the walk stops when collected >= SOCIAL_BACKFILL_MAX_POSTS
//     OR a post.publishedAt < the date window OR has_more !== 1, whichever first —
//     cost is independent of archive size.
//   - Pitfall 4: a missing/private handle returns an empty first page on a
//     brand-new source → markSourceNeedsReconnect not_found; do NOT mark
//     backfill_complete (that would silently swallow a typo'd handle). For TikTok
//     the PRIMARY missing-handle signal is resolveAccount's null-by-presence at
//     create time (10-SPIKE.md Call 4); the empty-first-page heuristic is the
//     belt-and-suspenders fallback.
//   - Pitfall 5: the trigger user pays the per-user cap ONCE per user action;
//     continuation pages run on the CRON pool (triggerUserId omitted).
//   - BUDGET-02: each page reserves operator credits BEFORE the provider call
//     (inside the provider HTTP seam via ctx.origin). A null permit surfaces as an
//     AdapterError(operator-issue | rate-limited) here → stop this tick and persist
//     the cursor for resume (pausable/throttled).
//   - The free feed owner object (10-SPIKE.md: aweme_list[].author, snake_case)
//     UPSERTs tiktok_accounts opportunistically — NO extra credit.

import { and, eq, isNotNull, isNull, inArray, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { events } from "$lib/server/db/schema/events.js";
import { logger } from "$lib/server/logger.js";
import { writeAuditStrict } from "$lib/server/audit.js";
import { enqueueViaOutbox } from "$lib/server/services/outbox.js";
import { QUEUES } from "$lib/server/queues.js";
import {
  markSourceNeedsReconnect,
  clearNeedsReconnect,
} from "$lib/server/services/data-sources.js";
import {
  getChannelState,
  markChannelLastPolledAt,
  markChannelBackfillFrontier,
  markChannelBackfillComplete,
} from "$lib/server/services/channel-state.js";
import { getSocialProvider } from "../provider/registry.js";
import { writeSnapshot, upsertTikTokAccount } from "../snapshots.js";
import { readTikTokBackfillState, writeTikTokBackfillState } from "../backfill-state.js";
import { buildTikTokTitle } from "../normalize.js";
import { env } from "$lib/server/config/env.js";
import { AdapterError } from "$lib/sources/errors.js";
import type { RawEvent, SourceKind } from "$lib/sources/adapter.js";
import type { NormalizedPost } from "$lib/sources/social-provider.js";

type BackfillFlow = "initial" | "incremental" | "historical" | "auto_passive";

interface BackfillAccountJob {
  id?: string;
  data: {
    kind: SourceKind;
    /** The resolved TikTok account_id (the channelKey). */
    channelKey: string;
    /** UserId who triggered this walk. Undefined for cron — the trigger user pays
     *  the per-user cap; cron continuation pages run on the cron pool. */
    triggerUserId?: string;
    /** Walk depth target — earliest publishedAt to walk to. ISO 8601. */
    depthBoundIso: string;
    flow: BackfillFlow;
    /** Force a deep walk regardless of the branch derivation (set by
     *  resetWalkerStateOnWidening). */
    forceDeep?: boolean;
  };
}

const KIND = "tiktok_account" as const;

/** Map a NormalizedPost → cross-source RawEvent (SOC-04: the ScrapeCreators field
 *  shape is already gone — the provider seam returns NormalizedPost). The D-09
 *  title (caption first line, "TikTok <kind> · <date>" fallback) is the shared
 *  buildTikTokTitle (one spelling with the paste-preview path). */
function postToRawEvent(post: NormalizedPost): RawEvent {
  return {
    externalId: post.id,
    url: post.permalink ?? `https://www.tiktok.com/video/${post.id}`,
    title: buildTikTokTitle(post.caption, post.kind, post.publishedAt),
    occurredAt: post.publishedAt,
    kind: "tiktok_post",
    metadata: {
      media_type: post.kind,
      thumbnail_url: post.thumbnailUrl,
      caption: post.caption,
    },
  };
}

export async function handleBackfillAccount(job: BackfillAccountJob): Promise<void> {
  const { channelKey, triggerUserId } = job.data;
  const kind = job.data.kind;
  let flow: BackfillFlow = job.data.flow ?? "auto_passive";

  if (typeof channelKey !== "string" || typeof kind !== "string") {
    logger.warn(
      { jobId: job.id, payload: job.data },
      "tiktok.backfill.account: malformed payload (missing kind/channelKey); skipping",
    );
    return;
  }
  if (kind !== KIND) {
    logger.warn({ jobId: job.id, kind }, "tiktok.backfill.account: unsupported kind; skipping");
    return;
  }

  // 1. Active subscribers for this account. CROSS-TENANT BY DESIGN — the whole
  //    point of account-scoped polling (the channelKey is the account_id, stored
  //    on data_sources.channelId at create time).
  // eslint-disable-next-line tenant-scope/no-unfiltered-tenant-query -- channel-scoped fan-out (see header)
  const subscribers = await db
    .select()
    .from(dataSources)
    .where(
      and(
        eq(dataSources.kind, KIND),
        eq(dataSources.channelId, channelKey),
        isNull(dataSources.deletedAt),
      ),
    );
  if (subscribers.length === 0) {
    logger.info(
      { jobId: job.id, channelKey },
      "tiktok.backfill.account: no active subscribers — account orphaned; skipping",
    );
    return;
  }

  // The provider query handle. All subscribers to one account_id share the same
  // canonical handle; read it off any active subscriber's metadata.
  const handle = resolveHandle(subscribers);
  if (handle === null) {
    logger.warn(
      { jobId: job.id, channelKey },
      "tiktok.backfill.account: no handle on any subscriber metadata; skipping",
    );
    return;
  }

  const provider = getSocialProvider("tiktok");
  if (provider === null) {
    // SOC-05 graceful degrade — provider not configured. No-op (the cron lane
    // should not have enqueued this, but be defensive).
    logger.info(
      { jobId: job.id, channelKey },
      "tiktok.backfill.account: provider not configured; degrading to no-op",
    );
    return;
  }

  // 2. Channel state + branch derivation (mirror YouTube/IG three-branch).
  const channelState = await getChannelState(KIND, channelKey);
  const wasNeverPolled = channelState === undefined || channelState.lastPolledAt === null;

  const target = new Date(job.data.depthBoundIso);
  if (Number.isNaN(target.getTime())) {
    logger.warn(
      { jobId: job.id, depthBoundIso: job.data.depthBoundIso },
      "tiktok.backfill.account: invalid depthBoundIso; skipping",
    );
    return;
  }
  const deepestWalked = channelState?.backfillOldestAt ?? null;
  let branch: "exhausted" | "incremental" | "deep";
  if (job.data.forceDeep === true) {
    branch = "deep";
  } else if (channelState?.backfillComplete === true) {
    branch = "exhausted";
  } else if (deepestWalked !== null && target.getTime() >= deepestWalked.getTime()) {
    branch = "incremental";
  } else {
    branch = "deep";
  }

  // Incremental/exhausted branches DO NOT walk deeper (BACK-03): they fetch page 1
  // only (cursor reset to null) to discover new posts since the frontier, and the
  // date-window `since` is the frontier (newest known), not the historical target.
  // Deep / forceDeep resume from the persisted cursor and walk toward `target`.
  const incrementalBranch = branch !== "deep";
  const dateWindowSince = computeDateWindowSince(branch, target, deepestWalked);

  // Read (or reset) the resumable single-feed state. Incremental/exhausted
  // branches start at page 1 (cursor null) with the running count reset to 0.
  let state = readTikTokBackfillState(channelState);
  if (incrementalBranch) {
    state = {
      cursor: null,
      complete: false,
      collected: 0,
      // Carry the prior paused flag — a successful (unpaused) tick below clears
      // it; a re-paused tick re-sets it. Resetting to false here would flicker the
      // badge off mid-pause on every incremental sweep.
      operatorPaused: state.operatorPaused,
    };
  }

  const maxPosts = env.SOCIAL_BACKFILL_MAX_POSTS;
  const origin: "cron" | "user" = triggerUserId ? "user" : "cron";

  // 3. Walk ONE page this tick. Accumulate events + count; stop when the feed
  //    ends, when a post is past the date window, or when the post-count cap is
  //    hit (deep branch only — the cap bounds historical depth).
  const collectedEvents: RawEvent[] = [];
  let requestsUsed = 0;
  let oldestFetchedOccurredAt: Date | null = null;
  let pausedByBudget = false;
  let walkedThisTick = false;

  if (!state.complete && !(branch === "deep" && state.collected >= maxPosts)) {
    walkedThisTick = true;
    let page;
    try {
      // ONE provider page. The credit reservation runs inside the provider's HTTP
      // seam (http.ts) when origin is set — a null permit throws AdapterError
      // (operator-issue / rate-limited) which we catch to pause + persist cursor.
      page = await provider.fetchPosts("tiktok", handle, state.cursor, { origin });
    } catch (err) {
      if (err instanceof AdapterError) {
        if (err.category === "rate-limited" || err.category === "operator-issue") {
          // Budget paused (null permit) OR throttled — stop this tick and persist
          // the cursor for resume. Do NOT advance / complete.
          logger.info(
            { jobId: job.id, channelKey, category: err.category },
            "tiktok.backfill.account: budget/throttle pause — persisting cursor for resume",
          );
          pausedByBudget = true;
        } else if (err.category === "not-found") {
          // Missing/private handle (HTTP 404). Flag every subscriber's source so
          // resolveTier shows unavailable; do NOT mark complete.
          for (const sub of subscribers) {
            await markSourceNeedsReconnect(sub.userId, sub.id, "not-found");
          }
          await markChannelLastPolledAt(KIND, channelKey);
          logger.info(
            { jobId: job.id, channelKey },
            "tiktok.backfill.account: 404 not_found — sources flagged unavailable",
          );
          return;
        } else {
          // transient / permanent → rethrow for pg-boss retry / dead-letter.
          throw err;
        }
      } else {
        throw err;
      }
    }

    if (page !== undefined && !pausedByBudget) {
      requestsUsed += page.creditsUsed;

      // Opportunistically refresh the account subject entity (tiktok_accounts)
      // from the FREE feed owner object the page already carries — NO extra
      // credit. The richer profile fields (nickname / follower_count) were set by
      // the PAID create-time resolve and are COALESCE-preserved; this cheap
      // refresh keeps account_id + the current @handle (+ avatar) fresh, appending
      // a renamed handle to handle_aliases. Anchor on the feed owner's id, falling
      // back to the channelKey. Best-effort: a failed write must not abort the walk.
      if (page.owner !== undefined && page.owner !== null) {
        const ownerAccountId = page.owner.accountId ?? channelKey;
        try {
          await upsertTikTokAccount({
            accountId: ownerAccountId,
            username: page.owner.username,
            avatarUrl: page.owner.avatarUrl,
          });
        } catch (err) {
          logger.warn(
            { jobId: job.id, channelKey, err: String((err as Error)?.message ?? err) },
            "tiktok.backfill.account: tiktok_accounts UPSERT from feed owner failed (non-fatal)",
          );
        }
      }

      // Write each post's snapshot + cache row, then collect the RawEvent.
      // Date-window bound: collect posts newer than the window boundary; stop the
      // moment we cross below it (the page is newest-first).
      let crossedWindow = false;
      for (const post of page.posts) {
        await writeSnapshot({
          awemeId: post.id,
          accountId: channelKey,
          mediaType: post.kind,
          caption: post.caption,
          permalink: post.permalink,
          thumbnailUrl: post.thumbnailUrl,
          publishedAt: post.publishedAt,
          metrics: {
            views: post.metrics.views,
            likes: post.metrics.likes,
            comments: post.metrics.comments,
            shares: post.metrics.shares,
          },
          status: "ok",
        });

        if (post.publishedAt.getTime() < dateWindowSince.getTime()) {
          crossedWindow = true;
          break;
        }
        collectedEvents.push(postToRawEvent(post));
        state.collected += 1;
        if (oldestFetchedOccurredAt === null || post.publishedAt < oldestFetchedOccurredAt) {
          oldestFetchedOccurredAt = post.publishedAt;
        }
        // Post-count cap (deep branch): stop collecting the moment we hit it.
        if (branch === "deep" && state.collected >= maxPosts) {
          crossedWindow = true;
          break;
        }
      }

      // Advance / complete the single feed.
      state.cursor = page.nextCursor;
      if (page.endOfFeed || crossedWindow || page.nextCursor === null) {
        state.complete = true;
      }
    }
  }

  // 4. Pitfall 4 — empty first page on a brand-new source = probable bad/private
  //    handle. No events, a request was made, the feed reports end-of-feed with no
  //    cursor on the very first poll → not_found, NOT complete.
  if (
    wasNeverPolled &&
    !pausedByBudget &&
    walkedThisTick &&
    collectedEvents.length === 0 &&
    requestsUsed > 0 &&
    state.complete &&
    state.cursor === null
  ) {
    for (const sub of subscribers) {
      await markSourceNeedsReconnect(sub.userId, sub.id, "not-found");
    }
    await markChannelLastPolledAt(KIND, channelKey);
    if (triggerUserId) {
      await writeBackfillAudit({
        job,
        flow,
        channelKey,
        triggerUserId,
        requestsUsed,
        eventsInserted: 0,
        sinceBranch: branch,
      });
    }
    logger.info(
      { jobId: job.id, channelKey },
      "tiktok.backfill.account: empty first page on new source — flagged not_found (Pitfall 4)",
    );
    return;
  }

  // 5. Fan-out INSERT for each subscriber. Per (event × subscriber): skip if
  //    occurredAt < subscriber.target_since; auto_passive skips non-auto_import
  //    subscribers; user flows let the trigger user override their own opt-out.
  let insertedTotal = 0;
  const insertedByUser = new Map<string, number>();
  if (collectedEvents.length > 0) {
    // Historical-flow upgrade for user clicks (mirror YouTube/IG): if the walk
    // reached deeper than the prior frontier, the click is historical.
    if (
      flow === "incremental" &&
      triggerUserId &&
      deepestWalked !== null &&
      oldestFetchedOccurredAt !== null &&
      oldestFetchedOccurredAt.getTime() < deepestWalked.getTime()
    ) {
      flow = "historical";
    }

    // Bulk idempotency pre-check (one SELECT). CROSS-TENANT BY DESIGN — fan-out
    // dedup spans subscribers via inArray on userId/sourceId.
    const externalIds = collectedEvents.map((e) => e.externalId);
    const userIds = subscribers.map((s) => s.userId);
    const sourceIds = subscribers.map((s) => s.id);
    const existing = await db
      .select({
        userId: events.userId,
        sourceId: events.sourceId,
        externalId: events.externalId,
      })
      .from(events)
      .where(
        and(
          inArray(events.userId, userIds),
          inArray(events.sourceId, sourceIds),
          inArray(events.externalId, externalIds),
          sql`${events.kind} = 'tiktok_post'`,
          isNotNull(events.externalId),
          isNull(events.deletedAt),
        ),
      );
    const existingSet = new Set<string>();
    for (const r of existing) {
      if (r.externalId) existingSet.add(`${r.userId}|${r.sourceId}|${r.externalId}`);
    }

    for (const ev of collectedEvents) {
      for (const sub of subscribers) {
        if (sub.backfillTargetSince && ev.occurredAt < sub.backfillTargetSince) continue;
        const isTriggerUser = triggerUserId === sub.userId;
        if (flow === "auto_passive") {
          if (!sub.autoImport) continue;
        } else if (!isTriggerUser && !sub.autoImport) {
          continue;
        }
        const dedupKey = `${sub.userId}|${sub.id}|${ev.externalId}`;
        if (existingSet.has(dedupKey)) continue;

        // sourceId set so the post lands in the inbox (zero attached games).
        // onConflictDoNothing — race-safe against parallel walks.
        const inserted = await db
          .insert(events)
          .values({
            userId: sub.userId,
            sourceId: sub.id,
            kind: "tiktok_post",
            authorIsMe: sub.isOwnedByMe,
            occurredAt: ev.occurredAt,
            title: ev.title,
            url: ev.url,
            externalId: ev.externalId,
            metadata: ev.metadata ?? {},
          })
          .onConflictDoNothing()
          .returning({ id: events.id });
        if (inserted.length > 0) {
          insertedTotal += 1;
          insertedByUser.set(sub.userId, (insertedByUser.get(sub.userId) ?? 0) + 1);
        }
      }
    }
  }

  // 6. Persist state. BUDGET-01 producer: the account-level operator-budget-paused
  //    hint. SET when this tick was paused on a refused page reserve (AdapterError
  //    operator-issue | rate-limited); CLEARED when a tick completes without a
  //    budget pause (budget restored) so the badge is not sticky.
  state.operatorPaused = pausedByBudget;

  // Account-level complete = the single feed exhausted AND not paused mid-budget.
  const accountComplete = !pausedByBudget && state.complete;

  // SELF-ENQUEUE the next page of a bounded DEEP backfill (initial / historical)
  // so a multi-page archive completes promptly. The cursor write + the continuation
  // intent commit ATOMICALLY via the outbox in the SAME transaction (AGENTS.md
  // atomic-dual-write — never boss.send outside a state-mutating tx).
  //
  // Enqueue ONLY when ALL hold (mirror IG):
  //   - branch === "deep"            the resumable historical/initial walk that
  //                                  RESUMES from the persisted cursor. The
  //                                  incremental / exhausted branches reset to page
  //                                  1 each tick (new-only sweep) and a continuation
  //                                  there would re-fetch page 1 forever.
  //   - !accountComplete             the feed NOT yet exhausted → real work left.
  //   - !pausedByBudget              a budget pause means the next reserve would be
  //                                  refused too — let cron retry after the reset.
  //   - state.collected < maxPosts   the BACK-01 post-count cap bounds historical
  //                                  depth (belt-and-suspenders).
  const shouldContinue =
    branch === "deep" && !accountComplete && !pausedByBudget && state.collected < maxPosts;
  await db.transaction(async (tx) => {
    await writeTikTokBackfillState(channelKey, state, tx);
    if (shouldContinue) {
      await enqueueViaOutbox(
        tx,
        QUEUES.TIKTOK_BACKFILL_ACCOUNT,
        {
          kind: KIND,
          channelKey,
          // triggerUserId OMITTED — continuation pages run on the cron pool
          // (Pitfall 5: the trigger user pays the per-user cap ONCE on the first
          // page; subsequent pages free-ride).
          depthBoundIso: job.data.depthBoundIso,
          flow,
          forceDeep: job.data.forceDeep,
        },
        { singletonKey: `backfill-account-${channelKey}` },
      );
    }
  });
  if (branch === "deep" && oldestFetchedOccurredAt !== null) {
    // Frontier = the oldest event this deep walk fetched. markChannelBackfillFrontier
    // WHERE-guards the deeper-only move, so a shallower write never rolls it back.
    const frontier = oldestFetchedOccurredAt;
    if (
      channelState?.backfillOldestAt == null ||
      frontier.getTime() < channelState.backfillOldestAt.getTime()
    ) {
      await markChannelBackfillFrontier(KIND, channelKey, frontier);
    }
  }

  if (accountComplete) {
    await markChannelBackfillComplete(KIND, channelKey);
  }
  await markChannelLastPolledAt(KIND, channelKey);

  // Successful walk proves upstream healthy — clear needs_reconnect on all subs.
  for (const sub of subscribers) {
    try {
      await clearNeedsReconnect(sub.userId, sub.id);
    } catch (err) {
      logger.warn(
        { userId: sub.userId, sourceId: sub.id, err: String((err as Error)?.message ?? err) },
        "tiktok.backfill.account: clearNeedsReconnect failed",
      );
    }
  }

  // 7. Audit — only for the trigger user (Pitfall 5: trigger pays once). Cron
  //    continuation pages enqueue with triggerUserId omitted → no audit row.
  if (triggerUserId) {
    await writeBackfillAudit({
      job,
      flow,
      channelKey,
      triggerUserId,
      requestsUsed,
      eventsInserted: insertedByUser.get(triggerUserId) ?? 0,
      sinceBranch: branch,
    });
  }

  logger.info(
    {
      jobId: job.id,
      channelKey,
      flow,
      triggerUserId: triggerUserId ?? null,
      subscribers: subscribers.length,
      candidates: collectedEvents.length,
      insertedTotal,
      requestsUsed,
      collected: state.collected,
      accountComplete,
      pausedByBudget,
    },
    "tiktok.backfill.account: tick complete",
  );
}

/** All subscribers to one account_id share the canonical handle; read it from any
 *  active subscriber's metadata. */
function resolveHandle(subscribers: Array<{ metadata: unknown }>): string | null {
  for (const sub of subscribers) {
    const handle = (sub.metadata as { handle?: string } | null)?.handle;
    if (typeof handle === "string" && handle !== "") return handle;
  }
  return null;
}

/** Date-window boundary. Deep branch walks toward the historical target. The
 *  incremental/exhausted branches sweep only what is newer than the frontier
 *  (BACK-03 — never deeper). */
function computeDateWindowSince(
  branch: "exhausted" | "incremental" | "deep",
  target: Date,
  deepestWalked: Date | null,
): Date {
  if (branch === "deep") return target;
  if (deepestWalked !== null && deepestWalked.getTime() > target.getTime()) return deepestWalked;
  return target;
}

async function writeBackfillAudit(args: {
  job: BackfillAccountJob;
  flow: BackfillFlow;
  channelKey: string;
  triggerUserId: string;
  requestsUsed: number;
  eventsInserted: number;
  sinceBranch: "exhausted" | "incremental" | "deep";
}): Promise<void> {
  // STRICT — the per-user-cap counter (getUserQuotaUsedToday) sums requests_used
  // from this row; a swallowed insert silently undercounts user usage. The
  // EXISTING source.refresh_content_requested verb + flow/platform tags so the same
  // cross-source cap counter applies (Pitfall 5: trigger pays once).
  //
  // platform = the SOURCE KIND ("tiktok_account"), NOT the social-budget label
  // "tiktok" — this row feeds the USER-QUOTA keyspace (getUserQuotaUsedToday /
  // quota-read.ts loadQuotaPlatforms read by adapter.kind). IG tags the twin row
  // "instagram_account" for the same reason; "tiktok" here would make the quota
  // banner read 0 forever (it queries by "tiktok_account").
  await writeAuditStrict({
    userId: args.triggerUserId,
    action: "source.refresh_content_requested",
    ipAddress: "0.0.0.0",
    metadata: {
      kind: KIND,
      platform: KIND,
      channel_key: args.channelKey,
      flow: args.flow,
      queue: "tiktok.backfill.account",
      job_id: args.job.id ?? null,
      requests_used: args.requestsUsed,
      events_inserted: args.eventsInserted,
      since_branch: args.sinceBranch,
    },
  });
}
