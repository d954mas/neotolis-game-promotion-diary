import { describe, it, expect } from "vitest";
import {
  parseSearchParams,
  serializeFilterState,
  OFF_TOPIC_TAG,
  type FilterState,
} from "../../src/lib/feed/url-state.js";

/**
 * URL state contract for the v2 /feed surface (Plan 03.4-02, D-02).
 *
 * `parseSearchParams(url)` consumes `URL.searchParams.getAll(...)` so multi-
 * value axes (`?source=A&source=B`) and single-value axes (`?show=inbox`)
 * normalize to a single `FilterState` discriminated union. The kind axis runs
 * through `filterValidKinds` so a malformed `?kind=foo` URL never reaches the
 * SSR loader's Drizzle `inArray` clause — silent drop matches existing
 * `/feed?show=foo` malformed-param fallback behavior (see
 * src/routes/feed/+page.server.ts).
 *
 * `serializeFilterState(state)` produces `URLSearchParams` and omits any axis
 * at its default value — so a fresh "/feed" view never carries `?show=any`,
 * `?sort=desc`, `?view=feed`, `?date=month`, `?q=`, `?event=null`, or
 * `?authorIsMe=undefined`. Round-trip identity: parse(serialize(s)) === s for
 * all reachable states. `?date=month` is the default (matches the prototype's
 * 30-day-rolling default window); `?date=all` is the explicit opt-out.
 *
 * authorIsMe is a tri-state: `true` (mine) / `false` (others) / `undefined`
 * (anyone). undefined => key omitted from the URL.
 */
describe("parseSearchParams", () => {
  it("returns show.kind === 'any' when no params are present", () => {
    const s = parseSearchParams(new URL("https://x/feed"));
    expect(s.show).toEqual({ kind: "any" });
    expect(s.source).toEqual([]);
    expect(s.kind).toEqual([]);
    expect(s.gameTags).toEqual([]);
    expect(s.authorIsMe).toBeUndefined();
    // Default preset is "month" (30-day rolling), matching the prototype
    // where the Month chip is the active default on first load.
    expect(s.dateRange).toEqual({ preset: "month" });
    expect(s.sortDir).toBe("desc");
    expect(s.query).toBe("");
    expect(s.view).toBe("feed");
    expect(s.openEventId).toBeNull();
    expect(s.cursor).toBeUndefined();
  });

  it("returns dateRange.preset === 'all' when ?date=all (the explicit opt-out of default month window)", () => {
    expect(parseSearchParams(new URL("https://x?date=all")).dateRange).toEqual({
      preset: "all",
    });
  });

  it("returns show.kind === 'inbox' when ?show=inbox", () => {
    expect(parseSearchParams(new URL("https://x?show=inbox")).show).toEqual({
      kind: "inbox",
    });
  });

  it("migrates legacy ?show=standalone to gameTags: ['off_topic'] (Plan 03.4-10 back-compat)", () => {
    // The /feed URL contract narrowed `show` to `any | inbox` and moved
    // off-topic into the flat GAME-axis multi-select. Legacy bookmarks
    // self-clean on the next URL write via serializeFilterState.
    const s = parseSearchParams(new URL("https://x?show=standalone"));
    expect(s.show).toEqual({ kind: "any" });
    expect(s.gameTags).toEqual([OFF_TOPIC_TAG]);
  });

  it("migrates legacy ?show=specific&game=g1&game=g2 to gameTags: ['g1','g2'] (Plan 03.4-10 back-compat)", () => {
    const s = parseSearchParams(new URL("https://x?show=specific&game=g1&game=g2"));
    expect(s.show).toEqual({ kind: "any" });
    expect(s.gameTags).toEqual(["g1", "g2"]);
  });

  it("parses ?game=g1&game=g2 into gameTags (new flat multi-select)", () => {
    const s = parseSearchParams(new URL("https://x?game=g1&game=g2"));
    expect(s.show).toEqual({ kind: "any" });
    expect(s.gameTags).toEqual(["g1", "g2"]);
  });

  it("parses ?game=off_topic,g1 into gameTags: ['off_topic','g1'] (comma-split shorthand)", () => {
    const s = parseSearchParams(new URL("https://x?game=off_topic,g1"));
    expect(s.gameTags).toEqual([OFF_TOPIC_TAG, "g1"]);
  });

  it("dedupes repeated ?game= entries", () => {
    const s = parseSearchParams(new URL("https://x?game=g1&game=g1&game=g2"));
    expect(s.gameTags).toEqual(["g1", "g2"]);
  });

  it("falls back to show.kind === 'any' on malformed ?show=foo (matches +page.server.ts fallback)", () => {
    expect(parseSearchParams(new URL("https://x?show=foo")).show).toEqual({ kind: "any" });
  });

  it("returns dateRange.preset === 'custom' with from + to when ?from=2026-04-01&to=2026-05-01", () => {
    const s = parseSearchParams(new URL("https://x?from=2026-04-01&to=2026-05-01"));
    expect(s.dateRange).toEqual({
      preset: "custom",
      from: "2026-04-01",
      to: "2026-05-01",
    });
  });

  it("returns dateRange.preset === 'month' when ?date=month", () => {
    expect(parseSearchParams(new URL("https://x?date=month")).dateRange).toEqual({
      preset: "month",
    });
  });

  it("returns sortDir === 'asc' when ?sort=asc; defaults to 'desc'", () => {
    expect(parseSearchParams(new URL("https://x?sort=asc")).sortDir).toBe("asc");
    expect(parseSearchParams(new URL("https://x")).sortDir).toBe("desc");
  });

  it("returns view === 'trash' when ?view=trash; defaults to 'feed'", () => {
    expect(parseSearchParams(new URL("https://x?view=trash")).view).toBe("trash");
    expect(parseSearchParams(new URL("https://x")).view).toBe("feed");
  });

  it("returns openEventId === 'ev_123' when ?event=ev_123; defaults to null", () => {
    expect(parseSearchParams(new URL("https://x?event=ev_123")).openEventId).toBe("ev_123");
    expect(parseSearchParams(new URL("https://x")).openEventId).toBeNull();
  });

  it("handles multi-value ?source=A&source=B via sp.getAll", () => {
    expect(parseSearchParams(new URL("https://x?source=A&source=B")).source).toEqual(["A", "B"]);
  });

  it("handles multi-value ?kind=youtube_video&kind=reddit_post and filters unknown kinds", () => {
    const s = parseSearchParams(new URL("https://x?kind=youtube_video&kind=foo&kind=reddit_post"));
    // 'foo' is dropped by filterValidKinds; the two valid kinds survive.
    expect(s.kind).toEqual(["youtube_video", "reddit_post"]);
  });

  it("parses authorIsMe=true / authorIsMe=false / omitted", () => {
    expect(parseSearchParams(new URL("https://x?authorIsMe=true")).authorIsMe).toBe(true);
    expect(parseSearchParams(new URL("https://x?authorIsMe=false")).authorIsMe).toBe(false);
    expect(parseSearchParams(new URL("https://x")).authorIsMe).toBeUndefined();
  });

  it("preserves cursor when ?cursor=abc", () => {
    expect(parseSearchParams(new URL("https://x?cursor=abc123")).cursor).toBe("abc123");
  });

  it("preserves query when ?q=hello world", () => {
    expect(parseSearchParams(new URL("https://x?q=hello%20world")).query).toBe("hello world");
  });
});

describe("serializeFilterState", () => {
  function defaultState(): FilterState {
    return {
      show: { kind: "any" },
      source: [],
      kind: [],
      gameTags: [],
      authorIsMe: undefined,
      // Default preset is "month" (matches parseSearchParams default).
      dateRange: { preset: "month" },
      sortDir: "desc",
      query: "",
      view: "feed",
      openEventId: null,
    };
  }

  it("omits keys with default values (no ?show=any, no ?sort=desc, no ?view=feed, no ?date=month)", () => {
    const sp = serializeFilterState(defaultState());
    expect(sp.toString()).toBe("");
  });

  it("encodes ?date=all when preset is 'all' (the explicit opt-out — 'all' is no longer the default)", () => {
    const sp = serializeFilterState({
      ...defaultState(),
      dateRange: { preset: "all" },
    });
    expect(sp.get("date")).toBe("all");
  });

  it("encodes authorIsMe boolean as ?authorIsMe=true / ?authorIsMe=false; undefined omitted", () => {
    expect(serializeFilterState({ ...defaultState(), authorIsMe: true }).get("authorIsMe")).toBe(
      "true",
    );
    expect(serializeFilterState({ ...defaultState(), authorIsMe: false }).get("authorIsMe")).toBe(
      "false",
    );
    expect(
      serializeFilterState({ ...defaultState(), authorIsMe: undefined }).has("authorIsMe"),
    ).toBe(false);
  });

  it("preserves cursor and openEventId pass-through", () => {
    const sp = serializeFilterState({
      ...defaultState(),
      cursor: "c-xyz",
      openEventId: "ev_99",
    });
    expect(sp.get("cursor")).toBe("c-xyz");
    expect(sp.get("event")).toBe("ev_99");
  });

  it("encodes gameTags as repeated ?game= params (no ?show=specific after Plan 03.4-10)", () => {
    const sp = serializeFilterState({
      ...defaultState(),
      gameTags: ["g1", "g2"],
    });
    expect(sp.has("show")).toBe(false);
    expect(sp.getAll("game")).toEqual(["g1", "g2"]);
  });

  it("encodes off_topic sentinel alongside game IDs as ?game=g1&game=off_topic", () => {
    const sp = serializeFilterState({
      ...defaultState(),
      gameTags: ["g1", OFF_TOPIC_TAG],
    });
    expect(sp.getAll("game")).toEqual(["g1", OFF_TOPIC_TAG]);
  });

  it("round-trips identity: parseSearchParams(new URL('https://x?' + serializeFilterState(s).toString())) === s", () => {
    const original: FilterState = {
      show: { kind: "any" },
      source: ["src_a", "src_b"],
      kind: ["youtube_video", "reddit_post"],
      gameTags: ["g1", "g2", OFF_TOPIC_TAG],
      authorIsMe: true,
      dateRange: { preset: "custom", from: "2026-04-01", to: "2026-05-01" },
      sortDir: "asc",
      query: "hello world",
      view: "trash",
      openEventId: "ev_42",
      cursor: "cur_xyz",
    };
    const roundTripped = parseSearchParams(
      new URL("https://x?" + serializeFilterState(original).toString()),
    );
    expect(roundTripped).toEqual(original);
  });

  it("round-trips a minimal state (no extras)", () => {
    const minimal = defaultState();
    const rt = parseSearchParams(new URL("https://x?" + serializeFilterState(minimal).toString()));
    expect(rt).toEqual(minimal);
  });

  it("URL kind axis accepts every EventKind the schema defines", () => {
    // Parity guard for the local URL_VALID_KINDS set in src/lib/feed/url-state.ts.
    // If the schema enum grows (e.g. Phase 4 adds 'mastodon_post'), this test
    // must be updated AND the local kind-list updated in the same commit.
    // Documented as Plan 03.4-02 Rule 3 deviation; follow-up: extract a
    // shared client-safe VALID_EVENT_KINDS module.
    const ALL_SCHEMA_KINDS = [
      "youtube_video",
      "reddit_post",
      "twitter_post",
      "telegram_post",
      "discord_drop",
      "conference",
      "talk",
      "press",
      "other",
      "post",
    ];
    const url = new URL("https://x?" + ALL_SCHEMA_KINDS.map((k) => `kind=${k}`).join("&"));
    expect(parseSearchParams(url).kind).toEqual(ALL_SCHEMA_KINDS);
  });

  it("encodes dateRange preset as ?date=week and dateRange custom as ?from=&to=", () => {
    const presetSp = serializeFilterState({
      ...defaultState(),
      dateRange: { preset: "week" },
    });
    expect(presetSp.get("date")).toBe("week");
    expect(presetSp.has("from")).toBe(false);

    const customSp = serializeFilterState({
      ...defaultState(),
      dateRange: { preset: "custom", from: "2026-04-01", to: "2026-05-01" },
    });
    expect(customSp.has("date")).toBe(false);
    expect(customSp.get("from")).toBe("2026-04-01");
    expect(customSp.get("to")).toBe("2026-05-01");
  });
});
