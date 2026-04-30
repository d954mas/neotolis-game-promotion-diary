// Plan 02.1-39 (UAT-NOTES.md §5.6): shared helper for the human-facing
// source-kind label (e.g. "YouTube channel" / "Reddit account"). Extracted
// from SourceRow.svelte's inline kindLabel function so SourceRow and
// FiltersSheet resolve to the same wording — single source of truth for
// the round-6 kind-glyph + label pattern that lands in FiltersSheet's
// source list. Mirrors the shape of the `m.source_kind_label_*` Paraglide
// keys (Plan 02.1-08), one entry per data_sources.kind enum value.

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
