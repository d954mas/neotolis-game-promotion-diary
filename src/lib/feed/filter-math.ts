// Pure filter predicates + predicted-count helpers (Plan 03.4-02 Task 3).
//
// passes() / countWith*() port the prototype's
// docs/design/v2/ui-kit/app.jsx lines 1352-1409 — the v1 React state was
// React-local; v2 routes the same shape through `FilterState` from
// url-state.js so the URL is the single source of truth.
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

import type { FilterState } from "./url-state.js";
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
  // 1. show axis — inbox (no games), standalone (triage flag), specific (any-of)
  if (state.show.kind === "inbox" && (e.gameIds?.length ?? 0) > 0) return false;
  if (state.show.kind === "standalone" && e.metadata?.triage?.offTopic !== true) return false;
  if (state.show.kind === "specific") {
    if (!state.show.gameIds.some((gid) => e.gameIds.includes(gid))) return false;
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

export function countWithGame(
  events: FilterableEvent[],
  gameId: string,
  state: FilterState,
  today: Date,
): number {
  const nextGameIds =
    state.show.kind === "specific"
      ? Array.from(new Set([...state.show.gameIds, gameId]))
      : [gameId];
  const next: FilterState = {
    ...state,
    show: { kind: "specific", gameIds: nextGameIds },
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

export function countWithShow(
  events: FilterableEvent[],
  variant: "any" | "inbox" | "standalone",
  state: FilterState,
  today: Date,
): number {
  const next: FilterState = {
    ...state,
    show: { kind: variant } as FilterState["show"],
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
