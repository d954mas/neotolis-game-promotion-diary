import type { PageServerLoad } from "./$types.js";
import { redirect } from "@sveltejs/kit";

/**
 * Root `/` server loader (Plan 02.1-07).
 *
 * Authenticated users → 303 redirect to /feed (the new primary daily
 * workspace per Phase 2.1 default-route swap, RESEARCH §3.6 + ROADMAP
 * Phase 2.1 success criterion #4). The Phase 2 dashboard placeholder
 * (rendered by `+page.svelte` for `data.user`) is fully retired by this
 * server-side redirect — the dashboard markup never reaches the browser
 * for signed-in users.
 *
 * Anonymous users → fall through (no redirect). The Phase 1 marketing
 * placeholder rendered by `+page.svelte` for `!data.user` carries forward
 * unchanged — sign-in CTA + welcome copy.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user) {
    throw redirect(303, "/feed");
  }
  return {};
};
