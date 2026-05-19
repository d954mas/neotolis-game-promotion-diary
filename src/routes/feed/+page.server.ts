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
import { mapEventsToDtos, toGameDto, toDataSourceDto } from "$lib/server/dto.js";
import { filterValidKinds } from "$lib/util/filter-event-kinds.js";
import { allAdapters } from "$lib/sources/registry.js";
import { enrichDataSourceDtosWithYoutubeChannelTitles } from "$lib/server/services/sources-page-read.js";

// URL contract: /feed accepts ?show=any|inbox|specific + ?game=A&game=B
// (when show=specific). The legacy ?attached=true|false is no longer
// recognized. When neither ?show nor ?game is present, default = "any".

/**
 * /feed loader — the primary daily workspace for authenticated users.
 *
 * The +layout.server.ts protected-paths sweep redirects anonymous requests
 * to /login; here we double-check and bail to /login on any path that slips
 * through (defense-in-depth — if `/feed` is ever removed from the layout
 * allowlist by accident, the route stays auth-gated).
 *
 * Single-shot DTO assembly: the loader runs `listFeedPage` + `listGames` +
 * `listSources` in parallel and projects each row through its DTO function.
 * The page component renders with id-only references on the EventDto and
 * an O(1) JS lookup for the matching source / game — no per-row HTTP
 * roundtrip.
 *
 * Filter parsing: 7 URL-param axes. Booleans arrive as the strings 'true' /
 * 'false' / undefined; we coerce explicitly so a malformed value is
 * treated as "no filter". Date params (`from` / `to`) are ISO strings;
 * an invalid date short-circuits to undefined (the cursor pager will
 * return zero rows rather than crash).
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname)}`);
  }
  const userId = locals.user.id;

  // Multi-value axes via URLSearchParams.getAll(). Repeated query params
  // (?source=A&source=B) yield ["A","B"]; a single param yields ["A"];
  // absence yields []. The service-layer pushAxis helper collapses each
  // shape to its right SQL form (empty = no filter, 1-elem = eq,
  // N-elem = inArray).
  const sourceList = url.searchParams.getAll("source");
  // Filter unknown kinds out before they reach Drizzle's
  // inArray(events.kind, [...]) clause. A malformed URL like /feed?kind=foo
  // would otherwise surface as a Postgres 500 (unknown enum value). Silent
  // drop matches the ?show= malformed-param fallback below — defensive
  // validation, not user-visible error.
  const kindList = filterValidKinds(url.searchParams.getAll("kind"));
  const gameList = url.searchParams.getAll("game");

  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  // `?all=1` was the legacy escape hatch for the 30-day default window.
  // The implicit window is retired; this read is preserved only for
  // analytics symmetry. Underscore-prefixed to satisfy no-unused-vars;
  // remove when /feed history confirms no tooling reads it.
  const _allParam = url.searchParams.get("all");

  // Default is All-time. The 30-day implicit window was confusing — a fresh
  // YouTube backfill of a channel often surfaces older uploads, and the
  // implicit cap silently hid them. Cursor pagination already protects from
  // rendering huge lists, so dropping the default cap is safe. `?all=1`
  // remains a no-op for backward compatibility (any old links keep working).
  // Explicit from/to params still win when the user picks a range.
  const fromForFilter = fromParam ?? undefined;
  const toForFilter = toParam ?? undefined;

  // Date-only inputs (YYYY-MM-DD) are inclusive on both ends — `from` becomes
  // 00:00:00 UTC of that day (start), `to` becomes 23:59:59.999 UTC (end).
  // Without the end-of-day shift, picking `from=to=2026-04-26` would match
  // nothing because midnight-26 ≤ event ≤ midnight-26 has zero width.
  const fromDate = fromForFilter ? new Date(`${fromForFilter}T00:00:00.000Z`) : undefined;
  const toDate = toForFilter ? new Date(`${toForFilter}T23:59:59.999Z`) : undefined;

  // ?show=any|inbox|standalone|specific URL contract. Default = "any".
  // Any other value (including null / unrecognized) falls back to "any" so a
  // malformed URL doesn't 500 — the chip strip will simply show no Show chip.
  const showParam = url.searchParams.get("show") ?? "any";
  const showKind: "any" | "inbox" | "standalone" | "specific" =
    showParam === "inbox"
      ? "inbox"
      : showParam === "standalone"
        ? "standalone"
        : showParam === "specific"
          ? "specific"
          : "any";
  const showFilter: ShowFilter =
    showKind === "inbox"
      ? { kind: "inbox" }
      : showKind === "standalone"
        ? { kind: "standalone" }
        : showKind === "specific"
          ? { kind: "specific", gameIds: gameList }
          : { kind: "any" };

  const filters: FeedFilters = {
    source: sourceList.length > 0 ? sourceList : undefined,
    // kindList is now EventKind[] (filtered against VALID_EVENT_KINDS via
    // filterValidKinds above), so a cast is no longer needed.
    kind: kindList.length > 0 ? kindList : undefined,
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

  // listDeletedEvents joins the parallel fetch so the /feed page can render
  // the soft-delete recovery panel below the CursorPager. retentionDays is
  // forwarded from +layout.server.ts (the SOLE process.env reader path —
  // CLAUDE.md / AGENTS.md hard rule).
  const [page, gameRows, sourceRows, deletedRows] = await Promise.all([
    listFeedPage(userId, filters, cursor),
    listGames(userId),
    // Include soft-deleted sources so the feed card can still resolve
    // channelTitle / displayName for events whose parent source the user
    // has removed. Without this, events backed by a now-deleted source
    // render with no source chip — confusing because the events themselves
    // remain in /feed (events are not cascaded when sources go
    // soft-deleted; the user's own historical metadata stays intact). The
    // UI may surface a "(removed)" suffix on the chip later.
    listSources(userId, { includeDeleted: true }),
    listDeletedEvents(userId),
  ]);

  // mapEventsToDtos batch-loads the event_games junction rows so each
  // EventDto carries its gameIds[] without an N+1 query (one junction
  // lookup per page; one for the deletedEvents list).
  const [rowDtos, deletedDtos] = await Promise.all([
    mapEventsToDtos(userId, page.rows),
    mapEventsToDtos(userId, deletedRows),
  ]);

  // Adapter-driven feed enrichment. Iterates allAdapters and lets each one
  // mutate the dtos in place. YouTube enriches kind=youtube_video rows with
  // stats + channelTitle; future per-platform adapters enrich their own
  // kinds from per-platform metadata tables. All three feed-rendering
  // callsites (SSR first batch, GET /api/events cursor pagination,
  // /games/[id] curated views) share the same loop.
  for (const adapter of allAdapters) {
    if (adapter.enrichFeedDtos) {
      await adapter.enrichFeedDtos(userId, rowDtos);
    }
  }

  // Enrich source DTOs with the YouTube channel_title from cache so the
  // feed card can show the real channel name alongside the user's own
  // displayName. One batched lookup keyed on every distinct channelId
  // across all loaded sources.
  const sourceDtos = sourceRows.map(toDataSourceDto);
  await enrichDataSourceDtosWithYoutubeChannelTitles(sourceDtos);

  return {
    rows: rowDtos,
    nextCursor: page.nextCursor,
    games: gameRows.map(toGameDto),
    sources: sourceDtos,
    // listDeletedEvents flows through the loader
    // so /feed renders the soft-delete recovery panel without a second
    // round-trip. retentionDays continues to come from the layout
    // pass-through (CLAUDE.md / AGENTS.md hard rule — only env.ts reads
    // process.env; the layout already exposes RETENTION_DAYS).
    deletedEvents: deletedDtos,
    activeFilters: {
      // Array form for the multi-value axes — always present, possibly
      // empty. The chip strip / sheet always treat them as string[] so
      // single-value renders the same as zero-value.
      source: sourceList,
      kind: kindList,
      // Merged 'show' axis (any | inbox | standalone | specific) replaces
      // the legacy game + attached pair.
      show:
        showKind === "inbox"
          ? { kind: "inbox" as const }
          : showKind === "standalone"
            ? { kind: "standalone" as const }
            : showKind === "specific"
              ? { kind: "specific" as const, gameIds: gameList }
              : { kind: "any" as const },
      authorIsMe: filters.authorIsMe,
      from: filters.from ? filters.from.toISOString().slice(0, 10) : undefined,
      to: filters.to ? filters.to.toISOString().slice(0, 10) : undefined,
      // The implicit 30-day default window was retired; /feed now defaults
      // to All-time. defaultDateRange always false so the FilterChips strip
      // never renders the "Last 30 days (default)" chip; `all` is true
      // whenever the user hasn't picked a from/to.
      defaultDateRange: false,
      all: fromParam === null && toParam === null,
    },
  };
};
