import type { PageServerLoad } from "./$types";
import { loadSourcesPage, type SourcesPageData } from "$lib/server/services/sources-page-read.js";
import { buildKindMatrix, type KindMatrixEntry } from "$lib/sources/kind-matrix.js";
import { env } from "$lib/server/config/env.js";

// AddSourceModal + the /sources/new fallback share ONE kindMatrix, derived in
// `buildKindMatrix` from FUNCTIONAL_KINDS / KIND_STATUS + per-adapter
// isOperatorConfigured (F1 — no two-file literal duplication). The URL-first
// surfaces read the not-configured state off the matrix entry's disabledReason,
// so no separate redditOperatorConfigured / instagramConfigured flag is shipped
// (it would be a second source of truth).
export type { KindMatrixEntry };

export interface SourcesPageLoadData extends SourcesPageData {
  view: "feed" | "trash";
  defaultIsOwnedByMe: boolean;
  defaultAutoImport: boolean;
  socialBackfillMaxPosts: number;
  kindMatrix: KindMatrixEntry[];
}

/**
 * /sources loader — thin composition layer. Active-list DB work lives in
 * `loadSourcesPage`; the AddSourceModal supplementary data (kindMatrix +
 * Reddit-configured probe) is computed inline since it's a tiny derivation
 * with no I/O cost. Anonymous viewers get an empty page (the auth-gated
 * layout handles the redirect; this is defense in depth).
 */
export const load: PageServerLoad = async ({ locals, url }): Promise<SourcesPageLoadData> => {
  const view = url.searchParams.get("view") === "trash" ? "trash" : ("feed" as const);
  // BACK-01: surface the post-cap ceiling so the BackfillPicker honesty note
  // ("Up to N most-recent posts within this window") reads the true value the
  // walker enforces, not a hard-coded literal.
  const socialBackfillMaxPosts = env.SOCIAL_BACKFILL_MAX_POSTS;
  // Single derived matrix — same call the /sources/new loader makes (F1). The
  // Reddit/Instagram not-configured state lives on each entry's disabledReason.
  const kindMatrix: KindMatrixEntry[] = buildKindMatrix();

  if (!locals.user) {
    return {
      view,
      active: [],
      deleted: [],
      quotaPlatforms: [],
      redditQuota: { isOperatorConfigured: false },
      cooldownBySource: {},
      pullingBySource: {},
      defaultIsOwnedByMe: true,
      defaultAutoImport: true,
      socialBackfillMaxPosts,
      kindMatrix,
    };
  }
  const sources = await loadSourcesPage(locals.user.id);
  return {
    ...sources,
    view,
    defaultIsOwnedByMe: true,
    defaultAutoImport: true,
    socialBackfillMaxPosts,
    kindMatrix,
  };
};
