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
import { db } from "$lib/server/db/client.js";
import { youtubeVideoSnapshots } from "$lib/server/db/schema/youtube-video-snapshots.js";
import { youtubeChannels } from "$lib/server/db/schema/youtube-channels.js";
import { sql, inArray } from "drizzle-orm";

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
  // Plan 02.1-37 (UAT-NOTES.md §5.13): filter unknown kinds out before they
  // reach Drizzle's inArray(events.kind, [...]) clause. A malformed URL like
  // /feed?kind=foo would otherwise surface as a Postgres 500 (unknown enum
  // value). Silent drop matches the existing ?show= malformed-param fallback
  // at lines 87-95 — defensive validation, not user-visible error.
  const kindList = filterValidKinds(url.searchParams.getAll("kind"));
  const gameList = url.searchParams.getAll("game");

  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const allParam = url.searchParams.get("all");

  // Phase 3.0 post-build (UAT 2026-05-06): default is now All-time. The
  // 30-day implicit window from Plan 02.1-15 Gap 9 was confusing — a fresh
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

  // Plan 02.1-19: ?show=any|inbox|specific URL contract. Default = "any".
  // Any other value (including null / unrecognized) falls back to "any" so a
  // malformed URL doesn't 500 — the chip strip will simply show no Show chip.
  // Plan 02.1-24: adds 'standalone' for the new triage-state filter.
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
    // Plan 02.1-37: kindList is now EventKind[] (filtered against VALID_EVENT_KINDS
    // via filterValidKinds above), so the historical cast is no longer needed.
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

  // Plan 02.1-14 (gap closure): listDeletedEvents joins the parallel fetch
  // so the /feed page can render the soft-delete recovery panel below the
  // CursorPager. retentionDays is forwarded from +layout.server.ts (the
  // SOLE process.env reader path — CLAUDE.md / AGENTS.md hard rule).
  const [page, gameRows, sourceRows, deletedRows] = await Promise.all([
    listFeedPage(userId, filters, cursor),
    listGames(userId),
    // Phase 3.0 post-build (UAT 2026-05-06): include soft-deleted sources
    // so the feed card can still resolve channelTitle / displayName for
    // events whose parent source the user has removed. Without this, events
    // backed by a now-deleted source render with no source chip — confusing
    // because the events themselves remain in /feed (events are not cascaded
    // when sources go soft-deleted; the user's own historical metadata stays
    // intact). The UI may surface a "(removed)" suffix on the chip later.
    listSources(userId, { includeDeleted: true }),
    listDeletedEvents(userId),
  ]);

  // Plan 02.1-28: mapEventsToDtos batch-loads the event_games junction rows
  // so each EventDto carries its gameIds[] without an N+1 query (one
  // junction lookup per page; one for the deletedEvents list).
  const [rowDtos, deletedDtos] = await Promise.all([
    mapEventsToDtos(userId, page.rows),
    mapEventsToDtos(userId, deletedRows),
  ]);

  // Phase 3.0 post-build (UAT 2026-05-06): attach the latest YouTube stats
  // snapshot to each youtube_video event in the feed. Single batched DISTINCT
  // ON query — one DB round-trip regardless of page size. The snapshot table
  // is public-data (no userId scope) so we filter only by external_id; the
  // events list itself is already userId-scoped at listFeedPage.
  const youtubeExternalIds = rowDtos
    .filter((r) => r.kind === "youtube_video" && r.externalId !== null)
    .map((r) => r.externalId as string);
  if (youtubeExternalIds.length > 0) {
    const snapshots = await db
      .select({
        videoId: youtubeVideoSnapshots.videoId,
        polledAt: youtubeVideoSnapshots.polledAt,
        viewCount: youtubeVideoSnapshots.viewCount,
        likeCount: youtubeVideoSnapshots.likeCount,
        commentCount: youtubeVideoSnapshots.commentCount,
      })
      .from(youtubeVideoSnapshots)
      .where(inArray(youtubeVideoSnapshots.videoId, youtubeExternalIds))
      .orderBy(youtubeVideoSnapshots.videoId, sql`${youtubeVideoSnapshots.polledAt} DESC`);
    const latest = new Map<
      string,
      { viewCount: number; likeCount: number; commentCount: number; polledAt: Date }
    >();
    for (const s of snapshots) {
      if (!latest.has(s.videoId)) {
        latest.set(s.videoId, {
          viewCount: s.viewCount ?? 0,
          likeCount: s.likeCount ?? 0,
          commentCount: s.commentCount ?? 0,
          polledAt: s.polledAt,
        });
      }
    }
    for (const r of rowDtos) {
      if (r.kind === "youtube_video" && r.externalId) {
        r.stats = latest.get(r.externalId) ?? null;
      }
    }
  }

  // Phase 3.0 post-build: enrich source DTOs with the YouTube channel_title
  // from cache so the feed card can show the real channel name alongside
  // the user's own displayName. One batched lookup keyed on every distinct
  // channelId across all loaded sources.
  const sourceDtos = sourceRows.map(toDataSourceDto);
  const channelIds = sourceDtos
    .map((s) => s.channelId)
    .filter((c): c is string => c !== null);
  if (channelIds.length > 0) {
    const cacheRows = await db
      .select({
        channelId: youtubeChannels.channelId,
        channelTitle: youtubeChannels.channelTitle,
      })
      .from(youtubeChannels)
      .where(inArray(youtubeChannels.channelId, channelIds));
    const titleByChannel = new Map<string, string | null>();
    for (const r of cacheRows) titleByChannel.set(r.channelId, r.channelTitle);
    for (const s of sourceDtos) {
      if (s.channelId) s.channelTitle = titleByChannel.get(s.channelId) ?? null;
    }
  }

  return {
    rows: rowDtos,
    nextCursor: page.nextCursor,
    games: gameRows.map(toGameDto),
    sources: sourceDtos,
    // Plan 02.1-14 (preserved): listDeletedEvents flows through the loader
    // so /feed renders the soft-delete recovery panel without a second
    // round-trip. retentionDays continues to come from the layout
    // pass-through (CLAUDE.md / AGENTS.md hard rule — only env.ts reads
    // process.env; the layout already exposes RETENTION_DAYS).
    deletedEvents: deletedDtos,
    activeFilters: {
      // Plan 02.1-15: array form for the multi-value axes — always present,
      // possibly empty. The chip strip / sheet always treat them as
      // string[] so single-value renders the same as zero-value.
      source: sourceList,
      kind: kindList,
      // Plan 02.1-19: merged 'show' axis replaces game + attached pair.
      // Plan 02.1-24: adds 'standalone' branch.
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
      // Phase 3.0 post-build (UAT 2026-05-06): the implicit 30-day
      // default window from Plan 02.1-15 Gap 9 was retired. /feed now
      // defaults to All-time. defaultDateRange always false here so the
      // FilterChips strip never renders the "Last 30 days (default)"
      // chip; `all` is true whenever the user hasn't picked a from/to.
      defaultDateRange: false,
      all: fromParam === null && toParam === null,
    },
  };
};
