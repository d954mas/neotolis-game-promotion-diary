import type { PageServerLoad } from "./$types";
import { loadSourcesPage, type SourcesPageData } from "$lib/server/services/sources-page-read.js";
import { getAdapter, hasAdapter } from "$lib/sources/registry.js";
import { env } from "$lib/server/config/env.js";

// AddSourceModal needs the same kindMatrix + redditOperatorConfigured the
// fallback /sources/new route loads. Inlined here (small, single caller)
// to keep the modal a pure UI component with no extra fetches on open.
type KindLabelKey =
  | "source_kind_label_youtube_channel"
  | "source_kind_label_twitter_account"
  | "source_kind_label_telegram_channel"
  | "source_kind_label_discord_server"
  | "source_kind_label_instagram_account"
  | "common_kind_reddit";

type KindStatusKey =
  | "source_kind_status_reddit_account"
  | "source_kind_status_twitter_account"
  | "source_kind_status_telegram_channel"
  | "source_kind_status_discord_server"
  | "source_kind_status_instagram_account";

type AddSourceUiKind =
  | "youtube_channel"
  | "reddit"
  | "twitter_account"
  | "telegram_channel"
  | "discord_server"
  | "instagram_account";

// disabledReason distinguishes "adapter built, operator env unset" (Reddit
// / Instagram unconfigured → "not-configured") from "not built yet" (Twitter
// / Telegram / Discord → "not-built") so the disabled-chip tooltip is
// accurate (issue #64). null for enabled chips. MUST stay in sync with the
// /sources/new loader's kindMatrix — both feed the same AddSource UI.
type DisabledReason = "not-configured" | "not-built";

export type KindMatrixEntry = {
  value: AddSourceUiKind;
  labelKey: KindLabelKey;
  statusKey: KindStatusKey | null;
  disabled: boolean;
  disabledReason: DisabledReason | null;
};

export interface SourcesPageLoadData extends SourcesPageData {
  view: "feed" | "trash";
  defaultIsOwnedByMe: boolean;
  defaultAutoImport: boolean;
  redditOperatorConfigured: boolean;
  instagramConfigured: boolean;
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
  const redditOperatorConfigured = hasAdapter("reddit_account")
    ? getAdapter("reddit_account").observability.auth.isOperatorConfigured
    : false;
  // SOC-05: instagram_account is a FUNCTIONAL kind whose adapter is always
  // registered, but createSource gates it on the operator's provider env
  // (INSTAGRAM_PROVIDER + the provider API key). When unconfigured the chip
  // renders visible-but-disabled with the env-var hint — same shape Reddit
  // uses for an empty REDDIT_USER_AGENT. Read from the adapter's
  // isOperatorConfigured (the single source of truth, computed at read time).
  const instagramConfigured = hasAdapter("instagram_account")
    ? getAdapter("instagram_account").observability.auth.isOperatorConfigured
    : false;
  // BACK-01: surface the post-cap ceiling so the BackfillPicker honesty note
  // ("Up to N most-recent posts within this window") reads the true value the
  // walker enforces, not a hard-coded literal.
  const socialBackfillMaxPosts = env.SOCIAL_BACKFILL_MAX_POSTS;
  const kindMatrix: KindMatrixEntry[] = [
    {
      value: "youtube_channel",
      labelKey: "source_kind_label_youtube_channel",
      statusKey: null,
      disabled: false,
      disabledReason: null,
    },
    {
      value: "reddit",
      labelKey: "common_kind_reddit",
      statusKey: redditOperatorConfigured ? null : "source_kind_status_reddit_account",
      disabled: !redditOperatorConfigured,
      disabledReason: redditOperatorConfigured ? null : "not-configured",
    },
    {
      value: "instagram_account",
      labelKey: "source_kind_label_instagram_account",
      statusKey: instagramConfigured ? null : "source_kind_status_instagram_account",
      disabled: !instagramConfigured,
      disabledReason: instagramConfigured ? null : "not-configured",
    },
    {
      value: "twitter_account",
      labelKey: "source_kind_label_twitter_account",
      statusKey: "source_kind_status_twitter_account",
      disabled: true,
      disabledReason: "not-built",
    },
    {
      value: "telegram_channel",
      labelKey: "source_kind_label_telegram_channel",
      statusKey: "source_kind_status_telegram_channel",
      disabled: true,
      disabledReason: "not-built",
    },
    {
      value: "discord_server",
      labelKey: "source_kind_label_discord_server",
      statusKey: "source_kind_status_discord_server",
      disabled: true,
      disabledReason: "not-built",
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
      instagramConfigured,
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
    redditOperatorConfigured,
    instagramConfigured,
    socialBackfillMaxPosts,
    kindMatrix,
  };
};
