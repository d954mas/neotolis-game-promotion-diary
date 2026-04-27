// tracked_youtube_videos service — INGEST-02 / INGEST-03 / INGEST-04 backend.
//
// Pattern 1 (tenant scope): EVERY function takes `userId: string` first;
// EVERY Drizzle query .where()-clauses on `eq(trackedYoutubeVideos.userId, userId)`.
// The custom ESLint rule `tenant-scope/no-unfiltered-tenant-query` (Plan
// 02-02) fires on any query that omits this filter — disable comments are
// NOT allowed here.
//
// INGEST-03 own/blogger auto-decision (D-21, Pitfall 3 Option C):
//   The orchestrator (services/ingest.ts) hands us oEmbed.author_url (the
//   handle URL like https://www.youtube.com/@RickAstleyYT). We delegate to
//   `findOwnChannelByHandle(userId, authorUrl)` (services/youtube-channels.ts);
//   match → tracked_youtube_videos.is_own = true, no match → false. The user
//   can later flip the flag via toggleIsOwn (UI affordance).
//
// INGEST-04 / D-19 validate-first: this service ASSUMES the orchestrator
// already validated via fetchYoutubeOembed. We do not retry the oEmbed call
// here. Cross-tenant gameId is checked via getGameById defense-in-depth.
//
// Audit (D-32): item.created on INSERT, item.deleted on softDeleteItem.
// toggleIsOwn does NOT audit (UI flag, low forensic value — D-32 reserves
// audit verbs for security-relevant ops).

import { and, eq, isNull, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import { trackedYoutubeVideos } from "../db/schema/tracked-youtube-videos.js";
import { writeAudit } from "../audit.js";
import { getGameById } from "./games.js";
import { findOwnChannelByHandle } from "./youtube-channels.js";
import { AppError, NotFoundError } from "./errors.js";

export type TrackedVideoRow = typeof trackedYoutubeVideos.$inferSelect;

export interface CreateTrackedYoutubeVideoInput {
  gameId: string;
  videoId: string;
  /** Canonical URL from parser (https://www.youtube.com/watch?v=<id>). */
  url: string;
  /** From oEmbed; null when oEmbed succeeded with empty title (rare). */
  title: string | null;
  /** Pitfall 3 Option C: keep null in Phase 2; match on author_url instead. */
  channelId: string | null;
  /** From oEmbed.author_url; drives INGEST-03 own/blogger lookup. Null only if oEmbed shape was missing. */
  authorUrl: string | null;
}

/**
 * Create a tracked_youtube_videos row scoped to userId. Pre-flight calls
 * `getGameById` so cross-tenant gameId surfaces as NotFoundError (404)
 * BEFORE any INSERT — defense in depth even though the FK would also
 * reject. The Postgres UNIQUE(user_id, video_id) constraint prevents the
 * same caller from registering the same video twice; we catch the 23505
 * unique-violation and rethrow as AppError code='duplicate_item' status=409
 * so the route layer (Plan 02-08) can map cleanly without parsing pg
 * error codes.
 *
 * INGEST-03 own/blogger lookup (D-21, Pitfall 3 Option C): when authorUrl
 * is non-null, look up `youtube_channels` for a matching `is_own=true` row
 * under this user's id. Match → is_own=true, miss → is_own=false. The
 * user can flip later via toggleIsOwn.
 *
 * Audit: writes `item.created` with metadata
 *   { kind:'youtube', item_id, video_id, game_id, is_own }
 */
export async function createTrackedYoutubeVideo(
  userId: string,
  input: CreateTrackedYoutubeVideoInput,
  ipAddress: string,
): Promise<TrackedVideoRow> {
  // Defense in depth: cross-tenant gameId surfaces as 404, not as a 23503.
  await getGameById(userId, input.gameId);

  // INGEST-03 own/blogger auto-decision.
  let isOwn = false;
  if (input.authorUrl) {
    const ownChannel = await findOwnChannelByHandle(userId, input.authorUrl);
    if (ownChannel) isOwn = true;
  }

  let row: TrackedVideoRow | undefined;
  try {
    [row] = await db
      .insert(trackedYoutubeVideos)
      .values({
        userId,
        gameId: input.gameId,
        videoId: input.videoId,
        url: input.url,
        title: input.title,
        channelId: input.channelId,
        authorUrl: input.authorUrl,
        isOwn,
      })
      .returning();
  } catch (err) {
    // Postgres unique_violation (23505) on (user_id, video_id) UNIQUE.
    // Rethrow as a typed 409 so Plan 02-08's route layer can map without
    // parsing the raw pg error code.
    const pgCode = (err as { code?: string }).code;
    if (pgCode === "23505") {
      throw new AppError(
        "this video is already tracked for your account",
        "duplicate_item",
        409,
      );
    }
    throw err;
  }
  if (!row) {
    throw new Error("createTrackedYoutubeVideo: INSERT returned no row");
  }

  await writeAudit({
    userId,
    action: "item.created",
    ipAddress,
    metadata: {
      kind: "youtube",
      item_id: row.id,
      video_id: row.videoId,
      game_id: row.gameId,
      is_own: row.isOwn,
    },
  });

  return row;
}

/**
 * List tracked YouTube videos for a game (active only — soft-deleted rows
 * filtered out). Asserts game ownership for cross-tenant defense.
 */
export async function listItemsForGame(
  userId: string,
  gameId: string,
): Promise<TrackedVideoRow[]> {
  await getGameById(userId, gameId);
  return db
    .select()
    .from(trackedYoutubeVideos)
    .where(
      and(
        eq(trackedYoutubeVideos.userId, userId),
        eq(trackedYoutubeVideos.gameId, gameId),
        isNull(trackedYoutubeVideos.deletedAt),
      ),
    )
    .orderBy(desc(trackedYoutubeVideos.addedAt));
}

/**
 * Read one tracked video row scoped to userId. Throws NotFoundError on miss
 * or cross-tenant attempt (PRIV-01: 404, never 403). Soft-deleted rows are
 * treated as missing.
 */
export async function getItemById(
  userId: string,
  itemId: string,
): Promise<TrackedVideoRow> {
  const rows = await db
    .select()
    .from(trackedYoutubeVideos)
    .where(
      and(eq(trackedYoutubeVideos.userId, userId), eq(trackedYoutubeVideos.id, itemId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.deletedAt !== null) throw new NotFoundError();
  return row;
}

/**
 * Toggle the `is_own` flag on a tracked video. UI-only flag; no audit
 * (D-32 reserves audit verbs for security-relevant ops). NotFoundError on
 * miss / cross-tenant.
 */
export async function toggleIsOwn(
  userId: string,
  itemId: string,
  isOwn: boolean,
): Promise<TrackedVideoRow> {
  const [row] = await db
    .update(trackedYoutubeVideos)
    .set({ isOwn, updatedAt: new Date() })
    .where(
      and(
        eq(trackedYoutubeVideos.userId, userId),
        eq(trackedYoutubeVideos.id, itemId),
        isNull(trackedYoutubeVideos.deletedAt),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError();
  return row;
}

/**
 * Soft-delete a tracked video row. The Phase 3 purge worker will hard-
 * delete after RETENTION_DAYS (D-22). Audit `item.deleted` with metadata
 * { kind:'youtube', item_id, video_id }. Idempotency: a second call on
 * an already-deleted row throws NotFoundError (Plan 02-08 expects 404).
 */
export async function softDeleteItem(
  userId: string,
  itemId: string,
  ipAddress: string,
): Promise<void> {
  const result = await db
    .update(trackedYoutubeVideos)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(trackedYoutubeVideos.userId, userId),
        eq(trackedYoutubeVideos.id, itemId),
        isNull(trackedYoutubeVideos.deletedAt),
      ),
    )
    .returning({ id: trackedYoutubeVideos.id, videoId: trackedYoutubeVideos.videoId });
  const row = result[0];
  if (!row) throw new NotFoundError();

  await writeAudit({
    userId,
    action: "item.deleted",
    ipAddress,
    metadata: { kind: "youtube", item_id: row.id, video_id: row.videoId },
  });
}
