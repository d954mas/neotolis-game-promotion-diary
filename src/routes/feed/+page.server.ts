import type { PageServerLoad } from "./$types.js";
import { redirect } from "@sveltejs/kit";
import {
  listFeedPage,
  listFeedFacets,
  listDeletedEvents,
  getEventById,
  type FeedFilters,
} from "$lib/server/services/events.js";
import { listGames, deriveReleaseInfoForGames } from "$lib/server/services/games.js";
import { listSources } from "$lib/server/services/data-sources.js";
import { mapEventsToDtos, toGameDto, toDataSourceDto } from "$lib/server/dto.js";
import { allAdapters } from "$lib/sources/registry.js";
import {
  enrichDataSourceDtosWithYoutubeChannelTitles,
  enrichTelegramSourcesWithChannelTitle,
} from "$lib/server/services/sources-page-read.js";
import { NotFoundError } from "$lib/server/services/errors.js";
import { parseSearchParams } from "$lib/feed/url-state.js";
import { dateRangeWindow, parseEventDate } from "$lib/feed/date-range.js";

// URL contract (Phase 03.4 Wave 3): /feed accepts the FilterState shape
// produced by parseSearchParams($lib/feed/url-state.js) — show / source /
// kind / authorIsMe / dateRange (preset OR custom) / sortDir / query / view
// (feed | trash) / openEventId / cursor. The loader is the single SSR
// consumer of that shape; the orchestrator (+page.svelte) reads the same
// parsed state to drive the UI in lockstep with the URL.
//
// Phase 03.4 D-24: TODAY is server-provided. We compute it once here and
// thread the ISO YYYY-MM-DD string through to the orchestrator so client-side
// date math (DateRangePicker future-date guard, predicted-count windows in
// AxisRow) uses the same instant. Without this the SSR loader and the client
// would each pick `new Date()` independently and timezone drift would flip
// `today`'s value across the SSR-hydrate boundary.

/**
 * /feed loader — primary daily workspace.
 *
 * URL state → FilterState (Plan 03.4-02) → FeedFilters mapping:
 *   - state.show          → filters.show              (passed through)
 *   - state.source        → filters.source             (empty array dropped)
 *   - state.kind          → filters.kind               (empty array dropped)
 *   - state.authorIsMe    → filters.authorIsMe         (tri-state)
 *   - state.dateRange     → filters.from + filters.to  (preset resolved
 *                                                      server-side via
 *                                                      dateRangeWindow)
 *
 * Plan 05 extension: when state.view === "trash", we call
 * listFeedPage(userId, filters, cursor, { scope: "trash" }) — same filter
 * surface, soft-delete predicate flipped (+ 30-day retention window
 * applied by the service). The deletedEvents panel that /feed used to
 * carry is now redundant for trash-mode renders; we keep listDeletedEvents
 * for legacy compatibility (RecoveryDialog still consumes
 * data.deletedEvents on the live view), but for trash-mode renders the
 * rows themselves ARE the deleted events.
 *
 * ?event=ev_id load-bearing fetch (D-05 dual-render dual-source contract):
 * the EventDetailModal mounted in /feed reads its event from
 * `data.rows.find(r => r.id === openEventId)`. When the user navigates
 * directly to a deep-link URL whose target row is past the cursor page
 * (or in trash while the user is viewing live), we MUST fetch that row
 * separately and prepend it to data.rows so the modal can find it. A
 * cross-tenant or hard-deleted id → 303 to bare /feed (drop the ?event=
 * param). NotFoundError catches both cases (cross-tenant + missing) per
 * tenant-scope discipline.
 *
 * Privacy invariants:
 *   - locals.user gate guards anonymous traffic (defense-in-depth alongside
 *     the +layout.server.ts protected-paths sweep).
 *   - Every service call passes userId as the first non-optional arg.
 *   - mapEventsToDtos / toDataSourceDto / toGameDto are the projection
 *     boundary — ciphertext columns are stripped at the DTO layer.
 *   - Cross-tenant ?event= → 303 redirect (not 403 / not 500) — same
 *     UX as a stale bookmark.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  if (!locals.user) {
    throw redirect(303, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  const userId = locals.user.id;

  // Single source of truth for URL → filter state (D-02). The parsed
  // FilterState mirrors what the client orchestrator reads, so the SSR
  // path and the client path see the same axes.
  const state = parseSearchParams(url);

  // Date range — resolve preset to a concrete (from, to) window server-side
  // so the listFeedPage filter clauses stay shape-stable. The custom branch
  // honors the user-typed from/to directly. "all" leaves both undefined
  // (no date predicate appended). Server TODAY (D-24) lives in `today` ISO.
  //
  // Use local-date computation (not UTC) so "Today" aligns with the
  // server's wall-clock date. .toISOString().slice(0,10) returns UTC which
  // diverges from local time between midnight and the UTC offset window
  // (e.g. UTC+5 shows yesterday between 00:00-04:59 local).
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const todayDate = parseEventDate(todayIso) ?? new Date();
  let from: Date | undefined;
  let to: Date | undefined;
  if (state.dateRange.preset === "custom") {
    const fromDt = parseEventDate(state.dateRange.from);
    const toDt = parseEventDate(state.dateRange.to);
    // Date-only inputs (YYYY-MM-DD) are inclusive on both ends. Without the
    // end-of-day shift, picking from=to=YYYY-MM-DD would match nothing
    // because midnight ≤ event ≤ midnight has zero width.
    if (fromDt) {
      from = new Date(`${state.dateRange.from}T00:00:00.000Z`);
    }
    if (toDt) {
      to = new Date(`${state.dateRange.to}T23:59:59.999Z`);
    }
  } else if (state.dateRange.preset !== "all") {
    const window = dateRangeWindow(state.dateRange.preset, todayDate);
    from = window.from;
    to = window.to;
  }

  // GAME axis multi-select (Plan 03.4-10). `state.gameTags` is the flat
  // multi-select array (game IDs + optional OFF_TOPIC_TAG sentinel). When
  // show.kind === "inbox", the user is in the "no triage decision yet" view
  // and gameTags is behaviorally empty — pairing inbox with gameTags would
  // always return zero rows by construction (inbox = no games attached), so
  // we drop the gameTags filter rather than emit an empty result.
  const gameTags =
    state.show.kind === "inbox"
      ? undefined
      : state.gameTags.length > 0
        ? state.gameTags
        : undefined;

  // Free-text search (Plan 03.4-10 follow-up). The `?q=...` URL param is
  // serialized by `serializeFilterState` to drive PageHead's search input;
  // pass it through to FeedFilters so listFeedPage + listFeedFacets apply
  // the `search_vec @@ plainto_tsquery('english', $q)` predicate. Trim
  // whitespace at the service boundary, not here — keeps every caller of
  // listFeedPage honest about query semantics.
  const query = state.query !== "" ? state.query : undefined;

  const filters: FeedFilters = {
    show: state.show,
    source: state.source.length > 0 ? state.source : undefined,
    kind: state.kind.length > 0 ? state.kind : undefined,
    gameTags,
    authorIsMe: state.authorIsMe,
    from,
    to,
    query,
  };

  const scope: "live" | "trash" = state.view === "trash" ? "trash" : "live";
  const cursor = state.cursor ?? null;

  // listDeletedEvents joins the parallel fetch ONLY when scope is "live" —
  // the RecoveryDialog on the live feed consumes data.deletedEvents.
  // /feed?view=trash renders the trash rows directly via data.rows
  // (listFeedPage with scope=trash), so the deletedEvents list would be
  // redundant; we still return it (empty) for shape stability.
  const [page, facets, gameRows, sourceRows, deletedRows] = await Promise.all([
    listFeedPage(userId, filters, cursor, { scope, sortDir: state.sortDir }),
    // listFeedFacets — server-side facet counts (Plan 03.4-10 follow-up
    // Option B). Replaces the orchestrator's client-side countWith* helpers
    // which counted on the cursor-paginated first page only; the facets
    // count against the full event pool with the rest of the axes applied,
    // so chip counts are stable across same-axis toggles.
    listFeedFacets(userId, filters, { scope }),
    listGames(userId),
    // Include soft-deleted sources so the feed card can still resolve
    // channelTitle / displayName for events whose parent source the user
    // has removed. Without this, events backed by a now-deleted source
    // render with no source chip — confusing because the events themselves
    // remain in /feed (events are not cascaded when sources go
    // soft-deleted; the user's own historical metadata stays intact).
    listSources(userId, { includeDeleted: true }),
    scope === "live" ? listDeletedEvents(userId) : Promise.resolve([] as never[]),
  ]);

  // ?event=ev_id load-bearing fetch (D-05). When the deep-link target row
  // is NOT in the cursor-paginated feed list, fetch it separately so the
  // modal can resolve `data.rows.find(r => r.id === openEventId)`. Both
  // live and trash modes pass `includeSoftDeleted: scope === "trash"` so
  // trash-mode deep links open even when the row has deletedAt set.
  // NotFoundError catches cross-tenant AND missing — both resolve to a
  // 303 to /feed without the stale ?event= param.
  let rowsForFeed = page.rows;
  if (state.openEventId !== null) {
    const hit = rowsForFeed.find((r) => r.id === state.openEventId);
    if (!hit) {
      try {
        const fallback = await getEventById(userId, state.openEventId, {
          includeSoftDeleted: scope === "trash",
        });
        rowsForFeed = [fallback, ...rowsForFeed];
      } catch (err) {
        if (err instanceof NotFoundError) {
          const cleanUrl = new URL(url);
          cleanUrl.searchParams.delete("event");
          throw redirect(303, cleanUrl.pathname + cleanUrl.search);
        }
        throw err;
      }
    }
  }

  // Batch-load the event_games junction so each EventDto carries its
  // gameIds[] without an N+1 query.
  const [rowDtos, deletedDtos] = await Promise.all([
    mapEventsToDtos(userId, rowsForFeed),
    mapEventsToDtos(userId, deletedRows),
  ]);

  // Adapter-driven feed enrichment. YouTube enriches kind=youtube_video
  // rows with stats + channelTitle; future per-platform adapters enrich
  // their own kinds from per-platform metadata tables.
  for (const adapter of allAdapters) {
    if (adapter.enrichFeedDtos) {
      await adapter.enrichFeedDtos(userId, rowDtos);
    }
  }

  // Enrich source DTOs with the channel display name the feed cards read:
  // YouTube channel_title + Telegram entity title (both via FK at read time, the
  // no-denorm path). Instagram needs no enrichment — its account name is stored
  // on data_sources.display_name at create, which the card reads directly.
  const sourceDtos = sourceRows.map(toDataSourceDto);
  await enrichDataSourceDtosWithYoutubeChannelTitles(sourceDtos);
  await enrichTelegramSourcesWithChannelTitle(sourceDtos);

  // GameDto.releaseDate / .releaseTba derived via JOIN with
  // game_steam_listings — the games row no longer carries the columns
  // (denormalization-audit-2.md V-2). FeedCard's game chip reads
  // `game.releaseDate` for the game it's attached to.
  const releaseByGameId = await deriveReleaseInfoForGames(
    userId,
    gameRows.map((g) => g.id),
  );

  return {
    rows: rowDtos,
    nextCursor: page.nextCursor,
    games: gameRows.map((g) =>
      toGameDto(g, releaseByGameId.get(g.id) ?? { releaseDate: null, releaseTba: false }),
    ),
    sources: sourceDtos,
    deletedEvents: deletedDtos,
    // Phase 03.4 Wave 3 additions:
    //   today        → ISO YYYY-MM-DD string (D-24 server-provided TODAY)
    //   view         → "feed" | "trash" (drives trash banner + BulkActionBar
    //                   variant in the orchestrator)
    //   openEventId  → string | null (drives the EventDetailModal mount in
    //                   the orchestrator; SSR-resolved so the modal renders
    //                   on first paint, not on hydration)
    //   facets       → server-side facet counts for axis chip rows
    //                   (Plan 03.4-10 follow-up Option B). Replaces
    //                   client-side countWith* helpers in the orchestrator.
    today: todayIso,
    view: scope,
    openEventId: state.openEventId,
    facets,
  };
};
