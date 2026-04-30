import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";
import { listGames } from "$lib/server/services/games.js";
import { toGameDto } from "$lib/server/dto.js";

/**
 * /events/new loader (Plan 02.1-09).
 *
 * Free-form event creation per CONTEXT D-09 — full-page form with the
 * 9-kind picker + game attach (optional) + occurredAt + title + url +
 * notes. The /events list page is deleted in 2.1 (UI-SPEC) so /events/new
 * is the only canonical entry point for free-form events; the paste flow
 * on /games/[id] (and Plan 07's /feed paste affordance) handles pollable
 * kinds (youtube_video / future reddit_post).
 *
 * The kind picker enables ALL 9 kinds — pollable kinds (youtube_video /
 * reddit_post) are not disabled because the service accepts them; the
 * paste flow is the FAST path while free-form is the FALLBACK. Documented
 * in SUMMARY (Plan 02.1-09 chosen path).
 *
 * Anonymous → /login (defense-in-depth; +layout.server.ts also gates).
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }
  const userId = locals.user.id;
  const gameRows = await listGames(userId);
  return {
    games: gameRows.map(toGameDto),
  };
};
