// Telegram feed-event materialization.
//
// Phase 9 originally cached imported posts in telegram_posts / _snapshots ONLY
// (no events) — but that left telegram channels behaving differently from every
// other auto-import source: YouTube / Reddit / Instagram all INSERT an `events`
// row per imported post (source_id set) so the post surfaces in /feed, counts on
// /sources, and drives the per-event chart. This module closes that gap: it
// turns the parsed posts from a listing-poll / backfill page into feed events,
// exactly mirroring the IG/Reddit fan-out (instagram backfill-account.ts /
// reddit sub-poll.ts).
//
// The snapshot cache (telegram_posts) still owns the view-count time-series; the
// event is the feed item that references it (events.external_id = post_id, the
// same key telegramFetchEventMetricSeries / telegramEnrichFeedDtos read).
//
// Fan-out: a service poll (userId null — the cron lane serves every subscriber
// from one fetch) creates an event per auto-import subscriber of the channel;
// a user-triggered poll / backfill (userId set) targets just that user's source.
// Dedup is the (user_id, kind, source_id, external_id) partial unique on events.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { dataSources } from "$lib/server/db/schema/data-sources.js";
import { events } from "$lib/server/db/schema/events.js";
import { logger } from "$lib/server/logger.js";
import type { ParsedTelegramPost } from "./parse.js";

const TELEGRAM_BASE = "https://t.me";

/** Create feed events from imported telegram posts. Returns the number of new
 *  event rows inserted (0 when everything was already present / filtered out). */
export async function materializeTelegramEvents(
  channel: string,
  posts: readonly ParsedTelegramPost[],
  opts: { userId?: string | null },
): Promise<number> {
  if (posts.length === 0) return 0;

  // Channel subscribers. A user-triggered poll/backfill targets only that
  // user's source; a service poll fans out to every auto-import subscriber of
  // the channel (cross-tenant by design — a telegram_channel has no single
  // owning user; the events INSERT below pins user_id per subscriber row).
  const subscribers = await db
    .select({
      id: dataSources.id,
      userId: dataSources.userId,
      isOwnedByMe: dataSources.isOwnedByMe,
      backfillTargetSince: dataSources.backfillTargetSince,
    })
    .from(dataSources)
    .where(
      and(
        eq(dataSources.kind, "telegram_channel"),
        sql`${dataSources.metadata}->>'channel' = ${channel}`,
        eq(dataSources.autoImport, true),
        isNull(dataSources.deletedAt),
        ...(opts.userId != null ? [eq(dataSources.userId, opts.userId)] : []),
      ),
    );
  if (subscribers.length === 0) return 0;

  // Bulk idempotency pre-check (one SELECT). inArray(userId) carries the tenant
  // filter; the multi-tenant span is the channel fan-out (mirrors reddit/IG).
  const externalIds = posts.map((p) => p.externalId);
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
        eq(events.kind, "telegram_post"),
        isNull(events.deletedAt),
      ),
    );
  const existingSet = new Set(existing.map((r) => `${r.userId}|${r.sourceId}|${r.externalId}`));

  type EventInsert = typeof events.$inferInsert;
  const candidates: EventInsert[] = [];
  for (const post of posts) {
    // publishedAt is the post's t.me <time> (the user-meaningful timestamp);
    // a missing one is rare — fall back to now so the row still surfaces.
    const occurredAt = post.publishedAt ?? new Date();
    const snippet = post.textSnippet.trim();
    const title = snippet !== "" ? snippet.slice(0, 200) : `Telegram post ${post.externalId}`;
    const url = `${TELEGRAM_BASE}/${post.externalId}`;
    for (const sub of subscribers) {
      // Per-subscriber backfill window (chosen at /sources/new time).
      if (sub.backfillTargetSince !== null && occurredAt < sub.backfillTargetSince) continue;
      if (existingSet.has(`${sub.userId}|${sub.id}|${post.externalId}`)) continue;
      candidates.push({
        userId: sub.userId,
        sourceId: sub.id,
        // You own the channel ⇒ you authored every post (no per-post author on
        // a telegram channel, unlike a reddit subreddit).
        authorIsMe: sub.isOwnedByMe,
        kind: "telegram_post",
        occurredAt,
        title,
        url,
        externalId: post.externalId,
        metadata: { channel },
      });
    }
  }

  if (candidates.length === 0) return 0;
  const inserted = await db
    .insert(events)
    .values(candidates)
    .onConflictDoNothing()
    .returning({ id: events.id });
  if (inserted.length > 0) {
    logger.debug(
      { channel, created: inserted.length, userId: opts.userId ?? null },
      "telegram: materialized feed events from imported posts",
    );
  }
  return inserted.length;
}
