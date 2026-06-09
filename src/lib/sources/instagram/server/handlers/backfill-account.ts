// instagram.backfill.account queue handler — the account-scoped resumable
// walker (mirror of youtube handleBackfillChannel, with the IG divergences).
//
// One walk-step per tick; fan-out INSERT to ALL active subscribers of the
// account.
//
// IG DIVERGENCES (08-RESEARCH §Pattern 2 + §Pitfalls, encoded here):
//   - channelKey = the resolved IG account_id (NEVER the user-pasted handle —
//     handles rename; account_id is intrinsic). Lives on data_sources.metadata.
//     accountId; the walker reads the handle from metadata.handle only as the
//     provider query param.
//   - BOTH feeds (posts + reels) are walked, each its own cursor stream +
//     end-of-feed sub-state (a reel-only account must not complete because the
//     posts feed ended). Account-level backfill_complete = both sub-feeds
//     exhausted. The uniform ProviderPage.nextCursor hides the
//     next_max_id (posts) vs paging_info.max_id (reels) divergence (Plan 02).
//   - ONE page PER FEED per tick (BACK-02). The running collected-count is
//     persisted across ticks (BACK-01): the walk stops when collected >=
//     SOCIAL_BACKFILL_MAX_POSTS OR a post.publishedAt < since (date window),
//     whichever first — cost is independent of archive size.
//   - Pitfall 4: a missing/private handle returns an empty first page on a
//     brand-new source → markSourceNeedsReconnect not_found (resolveTier shows
//     unavailable); do NOT mark backfill_complete (that would silently swallow a
//     typo'd handle). The HTTP-404 mapping in http.ts is the primary signal; the
//     empty-first-page heuristic is the belt-and-suspenders fallback.
//   - Pitfall 5: the trigger user pays the per-user cap ONCE per user action
//     (one writeAuditStrict row tagged with the flow); continuation pages run on
//     the CRON pool (triggerUserId omitted) — same user-pays-once model as
//     YouTube/Reddit.
//   - BUDGET-02: each page reserves operator credits BEFORE the provider call
//     (inside the provider HTTP seam via ctx.origin). A null permit surfaces as
//     an AdapterError(operator-issue | rate-limited) here → stop this tick and
//     persist the cursor for resume (pausable/throttled).

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
import { instagramAccountAdapterCore as adapter, type InstagramFeed } from "../adapter.js";
import { upsertInstagramAccount } from "../snapshots.js";
import { readInstagramBackfillState, writeInstagramBackfillState } from "../backfill-state.js";
import { env } from "$lib/server/config/env.js";
import { AdapterError } from "$lib/sources/errors.js";
import type { RawEvent, SourceKind } from "$lib/sources/adapter.js";

type BackfillFlow = "initial" | "incremental" | "historical" | "auto_passive";

interface BackfillAccountJob {
  id?: string;
  data: {
    kind: SourceKind;
    /** The resolved IG account_id (the channelKey). */
    channelKey: string;
    /** UserId who triggered this walk. Undefined for cron — the trigger user
     *  pays the per-user cap; cron continuation pages run on the cron pool. */
    triggerUserId?: string;
    /** Walk depth target — earliest publishedAt to walk to. ISO 8601. */
    depthBoundIso: string;
    flow: BackfillFlow;
    /** Force a deep walk regardless of the three-branch since-derivation
     *  (set by resetWalkerStateOnWidening). */
    forceDeep?: boolean;
  };
}

const KIND = "instagram_account" as const;
const FEEDS: InstagramFeed[] = ["posts", "reels"];

export async function handleBackfillAccount(job: BackfillAccountJob): Promise<void> {
  const { channelKey, triggerUserId } = job.data;
  const kind = job.data.kind;
  let flow: BackfillFlow = job.data.flow ?? "auto_passive";

  if (typeof channelKey !== "string" || typeof kind !== "string") {
    logger.warn(
      { jobId: job.id, payload: job.data },
      "instagram.backfill.account: malformed payload (missing kind/channelKey); skipping",
    );
    return;
  }
  if (kind !== KIND) {
    logger.warn({ jobId: job.id, kind }, "instagram.backfill.account: unsupported kind; skipping");
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
      "instagram.backfill.account: no active subscribers — account orphaned; skipping",
    );
    return;
  }

  // The provider query handle. All subscribers to one account_id share the same
  // canonical handle; read it off any active subscriber's metadata.
  const handle = resolveHandle(subscribers);
  if (handle === null) {
    logger.warn(
      { jobId: job.id, channelKey },
      "instagram.backfill.account: no handle on any subscriber metadata; skipping",
    );
    return;
  }

  // 2. Channel state + since derivation (three-branch, mirror YouTube).
  const channelState = await getChannelState(KIND, channelKey);
  const wasNeverPolled = channelState === undefined || channelState.lastPolledAt === null;

  const target = new Date(job.data.depthBoundIso);
  if (Number.isNaN(target.getTime())) {
    logger.warn(
      { jobId: job.id, depthBoundIso: job.data.depthBoundIso },
      "instagram.backfill.account: invalid depthBoundIso; skipping",
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

  // Incremental/exhausted branches DO NOT walk deeper (BACK-03): they fetch page
  // 1 of each feed only (cursor reset to null) to discover new posts since the
  // frontier, and the date-window `since` is the frontier (newest known), not
  // the historical target. Deep / forceDeep resume from the persisted cursor and
  // walk toward the historical `target`.
  const incrementalBranch = branch !== "deep";
  const dateWindowSince = computeDateWindowSince(branch, target, deepestWalked);

  // Read (or reset) the resumable sub-state. Incremental/exhausted branches
  // start each feed at page 1 (cursor null) but keep the running count semantic
  // reset to 0 (a fresh new-only sweep is unbounded by the historical cap).
  let state = readInstagramBackfillState(channelState);
  if (incrementalBranch) {
    state = {
      posts: { cursor: null, complete: false },
      reels: { cursor: null, complete: false },
      collected: 0,
      // Carry the prior paused flag — a successful (unpaused) tick below clears
      // it; a re-paused tick re-sets it. Resetting it to false here would make
      // the badge flicker off mid-pause on every incremental sweep.
      operatorPaused: state.operatorPaused,
    };
  }

  const maxPosts = env.SOCIAL_BACKFILL_MAX_POSTS;
  const origin: "cron" | "user" = triggerUserId ? "user" : "cron";

  // 3. Walk ONE page per feed this tick. Accumulate events + count; stop a feed
  //    when it ends, when a post is past the date window, or when the post-count
  //    cap is hit (deep branch only — the cap bounds historical depth).
  const collectedEvents: RawEvent[] = [];
  let requestsUsed = 0;
  let oldestFetchedOccurredAt: Date | null = null;
  let pausedByBudget = false;

  for (const feed of FEEDS) {
    const feedState = state[feed];
    if (feedState.complete) continue;
    // Post-count cap only bounds the deep/historical walk (BACK-01). The
    // incremental new-only sweep is naturally bounded by the date window.
    if (branch === "deep" && state.collected >= maxPosts) {
      // Cap reached — treat this feed as exhausted for completion purposes.
      feedState.complete = true;
      continue;
    }

    let page;
    try {
      page = await adapter.pollContent(
        {
          id: channelKey,
          userId: triggerUserId ?? channelKey,
          metadata: { handle, accountId: channelKey },
        },
        dateWindowSince,
        { origin, feed, cursor: feedState.cursor },
      );
    } catch (err) {
      if (err instanceof AdapterError) {
        if (err.category === "rate-limited" || err.category === "operator-issue") {
          // Budget paused (null permit) OR throttled — stop this tick and
          // persist the cursor for resume. Do NOT advance / complete.
          logger.info(
            { jobId: job.id, channelKey, feed, category: err.category },
            "instagram.backfill.account: budget/throttle pause — persisting cursor for resume",
          );
          pausedByBudget = true;
          break;
        }
        if (err.category === "not-found") {
          // Missing/private handle (HTTP 404). Flag every subscriber's source
          // so resolveTier shows unavailable; do NOT mark complete.
          for (const sub of subscribers) {
            await markSourceNeedsReconnect(sub.userId, sub.id, "not-found");
          }
          await markChannelLastPolledAt(KIND, channelKey);
          logger.info(
            { jobId: job.id, channelKey, feed },
            "instagram.backfill.account: 404 not_found — sources flagged unavailable",
          );
          return;
        }
        // transient / permanent → rethrow for pg-boss retry / dead-letter.
        throw err;
      }
      throw err;
    }

    requestsUsed += page.unitsUsed;

    // Opportunistically refresh the account subject entity (instagram_accounts)
    // from the FREE feed owner object the page already carries — NO extra credit.
    // The richer profile fields (avatar / follower_count) were set by the PAID
    // create-time resolve and are COALESCE-preserved here; this cheap refresh only
    // keeps account_id + the current @handle (+ avatar when the owner carries one)
    // fresh, appending a renamed handle to handle_aliases. Anchor on the feed
    // owner's id, falling back to the channelKey (= the account_id) so a feed that
    // omits the owner id still refreshes the row. Best-effort: a failed write must
    // not abort the walk.
    if (page.owner !== null) {
      const ownerAccountId = page.owner.accountId ?? channelKey;
      try {
        await upsertInstagramAccount({
          accountId: ownerAccountId,
          username: page.owner.username,
          avatarUrl: page.owner.avatarUrl,
        });
      } catch (err) {
        logger.warn(
          { jobId: job.id, channelKey, feed, err: String((err as Error)?.message ?? err) },
          "instagram.backfill.account: instagram_accounts UPSERT from feed owner failed (non-fatal)",
        );
      }
    }

    // Date-window bound: collect posts newer than the window boundary; stop the
    // feed the moment we cross below it (the page is newest-first).
    let crossedWindow = false;
    for (const ev of page.events) {
      if (ev.occurredAt.getTime() < dateWindowSince.getTime()) {
        crossedWindow = true;
        break;
      }
      collectedEvents.push(ev);
      state.collected += 1;
      if (oldestFetchedOccurredAt === null || ev.occurredAt < oldestFetchedOccurredAt) {
        oldestFetchedOccurredAt = ev.occurredAt;
      }
      // Post-count cap (deep branch): stop collecting the moment we hit it.
      if (branch === "deep" && state.collected >= maxPosts) {
        crossedWindow = true;
        break;
      }
    }

    // Advance / complete this feed.
    feedState.cursor = page.nextCursor;
    if (page.endOfFeed || crossedWindow || page.nextCursor === null) {
      feedState.complete = true;
    }
    state[feed] = feedState;
  }

  // 4. Pitfall 4 — empty first page on a brand-new source = probable bad/private
  //    handle. No events, no requests collected anything, every feed reports
  //    end-of-feed with no cursor on the very first poll → not_found, NOT
  //    complete.
  if (
    wasNeverPolled &&
    !pausedByBudget &&
    collectedEvents.length === 0 &&
    requestsUsed > 0 &&
    FEEDS.every((f) => state[f].complete && state[f].cursor === null)
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
      "instagram.backfill.account: empty first page on new source — flagged not_found (Pitfall 4)",
    );
    return;
  }

  // 5. Fan-out INSERT for each subscriber. Per (event × subscriber): skip if
  //    occurredAt < subscriber.target_since; auto_passive skips non-auto_import
  //    subscribers; user flows let the trigger user override their own opt-out.
  let insertedTotal = 0;
  const insertedByUser = new Map<string, number>();
  if (collectedEvents.length > 0) {
    // Detect historical-flow upgrade for user clicks (mirror YouTube): if the
    // walk reached deeper than the prior frontier, the click is historical.
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
          sql`${events.kind} = 'instagram_post'`,
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

        // sourceId set so the post lands in the inbox (zero attached games,
        // VIZ-05). onConflictDoNothing — race-safe against parallel walks.
        const inserted = await db
          .insert(events)
          .values({
            userId: sub.userId,
            sourceId: sub.id,
            kind: "instagram_post",
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

  // 6. Persist state. Advance the channel frontier (deep-mode walks only — an
  //    incremental new-only sweep doesn't deepen the historical floor).
  //
  //    BUDGET-01 producer: the account-level operator-budget-paused hint. SET
  //    when this tick was paused because the operator's prepaid social budget /
  //    daily-cap throttle refused a page reserve (AdapterError operator-issue |
  //    rate-limited, caught above); CLEARED when a tick completes without a
  //    budget pause (budget restored / topped up) so the badge is not sticky.
  //    Lives on the channel-state row (source of truth) — the read side
  //    (feed-enrichment) overlays it onto each IG event DTO's
  //    metadata.operator_paused, which the PollingBadge consumes.
  state.operatorPaused = pausedByBudget;

  // Account-level complete = BOTH feeds exhausted AND not paused mid-budget.
  // Computed BEFORE the state write so the continuation gate below can read it
  // inside the same transaction.
  const accountComplete = !pausedByBudget && FEEDS.every((f) => state[f].complete);

  // SELF-ENQUEUE the next page of a bounded DEEP backfill (initial / historical)
  // so a multi-page archive completes promptly instead of crawling one page per
  // 6h cron tick. The cursor write + the continuation intent commit ATOMICALLY
  // via the outbox in the SAME transaction (AGENTS.md atomic-dual-write — never
  // boss.send outside a state-mutating tx): if the worker crashes after the
  // commit, the forwarder still delivers; if it crashes before, neither lands.
  //
  // Termination is load-bearing — enqueue ONLY when ALL hold:
  //   - branch === "deep"            the resumable historical/initial walk that
  //                                  RESUMES from the persisted cursor (strictly
  //                                  advances each tick). The incremental /
  //                                  exhausted branches reset every feed to page
  //                                  1 each tick (new-only sweep, BACK-03) and
  //                                  are bounded by the date window — a
  //                                  continuation there would re-fetch page 1
  //                                  forever (infinite loop). They are
  //                                  single-page by design and rely on cron.
  //   - !accountComplete             both feeds NOT yet exhausted → real work left.
  //   - !pausedByBudget              a budget pause means the next reserve would
  //                                  be refused too — let cron retry after the
  //                                  daily-cap reset / top-up, don't spin.
  //   - state.collected < maxPosts   the BACK-01 post-count cap bounds historical
  //                                  depth; at the cap the deep branch already
  //                                  marks feeds complete (→ accountComplete), but
  //                                  this is the explicit belt-and-suspenders stop.
  // singletonKey is a no-op for dedup on this standard-policy queue (no
  // singletonSeconds). Duplicate EVENTS are prevented by onConflictDoNothing on
  // the insert; a concurrent double-fetch's spend is bounded by the prepaid
  // ceiling (reserveSocialCredits). Kept harmless + future-proof if the policy
  // ever gains singletonSeconds.
  const shouldContinue =
    branch === "deep" && !accountComplete && !pausedByBudget && state.collected < maxPosts;
  await db.transaction(async (tx) => {
    await writeInstagramBackfillState(channelKey, state, tx);
    if (shouldContinue) {
      await enqueueViaOutbox(
        tx,
        QUEUES.INSTAGRAM_BACKFILL_ACCOUNT,
        {
          kind: KIND,
          channelKey,
          // triggerUserId OMITTED — continuation pages run on the cron pool
          // (Pitfall 5: the trigger user pays the per-user cap ONCE on the first
          // page; subsequent pages free-ride, mirroring YouTube/Reddit).
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
        "instagram.backfill.account: clearNeedsReconnect failed",
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
    "instagram.backfill.account: tick complete",
  );
}

/** All subscribers to one account_id share the canonical handle; read it from
 *  any active subscriber's metadata. */
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
  // Incremental / exhausted — only fetch newer than the prior frontier.
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
  // EXISTING source.refresh_content_requested verb + flow/platform tags so the
  // same cross-source cap counter applies (Pitfall 5: trigger pays once).
  await writeAuditStrict({
    userId: args.triggerUserId,
    action: "source.refresh_content_requested",
    ipAddress: "0.0.0.0",
    metadata: {
      kind: KIND,
      platform: "instagram_account",
      channel_key: args.channelKey,
      flow: args.flow,
      queue: "instagram.backfill.account",
      job_id: args.job.id ?? null,
      requests_used: args.requestsUsed,
      events_inserted: args.eventsInserted,
      since_branch: args.sinceBranch,
    },
  });
}
