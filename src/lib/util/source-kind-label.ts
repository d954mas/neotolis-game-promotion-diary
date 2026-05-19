// Shared helper for the human-facing source-kind label (e.g.
// "YouTube channel" / "Reddit account"). Single source of truth used by
// SourceRow and FiltersSheet so they resolve to the same wording. Mirrors
// the shape of the `m.source_kind_label_*` Paraglide keys, one entry per
// data_sources.kind enum value.

import { m } from "$lib/paraglide/messages.js";

export type SourceKind =
  | "youtube_channel"
  | "reddit_account"
  | "reddit_subreddit"
  | "twitter_account"
  | "telegram_channel"
  | "discord_server";

export function sourceKindLabel(k: SourceKind): string {
  switch (k) {
    case "youtube_channel":
      return m.source_kind_label_youtube_channel();
    case "reddit_account":
      return m.source_kind_label_reddit_account();
    case "reddit_subreddit":
      // Paraglide key for "Reddit subreddit" is added by Phase 03.1 plan 08
      // (UI extensions). Until then, fall back to the reddit_account label
      // so this branch returns a sensible string instead of `undefined`. The
      // string-coverage is satisfied by the existing key; the dedicated key
      // (`source_kind_label_reddit_subreddit`) lands with the new-source UI
      // additions.
      return m.source_kind_label_reddit_account();
    case "twitter_account":
      return m.source_kind_label_twitter_account();
    case "telegram_channel":
      return m.source_kind_label_telegram_channel();
    case "discord_server":
      return m.source_kind_label_discord_server();
  }
}
