import type { PageServerLoad } from "./$types";
import { redirect } from "@sveltejs/kit";

/**
 * /settings/account → 301 redirect to /settings.
 *
 * Phase 02.2 originally split account-management UI (Export + Delete) into
 * a separate `/settings/account` route. UAT feedback: the page was
 * undiscoverable from `/settings`, and splitting "Account info" from
 * "Account actions" across two URLs confused users.
 *
 * The Export + Delete UI moved INTO `/settings` (the existing Account
 * block). This route preserves the old URL as a 301 redirect so any
 * external bookmarks / links the operator shared still land on the right
 * page.
 */
export const load: PageServerLoad = async () => {
  throw redirect(301, "/settings");
};
