// eventKindToSourceKind — bridge between EventKind and SourceKind.
//
// Events carry an EventKind (`youtube_video`, `reddit_post`, ...). The
// per-kind UI registry is keyed by SourceKind (`youtube_channel`,
// `reddit_account`, ...). The /feed page passes event.kind through this
// helper to resolve the SourceKind, then calls
// getAdapterUI(sourceKind).toCardProps(event).
//
// Free-form kinds (`post`, `conference`, `talk`, `press`, `other`) and
// the discord case which has no v0.1 polling path return null. Callers
// that get null fall back to a generic CardProps mapper (currently
// inline in the rendering component; future polish can centralize it).
import type { EventKind, SourceKind } from "./adapter.js";

export function eventKindToSourceKind(eventKind: EventKind): SourceKind | null {
  switch (eventKind) {
    case "youtube_video":
      return "youtube_channel";
    case "reddit_post":
      return "reddit_account";
    case "twitter_post":
      return "twitter_account";
    case "telegram_post":
      return "telegram_channel";
    case "discord_drop":
      return "discord_server";
    // Free-form / non-pollable kinds — no source kind to dispatch to.
    case "post":
      return null;
    case "conference":
      return null;
    case "talk":
      return null;
    case "press":
      return null;
    case "other":
      return null;
  }
}

/** Reverse mapping — used by the /events/new generic preview flow to set
 *  event.kind after the adapter has confirmed the URL is one of its own.
 *  Returns null for source kinds that don't have a 1:1 event kind (Reddit
 *  has two source kinds → one event kind; this picks reddit_post for
 *  both reddit_account and reddit_subreddit by convention). */
export function sourceKindToEventKind(sourceKind: SourceKind): EventKind | null {
  switch (sourceKind) {
    case "youtube_channel":
      return "youtube_video";
    case "reddit_account":
      return "reddit_post";
    case "reddit_subreddit":
      return "reddit_post";
    case "twitter_account":
      return "twitter_post";
    case "telegram_channel":
      return "telegram_post";
    case "discord_server":
      return "discord_drop";
  }
}
