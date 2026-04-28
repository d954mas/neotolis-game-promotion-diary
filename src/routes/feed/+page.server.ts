import type { PageServerLoad } from "./$types.js";
import { redirect } from "@sveltejs/kit";
import { listFeedPage, type FeedFilters } from "$lib/server/services/events.js";
import { listGames } from "$lib/server/services/games.js";
import { listSources } from "$lib/server/services/data-sources.js";
import { toEventDto, toGameDto, toDataSourceDto } from "$lib/server/dto.js";

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

  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const fromDate = fromParam ? new Date(fromParam) : undefined;
  const toDate = toParam ? new Date(toParam) : undefined;

  const filters: FeedFilters = {
    source: url.searchParams.get("source") ?? undefined,
    kind: (url.searchParams.get("kind") as FeedFilters["kind"]) ?? undefined,
    game: url.searchParams.get("game") ?? undefined,
    attached:
      url.searchParams.get("attached") === "true"
        ? true
        : url.searchParams.get("attached") === "false"
          ? false
          : undefined,
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

  const [page, gameRows, sourceRows] = await Promise.all([
    listFeedPage(userId, filters, cursor),
    listGames(userId),
    listSources(userId),
  ]);

  return {
    rows: page.rows.map(toEventDto),
    nextCursor: page.nextCursor,
    games: gameRows.map(toGameDto),
    sources: sourceRows.map(toDataSourceDto),
    activeFilters: {
      source: filters.source,
      kind: filters.kind,
      game: filters.game,
      attached: filters.attached,
      authorIsMe: filters.authorIsMe,
      from: filters.from ? filters.from.toISOString().slice(0, 10) : undefined,
      to: filters.to ? filters.to.toISOString().slice(0, 10) : undefined,
    },
  };
};
