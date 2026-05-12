// Shared helper for the human-facing source-kind label (e.g.
// "YouTube channel" / "Reddit account"). Single source of truth used by
// SourceRow and FiltersSheet so they resolve to the same wording. Mirrors
// the shape of the `m.source_kind_label_*` Paraglide keys, one entry per
// data_sources.kind enum value.

import { m } from "$lib/paraglide/messages.js";

export type SourceKind =
  | "youtube_channel"
  | "reddit_account"
  | "twitter_account"
  | "telegram_channel"
  | "discord_server";

export function sourceKindLabel(k: SourceKind): string {
  switch (k) {
    case "youtube_channel":
      return m.source_kind_label_youtube_channel();
    case "reddit_account":
      return m.source_kind_label_reddit_account();
    case "twitter_account":
      return m.source_kind_label_twitter_account();
    case "telegram_channel":
      return m.source_kind_label_telegram_channel();
    case "discord_server":
      return m.source_kind_label_discord_server();
  }
}
