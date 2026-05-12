// Newest-known publishedAt cursor for the YouTube three-branch
// since-derivation.
//
// Returns MAX(youtube_videos.published_at) WHERE channel_id = $1, or null
// when the channel has no rows yet (cold start — caller falls back to the
// user's `backfillTargetSince`).
//
// Why MAX(published_at), NOT last_polled_at: backdated uploads (rare on
// YouTube, common on Telegram / Discord — and possible on YouTube when a
// creator re-publishes a private video with its original publishedAt) have
// `publishedAt` earlier than the newest collected video. Using
// MAX(published_at) as the cursor means `walkedPastSince` fires only on
// items older than the newest collected video — which is the correct
// semantic. `last_polled_at` would skip backdated uploads silently.
//
// Public-data table (no userId filter); youtube_videos is in the ESLint
// tenant-scope allowlist as a non-tenant table (snippets are public).

import { sql, eq } from "drizzle-orm";
import { db } from "$lib/server/db/client.js";
import { youtubeVideos } from "$lib/server/db/schema/index.js";

export async function getNewestKnownPublishedAt(channelKey: string): Promise<Date | null> {
  // Drizzle's `sql<Date | null>` is structural; node-postgres returns
  // aggregate results as the raw column type, but a SELECT-MAX expression
  // can lose the timestamptz tag and surface as a string. Coerce
  // defensively so callers can rely on Date semantics.
  const [row] = await db
    .select({
      maxPublishedAt: sql<Date | string | null>`MAX(${youtubeVideos.publishedAt})`,
    })
    .from(youtubeVideos)
    .where(eq(youtubeVideos.channelId, channelKey));
  const raw = row?.maxPublishedAt ?? null;
  if (raw === null) return null;
  return raw instanceof Date ? raw : new Date(raw);
}
