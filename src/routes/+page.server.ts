import type { PageServerLoad } from "./$types.js";
import { redirect } from "@sveltejs/kit";
import { env } from "$lib/server/config/env.js";
import { listNews } from "$lib/server/news.js";

/**
 * Root `/` server loader.
 *
 * Authenticated users → 303 redirect to /feed (the primary daily workspace).
 *
 * Anonymous users → render the marketing landing in-place. Previously this
 * redirected to /about, which made search engines index /about as the
 * canonical landing instead of /. Now `/` serves 200 with the same content
 * `<AboutContent>` renders on /about, and `<link rel="canonical" href="/">`
 * on both pages tells Google to pick `/` as the canonical URL.
 *
 * The data shape matches /about/+page.server.ts so AboutContent can be
 * shared between the two routes without per-page branches.
 */
export const load: PageServerLoad = async ({ locals, parent }) => {
  if (locals.user) {
    throw redirect(303, "/feed");
  }
  const parentData = await parent();
  return {
    supportEmail: env.SUPPORT_EMAIL,
    domain: env.DOMAIN,
    user: parentData.user,
    latestNews: listNews().slice(0, 3),
  };
};
