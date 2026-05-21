// URL state for the v2 /feed surface (Plan 03.4-02, D-02).
//
// Single helper module that parses `URL.searchParams` into a `FilterState`
// discriminated union and serializes back to `URLSearchParams`. The /feed
// loader, navigation links, share-able URLs, and the in-page filter UI all
// route through this module so the URL is the single source of truth for
// filter state (no parallel React-local copies that can drift).
//
// Multi-value axes (`source`, `kind`, `game`) use `getAll(...)` so repeated
// query params (`?source=A&source=B`) yield arrays. The `kind` axis runs
// through `filterValidKinds` so a malformed `?kind=foo` URL never reaches
// the SSR loader's Drizzle `inArray(events.kind, [...])` clause — silent
// drop matches the existing `/feed?show=foo` malformed-param fallback
// (see src/routes/feed/+page.server.ts).
//
// `serializeFilterState` omits every axis at its default value so the URL
// stays short and shareable. Defaults: show.kind === "any", sortDir ===
// "desc", view === "feed", dateRange.preset === "month", query === "",
// openEventId === null, authorIsMe === undefined, cursor === undefined.
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
// ShowFilter / EventKind types are imported as `import type` so the
// runtime bundle does NOT pull in the server-only events.ts module
// (which loads env config at top level — breaks unit tests / SSR
// client bundles).

import type { ShowFilter } from "$lib/server/services/events.js";
import type { EventKind } from "$lib/sources/adapter.js";

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

function parseShow(sp: URLSearchParams): ShowFilter {
  const show = sp.get("show");
  if (show === "inbox") return { kind: "inbox" };
  if (show === "standalone") return { kind: "standalone" };
  if (show === "specific") {
    return { kind: "specific", gameIds: sp.getAll("game") };
  }
  return { kind: "any" };
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

  // show axis — omit when default ("any").
  if (state.show.kind === "inbox") sp.set("show", "inbox");
  else if (state.show.kind === "standalone") sp.set("show", "standalone");
  else if (state.show.kind === "specific") {
    sp.set("show", "specific");
    for (const gid of state.show.gameIds) sp.append("game", gid);
  }

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
