import { describe, it, expect } from "vitest";
import {
  passes,
  countWithGame,
  countWithKind,
  countWithShow,
  countWithAuthor,
  diffGameStates,
  type FilterableEvent,
} from "../../src/lib/feed/filter-math.js";
import type { FilterState } from "../../src/lib/feed/url-state.js";

/**
 * Pure filter predicates + predicted-count helpers (Plan 03.4-02 Task 3).
 *
 * passes() / countWith*() port the prototype's
 * docs/design/v2/ui-kit/app.jsx lines 1352-1409. diffGameStates ports the
 * GamesPicker tri-state apply contract (app.jsx lines 880-920) for the
 * Wave 1 bulkEdit service.
 */

const TODAY = new Date(2026, 4, 15); // May 15, 2026

function baseState(): FilterState {
  return {
    show: { kind: "any" },
    source: [],
    kind: [],
    authorIsMe: undefined,
    dateRange: { preset: "all" },
    sortDir: "desc",
    query: "",
    view: "feed",
    openEventId: null,
  };
}

function ev(overrides: Partial<FilterableEvent> = {}): FilterableEvent {
  return {
    id: "ev_default",
    kind: "youtube_video",
    occurred_at: "2026-05-15",
    title: "Default title",
    notes: null,
    author_is_me: true,
    gameIds: [],
    metadata: null,
    ...overrides,
  };
}

describe("passes — show axis", () => {
  it("returns true on default state for any plausible event", () => {
    expect(passes(ev(), baseState(), TODAY)).toBe(true);
  });

  it("returns false when show.kind === 'inbox' AND event has gameIds", () => {
    const state = { ...baseState(), show: { kind: "inbox" as const } };
    expect(passes(ev({ gameIds: ["g1"] }), state, TODAY)).toBe(false);
    expect(passes(ev({ gameIds: [] }), state, TODAY)).toBe(true);
  });

  it("returns false when show.kind === 'standalone' AND event metadata.triage.offTopic !== true", () => {
    const state = { ...baseState(), show: { kind: "standalone" as const } };
    expect(passes(ev({ metadata: null }), state, TODAY)).toBe(false);
    expect(passes(ev({ metadata: { triage: { offTopic: false } } }), state, TODAY)).toBe(false);
    expect(passes(ev({ metadata: { triage: { offTopic: true } } }), state, TODAY)).toBe(true);
  });

  it("returns false when show.kind === 'specific' AND event has none of show.gameIds", () => {
    const state = { ...baseState(), show: { kind: "specific" as const, gameIds: ["g1", "g2"] } };
    expect(passes(ev({ gameIds: ["g3"] }), state, TODAY)).toBe(false);
    expect(passes(ev({ gameIds: ["g1"] }), state, TODAY)).toBe(true);
    expect(passes(ev({ gameIds: ["g1", "g3"] }), state, TODAY)).toBe(true);
  });
});

describe("passes — kind axis", () => {
  it("returns false when kind array non-empty AND event.kind not in kind", () => {
    const state = { ...baseState(), kind: ["reddit_post" as const] };
    expect(passes(ev({ kind: "youtube_video" }), state, TODAY)).toBe(false);
    expect(passes(ev({ kind: "reddit_post" }), state, TODAY)).toBe(true);
  });

  it("treats empty kind array as 'no filter'", () => {
    expect(passes(ev({ kind: "youtube_video" }), { ...baseState(), kind: [] }, TODAY)).toBe(true);
  });
});

describe("passes — author axis", () => {
  it("returns false when authorIsMe === true AND event.author_is_me === false", () => {
    const state = { ...baseState(), authorIsMe: true };
    expect(passes(ev({ author_is_me: false }), state, TODAY)).toBe(false);
    expect(passes(ev({ author_is_me: true }), state, TODAY)).toBe(true);
  });

  it("returns false when authorIsMe === false AND event.author_is_me === true", () => {
    const state = { ...baseState(), authorIsMe: false };
    expect(passes(ev({ author_is_me: true }), state, TODAY)).toBe(false);
    expect(passes(ev({ author_is_me: false }), state, TODAY)).toBe(true);
  });
});

describe("passes — date axis", () => {
  it("returns false when dateRange has explicit window and event outside", () => {
    const state: FilterState = {
      ...baseState(),
      dateRange: { preset: "custom", from: "2026-04-01", to: "2026-04-30" },
    };
    expect(passes(ev({ occurred_at: "2026-05-15" }), state, TODAY)).toBe(false);
    expect(passes(ev({ occurred_at: "2026-04-15" }), state, TODAY)).toBe(true);
  });
});

describe("passes — query axis (case-insensitive title/notes)", () => {
  it("returns true when title contains query (case-insensitive)", () => {
    const state = { ...baseState(), query: "REDDIT" };
    expect(passes(ev({ title: "Reddit launch", notes: null }), state, TODAY)).toBe(true);
  });

  it("returns true when notes contains query", () => {
    const state = { ...baseState(), query: "launch" };
    expect(passes(ev({ title: "Other", notes: "We did a launch" }), state, TODAY)).toBe(true);
  });

  it("returns false when neither title nor notes contains query", () => {
    const state = { ...baseState(), query: "youtube" };
    expect(passes(ev({ title: "Other", notes: "Different" }), state, TODAY)).toBe(false);
  });

  it("ignores empty / whitespace-only query (no filter)", () => {
    expect(passes(ev({ title: "Anything" }), { ...baseState(), query: "   " }, TODAY)).toBe(true);
  });
});

describe("countWithGame — predicted facet counter", () => {
  const events: FilterableEvent[] = [
    ev({ id: "e1", gameIds: ["g1"] }),
    ev({ id: "e2", gameIds: ["g2"] }),
    ev({ id: "e3", gameIds: ["g1", "g2"] }),
    ev({ id: "e4", gameIds: [] }), // inbox
  ];

  it("returns count of events that would pass after toggling show=specific[g1]", () => {
    // e1 has g1, e3 has g1 → 2 matching events
    expect(countWithGame(events, "g1", baseState(), TODAY)).toBe(2);
  });

  it("merges into an existing show.specific list (union)", () => {
    const state: FilterState = {
      ...baseState(),
      show: { kind: "specific", gameIds: ["g2"] },
    };
    // After adding g1: show.specific gameIds = [g2, g1] (union)
    // Events matching at least one: e1 (g1), e2 (g2), e3 (g1+g2) → 3
    expect(countWithGame(events, "g1", state, TODAY)).toBe(3);
  });
});

describe("countWithKind — predicted facet counter", () => {
  const events: FilterableEvent[] = [
    ev({ id: "e1", kind: "youtube_video" }),
    ev({ id: "e2", kind: "reddit_post" }),
    ev({ id: "e3", kind: "twitter_post" }),
  ];

  it("returns predicted count if user adds kind to filter", () => {
    expect(countWithKind(events, "reddit_post", baseState(), TODAY)).toBe(1);
  });
});

describe("countWithShow — predicted facet counter", () => {
  const events: FilterableEvent[] = [
    ev({ id: "e1", gameIds: ["g1"] }),
    ev({ id: "e2", gameIds: [] }), // inbox
    ev({ id: "e3", gameIds: [], metadata: { triage: { offTopic: true } } }),
  ];

  it("returns count for each show variant", () => {
    expect(countWithShow(events, "any", baseState(), TODAY)).toBe(3);
    expect(countWithShow(events, "inbox", baseState(), TODAY)).toBe(2); // e2, e3 both inbox
    expect(countWithShow(events, "standalone", baseState(), TODAY)).toBe(1); // only e3
  });
});

describe("countWithAuthor — predicted facet counter", () => {
  const events: FilterableEvent[] = [
    ev({ id: "e1", author_is_me: true }),
    ev({ id: "e2", author_is_me: false }),
    ev({ id: "e3", author_is_me: true }),
  ];

  it("returns count for each author variant", () => {
    expect(countWithAuthor(events, "anyone", baseState(), TODAY)).toBe(3);
    expect(countWithAuthor(events, "mine", baseState(), TODAY)).toBe(2);
    expect(countWithAuthor(events, "others", baseState(), TODAY)).toBe(1);
  });
});

describe("diffGameStates — bulk-edit tri-state apply contract", () => {
  it("returns toAdd for 'on' state when gameId not in existing", () => {
    const diff = diffGameStates({ g1: "on", g2: "on" }, ["g1"]);
    expect(diff.toAdd).toEqual(["g2"]);
    expect(diff.toRemove).toEqual([]);
  });

  it("returns toRemove for 'off' state when gameId in existing", () => {
    const diff = diffGameStates({ g1: "off", g2: "off" }, ["g1"]);
    expect(diff.toAdd).toEqual([]);
    expect(diff.toRemove).toEqual(["g1"]);
  });

  it("returns {toAdd: [], toRemove: []} when all states are 'mixed'", () => {
    const diff = diffGameStates({ g1: "mixed", g2: "mixed" }, ["g1"]);
    expect(diff.toAdd).toEqual([]);
    expect(diff.toRemove).toEqual([]);
  });

  it("is idempotent: 'on' for a gameId already in existing returns toAdd: []", () => {
    const diff = diffGameStates({ g1: "on" }, ["g1"]);
    expect(diff.toAdd).toEqual([]);
    expect(diff.toRemove).toEqual([]);
  });

  it("handles mixed bag: { g1:on, g2:off, g3:mixed, g4:on } with existing [g2, g3]", () => {
    const diff = diffGameStates({ g1: "on", g2: "off", g3: "mixed", g4: "on" }, ["g2", "g3"]);
    expect(diff.toAdd.sort()).toEqual(["g1", "g4"]);
    expect(diff.toRemove).toEqual(["g2"]);
  });
});
