import type { PageServerLoad } from "./$types.js";
import { redirect } from "@sveltejs/kit";
import {
  listFeedPage,
  listDeletedEvents,
  type FeedFilters,
  type ShowFilter,
} from "$lib/server/services/events.js";
import { listGames } from "$lib/server/services/games.js";
import { listSources } from "$lib/server/services/data-sources.js";
import { toEventDto, toGameDto, toDataSourceDto } from "$lib/server/dto.js";

// Plan 02.1-19 URL contract: /feed accepts ?show=any|inbox|specific +
// ?game=A&game=B (when show=specific). The legacy ?attached=true|false is
// no longer recognized. Pre-launch destructive contract change (CONTEXT
// D-04). When neither ?show nor ?game is present, default = "any".

/**
 * /feed loader — the primary daily workspace for authenticated users.
 *
 * The +layout.server.ts protected-paths sweep redirects anonymous requests
 * to /login (Phase 2 D-37 — `PROTECTED_PATHS` covers `/feed` once added);
 * here we double-check and bail to /login on any path that slips through
 * (defense-in-depth — if `/feed` is ever removed from the layout
 * allowlist by accident, the route stays auth-gated).
 *
 * Single-shot DTO assembly (RESEARCH §10.3 sub-question c): the loader
 * runs `listFeedPage` + `listGames` + `listSources` in parallel and
 * projects each row through its DTO function. The page component renders
 * with id-only references on the EventDto and an O(1) JS lookup for the
 * matching source / game — no per-row HTTP roundtrip.
 *
 * Filter parsing: 7 URL-param axes (RESEARCH §3.3 + Plan 02.1-05's
 * FeedFilters). Booleans arrive as the strings 'true' / 'false' / undefined;
 * we coerce explicitly so a malformed value is treated as "no filter".
 * Date params (`from` / `to`) are ISO strings; an invalid date short-circuits
 * to undefined (the cursor pager will return zero rows rather than crash).
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }
  const userId = locals.user.id;

  // Plan 02.1-15 — multi-value axes via URLSearchParams.getAll(). Repeated
  // query params (?source=A&source=B) yield ["A","B"]; a single param yields
  // ["A"]; absence yields []. The service-layer pushAxis helper collapses
  // each shape to its right SQL form (empty = no filter, 1-elem = eq,
  // N-elem = inArray).
  const sourceList = url.searchParams.getAll("source");
  const kindList = url.searchParams.getAll("kind");
  const gameList = url.searchParams.getAll("game");

  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const allParam = url.searchParams.get("all");

  // Plan 02.1-15 Gap 9: when neither from/to nor all=1 is set, default the
  // window to the last 30 days. The default surfaces in `activeFilters` so
  // the chip strip shows a "Last 30 days (default)" chip the user can
  // dismiss — dismissing navigates to ?all=1 (opt-out). When the user picks
  // any explicit from / to, those win.
  let fromForFilter = fromParam ?? undefined;
  let toForFilter = toParam ?? undefined;
  if (fromForFilter === undefined && toForFilter === undefined && allParam !== "1") {
    const today = new Date();
    const thirtyDaysAgo = new Date(today);
    thirtyDaysAgo.setUTCDate(today.getUTCDate() - 30);
    fromForFilter = thirtyDaysAgo.toISOString().slice(0, 10);
    toForFilter = today.toISOString().slice(0, 10);
  }

  // Date-only inputs (YYYY-MM-DD) are inclusive on both ends — `from` becomes
  // 00:00:00 UTC of that day (start), `to` becomes 23:59:59.999 UTC (end).
  // Without the end-of-day shift, picking `from=to=2026-04-26` would match
  // nothing because midnight-26 ≤ event ≤ midnight-26 has zero width.
  const fromDate = fromForFilter ? new Date(`${fromForFilter}T00:00:00.000Z`) : undefined;
  const toDate = toForFilter ? new Date(`${toForFilter}T23:59:59.999Z`) : undefined;

  // Plan 02.1-19: ?show=any|inbox|specific URL contract. Default = "any".
  // Any other value (including null / unrecognized) falls back to "any" so a
  // malformed URL doesn't 500 — the chip strip will simply show no Show chip.
  const showParam = url.searchParams.get("show") ?? "any";
  const showKind: "any" | "inbox" | "specific" =
    showParam === "inbox" ? "inbox" : showParam === "specific" ? "specific" : "any";
  const showFilter: ShowFilter =
    showKind === "inbox"
      ? { kind: "inbox" }
      : showKind === "specific"
        ? { kind: "specific", gameIds: gameList }
        : { kind: "any" };

  const filters: FeedFilters = {
    source: sourceList.length > 0 ? sourceList : undefined,
    kind: kindList.length > 0 ? (kindList as FeedFilters["kind"]) : undefined,
    show: showFilter,
    authorIsMe:
      url.searchParams.get("authorIsMe") === "true"
        ? true
        : url.searchParams.get("authorIsMe") === "false"
          ? false
          : undefined,
    from: fromDate && !Number.isNaN(fromDate.getTime()) ? fromDate : undefined,
    to: toDate && !Number.isNaN(toDate.getTime()) ? toDate : undefined,
  };
  const cursor = url.searchParams.get("cursor");

  // Plan 02.1-14 (gap closure): listDeletedEvents joins the parallel fetch
  // so the /feed page can render the soft-delete recovery panel below the
  // CursorPager. retentionDays is forwarded from +layout.server.ts (the
  // SOLE process.env reader path — CLAUDE.md / AGENTS.md hard rule).
  const [page, gameRows, sourceRows, deletedRows] = await Promise.all([
    listFeedPage(userId, filters, cursor),
    listGames(userId),
    listSources(userId),
    listDeletedEvents(userId),
  ]);

  return {
    rows: page.rows.map(toEventDto),
    nextCursor: page.nextCursor,
    games: gameRows.map(toGameDto),
    sources: sourceRows.map(toDataSourceDto),
    // Plan 02.1-14 (preserved): listDeletedEvents flows through the loader
    // so /feed renders the soft-delete recovery panel without a second
    // round-trip. retentionDays continues to come from the layout
    // pass-through (CLAUDE.md / AGENTS.md hard rule — only env.ts reads
    // process.env; the layout already exposes RETENTION_DAYS).
    deletedEvents: deletedRows.map(toEventDto),
    activeFilters: {
      // Plan 02.1-15: array form for the multi-value axes — always present,
      // possibly empty. The chip strip / sheet always treat them as
      // string[] so single-value renders the same as zero-value.
      source: sourceList,
      kind: kindList,
      // Plan 02.1-19: merged 'show' axis replaces game + attached pair.
      show:
        showKind === "inbox"
          ? { kind: "inbox" as const }
          : showKind === "specific"
            ? { kind: "specific" as const, gameIds: gameList }
            : { kind: "any" as const },
      authorIsMe: filters.authorIsMe,
      from: filters.from ? filters.from.toISOString().slice(0, 10) : undefined,
      to: filters.to ? filters.to.toISOString().slice(0, 10) : undefined,
      // Default-flag (Gap 9): the UI uses this to render the date chip as
      // "default" (dismissable via ?all=1) rather than user-applied. True
      // only when no from/to/all params were supplied.
      defaultDateRange: fromParam === null && toParam === null && allParam !== "1",
      all: allParam === "1",
    },
  };
};
