import type { PageServerLoad } from "./$types";
import { loadSourcesPage, type SourcesPageData } from "$lib/server/services/sources-page-read.js";

/**
 * /sources loader — thin composition layer. All DB work + cross-source
 * aggregation lives in `loadSourcesPage`. Anonymous viewers get an empty
 * page (the auth-gated layout handles the redirect; this is defense in
 * depth).
 */
export const load: PageServerLoad = async ({ locals }): Promise<SourcesPageData> => {
  if (!locals.user) {
    return {
      active: [],
      deleted: [],
      quotaPlatforms: [],
      redditQuota: { isOperatorConfigured: false },
      cooldownBySource: {},
      pullingBySource: {},
    };
  }
  return loadSourcesPage(locals.user.id);
};
