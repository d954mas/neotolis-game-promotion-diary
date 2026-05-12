import type { PageServerLoad } from "./$types";
import { env } from "$lib/server/config/env.js";

// Public /about route.
//
// SUPPORT_EMAIL + DOMAIN injected from server-side load. DOMAIN gates
// the canonical-instance link — empty in self-host / CI / dev so the
// link only appears on the canonical author-instance.

export const load: PageServerLoad = async ({ parent }) => {
  // Pull user from layout via parent() so the page can hide/show the
  // "Sign in with Google" CTA based on auth state.
  const parentData = await parent();
  return {
    supportEmail: env.SUPPORT_EMAIL,
    domain: env.DOMAIN,
    user: parentData.user,
  };
};
