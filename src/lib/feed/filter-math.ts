// Pure filter predicates + predicted-count helpers (Plan 03.4-02 Task 3;
// Plan 03.4-10 game-axis multi-select refactor).
//
// passes() / countWith*() port the prototype's
// docs/design/v2/ui-kit/app.jsx lines 1352-1409 — the v1 React state was
// React-local; v2 routes the same shape through `FilterState` from
// url-state.js so the URL is the single source of truth.
//
// GAME axis (Plan 03.4-10) — `FilterState.gameTags: string[]` is a flat
// multi-select where entries are EITHER game IDs OR the OFF_TOPIC_TAG
// sentinel. An event passes the GAME axis when:
//   - gameTags is empty (no filter), OR
//   - the event is attached to ANY game id in gameTags, OR
//   - "off_topic" ∈ gameTags AND the event's metadata.triage.offTopic is true.
// Mirror of the server SQL clause in src/lib/server/services/events.ts.
//
// diffGameStates ports the GamesPicker tri-state apply contract
// (app.jsx lines 880-920). Three states per game:
//   - "on"    → add to event if not already attached
//   - "off"   → remove from event if currently attached
//   - "mixed" → leave alone (mass-edit across heterogeneous events; user
//               hasn't touched this row so we must not overwrite per-event
//               decisions)
//
// `FilterableEvent` is a minimal interface. The wider EventDto exported by
// src/lib/server/dto.ts is structurally assignable to it (gameIds always
// present after mapEventsToDtos's batch-load step) so callers pass DTOs
// directly without an adapter layer.

import { OFF_TOPIC_TAG, type FilterState } from "./url-state.js";
import { dateInRange } from "./date-range.js";
import {
  EVENT_KIND_MEDIA_CATEGORY,
  postMediaKindToCategory,
  type MediaTypeCategory,
  type PostMediaKind,
} from "./media-type-filter.js";
import type { EventKind } from "$lib/sources/adapter.js";

export interface FilterableEvent {
  id: string;
  kind: string;
  occurred_at: string | Date;
  title?: string | null;
  notes?: string | null;
  author_is_me?: boolean;
  gameIds: string[];
  metadata?: { triage?: { offTopic?: boolean } } | null;
  // Per-post media kind from the platform cache enrichment (instagram_post /
  // tiktok_post). Drives the MEDIA-TYPE axis classification for the per-post
  // kinds. Absent / null → the event falls into "other" (matches the server's
  // missing-cache-row → "other" rule, so client predicted-counts agree with
  // the server's honest pagination).
  instagramEnrichment?: { mediaType?: string | null } | null;
  tiktokEnrichment?: { mediaType?: string | null } | null;
  // Twitter per-post media kind from twitter_posts.media_type ("video" |
  // "image" | "text", D-06). Like IG/TikTok: a missing / NULL value → "other"
  // ('image' / 'text' both classify to "other"; only 'video' → video).
  twitterEnrichment?: { mediaType?: string | null } | null;
  // YouTube per-post media kind from youtube_videos.media_type. Differs from
  // IG/TikTok: a missing / NULL value → "video" (a YouTube video is a video at
  // worst — Shorts detection heals NULLs lazily; never demoted to "other").
  youtubeEnrichment?: { mediaType?: string | null } | null;
}

/**
 * Classify one event into a MEDIA-TYPE category (Short / Video / Other),
 * mirroring the server SQL filter in events-query.ts. Per-post kinds
 * (instagram_post / tiktok_post) consult the enrichment media kind; a missing /
 * unrecognized media row → "other" (no event vanishes from all three
 * categories). Every other kind uses its kind-level default from
 * EVENT_KIND_MEDIA_CATEGORY. Pure — exported for the unit partition test.
 */
export function eventMediaCategory(e: FilterableEvent): MediaTypeCategory {
  const classification = EVENT_KIND_MEDIA_CATEGORY[e.kind as EventKind];
  // Unknown kind (widened string) → other, matching the server default.
  if (classification === undefined) return "other";
  if (classification !== "per-post") return classification;
  // youtube_video has a DIFFERENT per-post default: 'short' → short, but a
  // missing / NULL / unrecognized media_type → "video" (never "other"). Mirrors
  // the server SQL youtube arm (short = EXISTS media_type='short'; video = the
  // NOT-EXISTS-short complement). Lazily-classified NULLs default to Video.
  if (e.kind === "youtube_video") {
    return e.youtubeEnrichment?.mediaType === "short" ? "short" : "video";
  }
  // IG / TikTok / Twitter per-post kind — read the cache media kind off the
  // matching enrichment; missing / unrecognized → "other". Twitter's vocabulary
  // is 'video' | 'image' | 'text' (no 'short'); 'video' → video, the rest → other.
  const raw =
    e.kind === "instagram_post"
      ? e.instagramEnrichment?.mediaType
      : e.kind === "tiktok_post"
        ? e.tiktokEnrichment?.mediaType
        : e.kind === "twitter_post"
          ? e.twitterEnrichment?.mediaType
          : null;
  if (
    raw === "short" ||
    raw === "video" ||
    raw === "image" ||
    raw === "carousel" ||
    raw === "text"
  ) {
    return postMediaKindToCategory(raw as PostMediaKind);
  }
  // Missing / unrecognized cache row → other (mirrors the server NOT EXISTS arm).
  return "other";
}

export function passes(e: FilterableEvent, state: FilterState, today: Date): boolean {
  // 1a. SHOW axis (narrowed to any | inbox after Plan 03.4-10). Inbox =
  // "no triage decision yet" = zero attached games. Off-topic + per-game
  // selection moved to the orthogonal GAME axis (state.gameTags).
  if (state.show.kind === "inbox" && (e.gameIds?.length ?? 0) > 0) return false;
  if (state.show.kind === "inbox" && e.metadata?.triage?.offTopic === true) {
    // An event explicitly marked off-topic has been triaged — the user has
    // said "this is not related to any game". It does NOT belong in the
    // inbox awaiting triage. Mirrors the server SQL clause.
    return false;
  }

  // 1b. GAME axis — multi-select with off_topic sentinel (Plan 03.4-10).
  // Empty list = no filter. Otherwise an event passes when it's attached
  // to ANY game in the list OR (when "off_topic" is in the list) its
  // triage.offTopic flag is true. OR semantics across the union.
  if (state.gameTags.length > 0) {
    const wantsOffTopic = state.gameTags.includes(OFF_TOPIC_TAG);
    const gameIdsFilter = state.gameTags.filter((t) => t !== OFF_TOPIC_TAG);
    const matchesGame = gameIdsFilter.some((gid) => e.gameIds.includes(gid));
    const matchesOffTopic = wantsOffTopic && e.metadata?.triage?.offTopic === true;
    if (!matchesGame && !matchesOffTopic) return false;
  }

  // 2. kind axis — non-empty array = restrict
  if (state.kind.length > 0 && !state.kind.includes(e.kind as (typeof state.kind)[number])) {
    return false;
  }

  // 2b. MEDIA-TYPE axis (Short / Video / Other) — non-empty array = restrict to
  // events whose media category is in the selection. Each event classifies into
  // exactly one category, so the three categories PARTITION the feed (selecting
  // all three === no filter). Mirrors the server SQL clause in events-query.ts.
  if (state.mediaType.length > 0 && !state.mediaType.includes(eventMediaCategory(e))) {
    return false;
  }

  // 3. author axis — undefined = anyone, true = mine, false = others
  if (state.authorIsMe === true && !e.author_is_me) return false;
  if (state.authorIsMe === false && e.author_is_me) return false;

  // 4. date axis
  if (!dateInRange(e.occurred_at, state.dateRange, today)) return false;

  // 5. query axis — case-insensitive title + notes
  if (state.query.trim()) {
    const q = state.query.trim().toLowerCase();
    const titleHit = (e.title ?? "").toLowerCase().includes(q);
    const notesHit = (e.notes ?? "").toLowerCase().includes(q);
    if (!titleHit && !notesHit) return false;
  }

  return true;
}

/**
 * countWithGame — predicted count if `tag` were the SOLE selection in the
 * GAME axis (other axes preserved). `tag` is either a game id OR the
 * OFF_TOPIC_TAG sentinel. Mirrors prototype app.jsx line 1403:
 *   `passes(e, { ...currentState, game: [v] })`
 * The chip count answers "if I had ONLY this chip active, how many?" —
 * NOT "if I added this to the current selection". Union semantics would
 * make every chip show the same OR-total once any chip is active.
 */
export function countWithGame(
  events: FilterableEvent[],
  tag: string,
  state: FilterState,
  today: Date,
): number {
  const next: FilterState = {
    ...state,
    gameTags: [tag],
  };
  return events.filter((e) => passes(e, next, today)).length;
}

/**
 * countWithKind — predicted count if `kind` were the SOLE selection in
 * the KIND axis (other axes preserved). Same single-tag semantics as
 * countWithGame.
 */
export function countWithKind(
  events: FilterableEvent[],
  kind: string,
  state: FilterState,
  today: Date,
): number {
  const next: FilterState = {
    ...state,
    kind: [kind as (typeof state.kind)[number]],
  };
  return events.filter((e) => passes(e, next, today)).length;
}

/**
 * countWithMediaType — predicted count if `category` were the SOLE selection in
 * the MEDIA-TYPE axis (other axes preserved). Same single-tag semantics as
 * countWithKind / countWithGame.
 */
export function countWithMediaType(
  events: FilterableEvent[],
  category: MediaTypeCategory,
  state: FilterState,
  today: Date,
): number {
  const next: FilterState = {
    ...state,
    mediaType: [category],
  };
  return events.filter((e) => passes(e, next, today)).length;
}

/**
 * countWithShow — predicted count for SHOW axis variants. After Plan
 * 03.4-10 the union narrowed to `any | inbox` (off-topic + per-game moved
 * to the GAME axis). The `"any"` variant counts every event that passes
 * the rest of the state with show.kind set to "any"; `"inbox"` counts
 * inbox-eligible events (zero attached games AND not off-topic).
 */
export function countWithShow(
  events: FilterableEvent[],
  variant: "any" | "inbox",
  state: FilterState,
  today: Date,
): number {
  const next: FilterState = {
    ...state,
    show: { kind: variant },
  };
  return events.filter((e) => passes(e, next, today)).length;
}

export function countWithAuthor(
  events: FilterableEvent[],
  variant: "anyone" | "mine" | "others",
  state: FilterState,
  today: Date,
): number {
  const next: FilterState = {
    ...state,
    authorIsMe: variant === "mine" ? true : variant === "others" ? false : undefined,
  };
  return events.filter((e) => passes(e, next, today)).length;
}

/**
 * diffGameStates — bulk-edit GamesPicker apply contract (D-12).
 *
 * Tri-state semantics:
 *   - on    → add if not in existing
 *   - off   → remove if in existing
 *   - mixed → leave alone (no diff entry)
 *
 * Returns { toAdd, toRemove } so the caller (Wave 1 bulkEdit service) can
 * apply diffs to N events in one transaction.
 */
export function diffGameStates(
  gameStates: Record<string, "on" | "off" | "mixed">,
  existingGameIds: string[],
): { toAdd: string[]; toRemove: string[] } {
  const existingSet = new Set(existingGameIds);
  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const [gid, state] of Object.entries(gameStates)) {
    if (state === "on" && !existingSet.has(gid)) toAdd.push(gid);
    else if (state === "off" && existingSet.has(gid)) toRemove.push(gid);
    // mixed = noop
  }
  return { toAdd, toRemove };
}
