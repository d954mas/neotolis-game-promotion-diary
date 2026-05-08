import type { PageServerLoad } from "./$types";
import { listSources } from "$lib/server/services/data-sources.js";
import { toDataSourceDto } from "$lib/server/dto.js";
import { db } from "$lib/server/db/client.js";
import { youtubeChannels } from "$lib/server/db/schema/index.js";
import { inArray } from "drizzle-orm";

/**
 * /sources loader — list the caller's data_sources, partitioned active vs
 * soft-deleted (Phase 2.1 SOURCES-01 / SOURCES-02).
 *
 * Phase 3.0 post-build (UAT 2026-05-06): each row gains the YouTube channel
 * title from the youtube_channels cache so the page shows BOTH the user's
 * own label (displayName) AND the real channel name. Same pattern as the
 * /feed loader.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) return { active: [], deleted: [] };
  const all = await listSources(locals.user.id, { includeDeleted: true });
  const dtos = all.map(toDataSourceDto);

  const channelIds = dtos.map((s) => s.channelId).filter((c): c is string => c !== null);
  if (channelIds.length > 0) {
    const cache = await db
      .select({
        channelId: youtubeChannels.channelId,
        channelTitle: youtubeChannels.channelTitle,
      })
      .from(youtubeChannels)
      .where(inArray(youtubeChannels.channelId, channelIds));
    const titleByChannel = new Map<string, string | null>();
    for (const r of cache) titleByChannel.set(r.channelId, r.channelTitle);
    for (const s of dtos) {
      if (s.channelId) s.channelTitle = titleByChannel.get(s.channelId) ?? null;
    }
  }

  return {
    active: dtos.filter((s) => s.deletedAt === null),
    deleted: dtos.filter((s) => s.deletedAt !== null),
  };
};
