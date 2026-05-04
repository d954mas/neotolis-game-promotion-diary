import type { PageServerLoad } from "./$types.js";
import { redirect } from "@sveltejs/kit";

/**
 * Root `/` server loader.
 *
 * Authenticated users → 303 redirect to /feed (the primary daily workspace
 * per Phase 2.1 default-route swap, RESEARCH §3.6).
 *
 * Anonymous users → 303 redirect to /about (post-deploy fix #5 — issue
 * #14 follow-up). /about is now the discovery hub: rich product
 * description + Sign in CTA + links to /privacy and /terms. This replaces
 * the Phase 1 placeholder that lived at `/` for anonymous; the marketing
 * surface lives at /about so search engines can index it under a stable
 * URL and the homepage doesn't carry product-marketing content that
 * search engines were unsure how to rank.
 */
export const load: PageServerLoad = async ({ locals }) => {
  if (locals.user) {
    throw redirect(303, "/feed");
  }
  throw redirect(303, "/about");
};
