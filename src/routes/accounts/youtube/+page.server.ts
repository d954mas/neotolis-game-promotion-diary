import type { PageServerLoad } from "./$types";
import { listChannels } from "$lib/server/services/youtube-channels.js";
import { toYoutubeChannelDto } from "$lib/server/dto.js";

/**
 * /accounts/youtube loader — list the caller's YouTube channels (Plan 02-10).
 *
 * Channels live at user level (NOT game-bound) per D-24 — this list is the
 * SaaS-wide view; per-game attachment lives on the game-detail page.
 *
 * Direct service call (NOT fetch('/api/...')): the API and the page render
 * in the same Node process, so an HTTP roundtrip back to Hono would
 * deadlock SvelteKit's internal_fetch (Hono routes don't live in
 * SvelteKit's route tree — see post-execution P0 fix in SUMMARY).
 * `listChannels` enforces tenant scope; `toYoutubeChannelDto` strips
 * `userId` per P3 discipline.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) return { channels: [] };
  const rows = await listChannels(locals.user.id);
  return { channels: rows.map(toYoutubeChannelDto) };
};
