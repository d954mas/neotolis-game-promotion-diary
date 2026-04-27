import type { PageServerLoad } from "./$types";

/**
 * /accounts/youtube loader — list the caller's YouTube channels (Plan 02-10).
 *
 * Channels live at user level (NOT game-bound) per D-24 — this list is the
 * SaaS-wide view; per-game attachment lives on the game-detail page.
 */
export const load: PageServerLoad = async ({ fetch, parent }) => {
  const { user } = await parent();
  if (!user) return { channels: [] };

  const res = await fetch("/api/youtube-channels");
  if (!res.ok) return { channels: [] };
  return { channels: (await res.json()) as Array<unknown> };
};
