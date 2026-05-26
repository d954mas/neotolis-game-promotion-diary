import type { PageServerLoad } from "./$types";
import { loadSourcesPage, type SourcesPageData } from "$lib/server/services/sources-page-read.js";
import { getAdapter, hasAdapter } from "$lib/sources/registry.js";

// AddSourceModal needs the same kindMatrix + redditOperatorConfigured the
// fallback /sources/new route loads. Inlined here (small, single caller)
// to keep the modal a pure UI component with no extra fetches on open.
type KindLabelKey =
  | "source_kind_label_youtube_channel"
  | "source_kind_label_twitter_account"
  | "source_kind_label_telegram_channel"
  | "source_kind_label_discord_server"
  | "common_kind_reddit";

type KindStatusKey =
  | "source_kind_status_reddit_account"
  | "source_kind_status_twitter_account"
  | "source_kind_status_telegram_channel"
  | "source_kind_status_discord_server";

type AddSourceUiKind =
  | "youtube_channel"
  | "reddit"
  | "twitter_account"
  | "telegram_channel"
  | "discord_server";

export type KindMatrixEntry = {
  value: AddSourceUiKind;
  labelKey: KindLabelKey;
  statusKey: KindStatusKey | null;
  disabled: boolean;
};

export interface SourcesPageLoadData extends SourcesPageData {
  view: "feed" | "trash";
  defaultIsOwnedByMe: boolean;
  defaultAutoImport: boolean;
  redditOperatorConfigured: boolean;
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
  const redditOperatorConfigured = hasAdapter("reddit_account")
    ? getAdapter("reddit_account").observability.auth.isOperatorConfigured
    : false;
  const kindMatrix: KindMatrixEntry[] = [
    {
      value: "youtube_channel",
      labelKey: "source_kind_label_youtube_channel",
      statusKey: null,
      disabled: false,
    },
    {
      value: "reddit",
      labelKey: "common_kind_reddit",
      statusKey: redditOperatorConfigured ? null : "source_kind_status_reddit_account",
      disabled: !redditOperatorConfigured,
    },
    {
      value: "twitter_account",
      labelKey: "source_kind_label_twitter_account",
      statusKey: "source_kind_status_twitter_account",
      disabled: true,
    },
    {
      value: "telegram_channel",
      labelKey: "source_kind_label_telegram_channel",
      statusKey: "source_kind_status_telegram_channel",
      disabled: true,
    },
    {
      value: "discord_server",
      labelKey: "source_kind_label_discord_server",
      statusKey: "source_kind_status_discord_server",
      disabled: true,
    },
  ];

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
      redditOperatorConfigured,
      kindMatrix,
    };
  }
  const sources = await loadSourcesPage(locals.user.id);
  return {
    ...sources,
    view,
    defaultIsOwnedByMe: true,
    defaultAutoImport: true,
    redditOperatorConfigured,
    kindMatrix,
  };
};
