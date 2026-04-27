// YouTube Channels service — GAMES-04a (the typed-per-platform social-handle pattern).
//
// Channels live at user level (NOT cascaded by game soft-delete per D-24): one
// developer typically reuses the same "own" channel across multiple games and
// the same blogger's channel surfaces across many games' coverage lists.
// Cascading would force re-creating channel rows on every restore.
//
// `gameYoutubeChannels` is the M:N link table. It IS soft-cascaded with games
// (the link expresses "this channel is associated with this specific game") so
// a game-restore brings back its channel associations.
//
// `findOwnChannelByHandle` (INGEST-03) is the resolver Plan 02-06's
// `services/items-youtube.ts` calls during URL ingest: when the user pastes a
// YouTube video URL, we extract the author handle, then look up whether the
// caller has registered an `is_own=true` channel for that handle. Match → the
// new tracked-video row gets `is_own=true`. No match → `is_own=false`
// (blogger coverage). Pitfall 3 / Option C in RESEARCH.md.
//
// NO audit entries from this service (D-32): channel CRUD + the M:N attach
// don't carry a security-relevant verb in the audit enum. Theme-style toggles
// (`is_own`) are UI-only flags; pasting a channel URL is metadata.

import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { youtubeChannels } from "../db/schema/youtube-channels.js";
import { gameYoutubeChannels } from "../db/schema/game-youtube-channels.js";
import { getGameById } from "./games.js";
import { AppError, NotFoundError } from "./errors.js";

export type YoutubeChannelRow = typeof youtubeChannels.$inferSelect;

export interface CreateChannelInput {
  handleUrl: string;
  channelId?: string | null;
  displayName?: string | null;
  isOwn?: boolean;
}

// Accepts both forms documented in schema/youtube-channels.ts:
//   - https://youtube.com/@handle  (or www.youtube.com/@handle)
//   - https://youtube.com/channel/UC...
const HANDLE_URL_RE =
  /^https?:\/\/(?:www\.)?youtube\.com\/(?:@[A-Za-z0-9._-]+|channel\/UC[A-Za-z0-9_-]+)\/?$/;

function validateHandleUrl(url: string): void {
  if (!HANDLE_URL_RE.test(url)) {
    throw new AppError(
      "handleUrl must be https://youtube.com/@handle or /channel/UC<id>",
      "validation_failed",
      422,
    );
  }
}

/**
 * Create a user-level YouTube channel record. UNIQUE(user_id, handle_url)
 * prevents the same caller from registering the same channel twice — the
 * raw pg duplicate-key error surfaces; Plan 02-08 maps it to 409.
 */
export async function createChannel(
  userId: string,
  input: CreateChannelInput,
): Promise<YoutubeChannelRow> {
  validateHandleUrl(input.handleUrl);
  const [row] = await db
    .insert(youtubeChannels)
    .values({
      userId,
      handleUrl: input.handleUrl,
      channelId: input.channelId ?? null,
      displayName: input.displayName ?? null,
      isOwn: input.isOwn ?? false,
    })
    .returning();
  if (!row) throw new Error("createChannel: INSERT returned no row");
  return row;
}

/**
 * List the caller's user-level channels (all of them — own + blogger).
 * Used by the channels settings page (Plan 02-10).
 */
export async function listChannels(userId: string): Promise<YoutubeChannelRow[]> {
  return db.select().from(youtubeChannels).where(eq(youtubeChannels.userId, userId));
}

/**
 * Attach a channel to a game (M:N link). Asserts both ends belong to the
 * caller before inserting (defense in depth — the FK constraint would
 * also catch cross-tenant attempts but as a 23503 not a clean 404).
 *
 * UNIQUE(game_id, channel_id) on the link table prevents duplicate
 * attachments; Plan 02-08 maps the duplicate-key error to 409.
 */
export async function attachToGame(
  userId: string,
  gameId: string,
  channelId: string,
): Promise<void> {
  await getGameById(userId, gameId);
  const channelRows = await db
    .select({ id: youtubeChannels.id })
    .from(youtubeChannels)
    .where(and(eq(youtubeChannels.userId, userId), eq(youtubeChannels.id, channelId)))
    .limit(1);
  if (channelRows.length === 0) throw new NotFoundError();

  await db.insert(gameYoutubeChannels).values({
    userId,
    gameId,
    channelId,
  });
}

/**
 * Remove a channel from a game (hard-deletes the link row — the underlying
 * channel is untouched). NotFoundError on miss / cross-tenant.
 */
export async function detachFromGame(
  userId: string,
  gameId: string,
  channelId: string,
): Promise<void> {
  const result = await db
    .delete(gameYoutubeChannels)
    .where(
      and(
        eq(gameYoutubeChannels.userId, userId),
        eq(gameYoutubeChannels.gameId, gameId),
        eq(gameYoutubeChannels.channelId, channelId),
      ),
    )
    .returning({ id: gameYoutubeChannels.id });
  if (result.length === 0) throw new NotFoundError();
}

/**
 * List channels associated with a game (only active links — soft-deleted
 * link rows are filtered out so a soft-deleted game doesn't appear to
 * still own its channels). Asserts ownership of the parent game.
 */
export async function listChannelsForGame(
  userId: string,
  gameId: string,
): Promise<YoutubeChannelRow[]> {
  await getGameById(userId, gameId);
  const rows = await db
    .select({
      id: youtubeChannels.id,
      userId: youtubeChannels.userId,
      handleUrl: youtubeChannels.handleUrl,
      channelId: youtubeChannels.channelId,
      displayName: youtubeChannels.displayName,
      isOwn: youtubeChannels.isOwn,
      createdAt: youtubeChannels.createdAt,
      updatedAt: youtubeChannels.updatedAt,
    })
    .from(gameYoutubeChannels)
    .innerJoin(youtubeChannels, eq(gameYoutubeChannels.channelId, youtubeChannels.id))
    .where(
      and(
        eq(gameYoutubeChannels.userId, userId),
        eq(gameYoutubeChannels.gameId, gameId),
        eq(youtubeChannels.userId, userId),
      ),
    );
  return rows;
}

/**
 * Toggle the `is_own` flag on a channel. UI-only flag; no audit row.
 * NotFoundError on miss / cross-tenant.
 */
export async function toggleIsOwn(
  userId: string,
  channelId: string,
  isOwn: boolean,
): Promise<YoutubeChannelRow> {
  const [row] = await db
    .update(youtubeChannels)
    .set({ isOwn, updatedAt: new Date() })
    .where(and(eq(youtubeChannels.userId, userId), eq(youtubeChannels.id, channelId)))
    .returning();
  if (!row) throw new NotFoundError();
  return row;
}

/**
 * INGEST-03 own/blogger resolver — called from `services/items-youtube.ts`
 * (Plan 02-06) during YouTube URL ingest. Returns the user-level channel
 * row that has `handle_url === handleUrl` AND `is_own=true`, or null.
 *
 * The caller uses the result to set `tracked_youtube_videos.is_own`:
 * match → true (own video), null → false (blogger coverage).
 */
export async function findOwnChannelByHandle(
  userId: string,
  handleUrl: string,
): Promise<YoutubeChannelRow | null> {
  const rows = await db
    .select()
    .from(youtubeChannels)
    .where(
      and(
        eq(youtubeChannels.userId, userId),
        eq(youtubeChannels.handleUrl, handleUrl),
        eq(youtubeChannels.isOwn, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
