// URL state for the v2 /feed surface (Plan 03.4-02, D-02; Plan 03.4-10
// game-axis multi-select refactor).
//
// Single helper module that parses `URL.searchParams` into a `FilterState`
// discriminated union and serializes back to `URLSearchParams`. The /feed
// loader, navigation links, share-able URLs, and the in-page filter UI all
// route through this module so the URL is the single source of truth for
// filter state (no parallel React-local copies that can drift).
//
// Multi-value axes (`source`, `kind`, `gameTags`) use `getAll(...)` so
// repeated query params (`?source=A&source=B`) yield arrays. The `kind`
// axis runs through `filterValidKinds` so a malformed `?kind=foo` URL
// never reaches the SSR loader's Drizzle `inArray(events.kind, [...])`
// clause — silent drop matches the existing `/feed?show=foo` malformed-
// param fallback (see src/routes/feed/+page.server.ts).
//
// GAME axis (Plan 03.4-10 refactor) — `gameTags: string[]` is a flat
// multi-select list where each entry is EITHER a game id OR the sentinel
// value `"off_topic"`. Filter semantics: an event matches when it is
// attached to ANY game in `gameTags` OR (when `"off_topic"` is in the list)
// its triage.offTopic flag is true. This replaces the old single-cardinality
// `show: { kind: "standalone" } | { kind: "specific"; gameIds }` shape so
// users can pick "Off topic" + "Neotolis: Last Light" simultaneously and
// see both groups in the feed at once. URL: `?game=g1,g2,off_topic` (one
// repeated param per value). `show` now keeps only `any | inbox` — inbox
// is the orthogonal "no triage decision yet" state.
//
// Backward compatibility — legacy URLs `?show=standalone` and
// `?show=specific&game=...` are migrated at parse time to the new
// `gameTags` shape so existing bookmarks self-clean on the next URL write.
//
// `serializeFilterState` omits every axis at its default value so the URL
// stays short and shareable. Defaults: show.kind === "any", sortDir ===
// "desc", view === "feed", dateRange.preset === "month", query === "",
// openEventId === null, authorIsMe === undefined, gameTags === [],
// cursor === undefined.
//
// `dateRange.preset === "month"` is the default (matches the prototype
// where the "Month" preset chip is active out of the box). The empty URL
// therefore implies a 30-day rolling window — `?date=month` is omitted
// from the URL when active, while `?date=all` is the explicit opt-out.
//
// `authorIsMe` is a tri-state boolean: `true` (mine) / `false` (others) /
// `undefined` (anyone). Encoded as `?authorIsMe=true|false`; undefined =
// omitted from the URL.
//
// EventKind type is imported as `import type` so the runtime bundle does
// NOT pull in the server-only events.ts module (which loads env config at
// top level — breaks unit tests / SSR client bundles).

import type { EventKind } from "$lib/sources/adapter.js";

/**
 * Off-topic sentinel value in the GAME axis multi-select. Carried as a
 * string alongside game IDs in `gameTags`; the SQL filter + client filter-
 * math both branch on this exact value when applying the OR clause for
 * `metadata.triage.offTopic = true`.
 */
export const OFF_TOPIC_TAG = "off_topic";

/**
 * ShowFilter — narrows to `any | inbox` after the Plan 03.4-10 game-axis
 * refactor. Off-topic + per-game selection moved to the flat
 * `FilterState.gameTags` array; `show` now only models the "Inbox vs
 * everything else" triage state, which is orthogonal to GAME-axis selection.
 *
 * Defined locally (not re-exported from $lib/server/services/events.js) so
 * the client URL state never imports the server-only events module.
 */
export type ShowFilter = { kind: "any" } | { kind: "inbox" };

// Local kind-axis validation. We cannot reuse `filterValidKinds` from
// `$lib/util/filter-event-kinds.js` because that helper imports
// `VALID_EVENT_KINDS` from the server-only events service, which would
// drag the env-loading chain into the client bundle / unit-test runner.
// Documented as Plan 03.4-02 deviation Rule 3 (auto-fix blocking issue);
// follow-up: extract VALID_EVENT_KINDS to a client-safe shared module
// so all three callers (events service, filter-event-kinds helper, this
// URL parser) reuse a single source of truth.
const URL_VALID_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
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
]);
function filterValidKindsLocal(raw: string[]): EventKind[] {
  return raw.filter((k): k is EventKind => URL_VALID_KINDS.has(k as EventKind));
}

export type DateRangePreset = "all" | "today" | "week" | "month" | "year";

export type DateRangeFilter =
  | { preset: DateRangePreset }
  | { preset: "custom"; from: string; to: string };

export interface FilterState {
  show: ShowFilter;
  source: string[];
  kind: EventKind[];
  /**
   * GAME axis multi-select. Each entry is either a game id OR the sentinel
   * value `OFF_TOPIC_TAG` ("off_topic"). Empty array = no GAME-axis filter.
   * The SQL clause + client filter-math both apply OR semantics: an event
   * passes when it is attached to ANY game in the list OR (when "off_topic"
   * is present) its triage.offTopic flag is true.
   */
  gameTags: string[];
  authorIsMe: boolean | undefined;
  dateRange: DateRangeFilter;
  sortDir: "asc" | "desc";
  query: string;
  view: "feed" | "trash";
  openEventId: string | null;
  cursor?: string;
}

// Internal helper: ?date=today|week|month|year|all OR ?from=YYYY-MM-DD&to=YYYY-MM-DD
// OR neither (→ preset: "month", the default). The custom branch wins
// over the preset branch when both are present (the dragged range
// picker writes from/to). ?date=all is the explicit opt-out for the
// default 30-day window — without it the empty URL means "month".
function parseDateRange(sp: URLSearchParams): DateRangeFilter {
  const from = sp.get("from");
  const to = sp.get("to");
  if (from && to) return { preset: "custom", from, to };
  const date = sp.get("date");
  if (
    date === "today" ||
    date === "week" ||
    date === "month" ||
    date === "year" ||
    date === "all"
  ) {
    return { preset: date };
  }
  return { preset: "month" };
}

/**
 * parseShow — narrowed to `any | inbox` after Plan 03.4-10. Legacy
 * `?show=standalone` and `?show=specific` are NOT decoded here; they are
 * migrated to `gameTags` by `parseGameTags` so a single bookmark with
 * `?show=specific&game=g1` ends up as `gameTags: ["g1"]` (and the next URL
 * write self-cleans via `serializeFilterState`).
 */
function parseShow(sp: URLSearchParams): ShowFilter {
  const show = sp.get("show");
  if (show === "inbox") return { kind: "inbox" };
  return { kind: "any" };
}

/**
 * parseGameTags — flat multi-select GAME axis. Reads every repeated
 * `?game=` param (and the comma-split fallback for legacy bookmarks where
 * a single value carries multiple comma-joined ids). Also migrates legacy
 * `?show=standalone` → `["off_topic"]` and `?show=specific&game=g1&game=g2`
 * → `["g1", "g2"]`. After migration runs once and the user navigates, the
 * URL self-cleans via `serializeFilterState`.
 *
 * Order is preserved (URL.searchParams iteration order); duplicates are
 * collapsed via Set so `?game=g1&game=g1` becomes `["g1"]`.
 */
function parseGameTags(sp: URLSearchParams): string[] {
  // Read every repeated ?game= param, then split on "," to honor both
  // shapes (?game=a,b and ?game=a&game=b). Empty strings (from a stray
  // trailing comma or `?game=`) are filtered.
  const raw = sp
    .getAll("game")
    .flatMap((v) => v.split(","))
    .filter((v) => v !== "");
  const collected = new Set<string>(raw);

  // Legacy URL migration. `?show=standalone` (pre-Plan-03.4-10) implied a
  // single-cardinality off-topic filter; ?show=specific&game=... implied
  // the legacy `{kind:"specific", gameIds}` shape. Migrate both into the
  // new flat list. parseShow returns "any" for these values, so the
  // legacy URL self-cleans on the next serializeFilterState call.
  const show = sp.get("show");
  if (show === "standalone") collected.add(OFF_TOPIC_TAG);
  // ?show=specific without explicit ?game= is a no-op (empty target set);
  // the explicit ?game= params already landed in `collected` above.

  return Array.from(collected);
}

function parseAuthorIsMe(sp: URLSearchParams): boolean | undefined {
  const raw = sp.get("authorIsMe");
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

export function parseSearchParams(url: URL): FilterState {
  const sp = url.searchParams;
  const cursor = sp.get("cursor");
  return {
    show: parseShow(sp),
    source: sp.getAll("source"),
    kind: filterValidKindsLocal(sp.getAll("kind")),
    gameTags: parseGameTags(sp),
    authorIsMe: parseAuthorIsMe(sp),
    dateRange: parseDateRange(sp),
    sortDir: sp.get("sort") === "asc" ? "asc" : "desc",
    query: sp.get("q") ?? "",
    view: sp.get("view") === "trash" ? "trash" : "feed",
    openEventId: sp.get("event"),
    ...(cursor !== null ? { cursor } : {}),
  };
}

export function serializeFilterState(state: FilterState): URLSearchParams {
  const sp = new URLSearchParams();

  // show axis — omit when default ("any"). Only "inbox" is written after
  // Plan 03.4-10; the legacy "standalone" / "specific" values are dead in
  // both the URL writer AND the parser (parseSearchParams migrates them
  // into `gameTags`).
  if (state.show.kind === "inbox") sp.set("show", "inbox");

  // multi-value GAME axis (Plan 03.4-10). One ?game= param per entry;
  // entries may be game IDs OR the OFF_TOPIC_TAG sentinel. Empty list →
  // no param emitted (shareable URL stays short).
  for (const g of state.gameTags) sp.append("game", g);

  // multi-value source axis — append each (URLSearchParams handles repetition).
  for (const s of state.source) sp.append("source", s);

  // multi-value kind axis.
  for (const k of state.kind) sp.append("kind", k);

  // authorIsMe tri-state — omit when undefined.
  if (state.authorIsMe === true) sp.set("authorIsMe", "true");
  else if (state.authorIsMe === false) sp.set("authorIsMe", "false");

  // dateRange — custom (?from + ?to) OR preset (?date=...) OR omitted
  // (?month, the default). `?date=all` IS emitted because "all" is no
  // longer the default — the empty URL means "month".
  if (state.dateRange.preset === "custom") {
    sp.set("from", state.dateRange.from);
    sp.set("to", state.dateRange.to);
  } else if (state.dateRange.preset !== "month") {
    sp.set("date", state.dateRange.preset);
  }

  // sortDir — omit when default ("desc").
  if (state.sortDir === "asc") sp.set("sort", "asc");

  // query — omit when empty.
  if (state.query !== "") sp.set("q", state.query);

  // view — omit when default ("feed").
  if (state.view === "trash") sp.set("view", "trash");

  // openEventId — omit when null.
  if (state.openEventId !== null) sp.set("event", state.openEventId);

  // cursor — omit when undefined.
  if (state.cursor !== undefined) sp.set("cursor", state.cursor);

  return sp;
}
