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

export interface FilterableEvent {
  id: string;
  kind: string;
  occurred_at: string | Date;
  title?: string | null;
  notes?: string | null;
  author_is_me?: boolean;
  gameIds: string[];
  metadata?: { triage?: { offTopic?: boolean } } | null;
}

export function passes(e: FilterableEvent, state: FilterState, today: Date): boolean {
  // 1a. SHOW axis (narrowed to any | inbox after Plan 03.4-10). Inbox =
  // "no triage decision yet" = zero attached games. Off-topic + per-game
  // selection moved to the orthogonal GAME axis (state.gameTags).
  if (state.show.kind === "inbox" && (e.gameIds?.length ?? 0) > 0) return false;
  if (
    state.show.kind === "inbox" &&
    e.metadata?.triage?.offTopic === true
  ) {
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
 * countWithGame — predicted count if the user toggles `tag` ON in the GAME
 * axis. `tag` is either a game id OR the OFF_TOPIC_TAG sentinel; the
 * function unions the new tag into `state.gameTags` (dedup via Set) and
 * runs the filter pipeline. Mirrors the prototype's per-chip count tail
 * (app.jsx lines 1352-1409) where each game / off-topic chip predicts the
 * size of its result set.
 */
export function countWithGame(
  events: FilterableEvent[],
  tag: string,
  state: FilterState,
  today: Date,
): number {
  const next: FilterState = {
    ...state,
    gameTags: Array.from(new Set([...state.gameTags, tag])),
  };
  return events.filter((e) => passes(e, next, today)).length;
}

export function countWithKind(
  events: FilterableEvent[],
  kind: string,
  state: FilterState,
  today: Date,
): number {
  const next: FilterState = {
    ...state,
    kind: Array.from(new Set([...state.kind, kind as (typeof state.kind)[number]])),
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
