import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";
import { getGameById, listGames, deriveReleaseInfoForGames } from "$lib/server/services/games.js";
import { listListings, listSoftDeletedListings } from "$lib/server/services/game-steam-listings.js";
import {
  getWishlistSummary,
  getWishlistSeries,
  type WishlistSummary,
  type WishlistSeries,
} from "$lib/server/services/wishlist-snapshots.js";
import { listEventsForGame } from "$lib/server/services/events.js";
import { listSources } from "$lib/server/services/data-sources.js";
import {
  toGameDto,
  toGameSteamListingDto,
  mapEventsToDtos,
  toDataSourceDto,
  type DerivedReleaseInfo,
} from "$lib/server/dto.js";
import { allAdapters } from "$lib/sources/registry.js";
import { NotFoundError } from "$lib/server/services/errors.js";
import { enrichDataSourceDtosWithYoutubeChannelTitles } from "$lib/server/services/sources-page-read.js";

/**
 * /games/[gameId] loader — unified-events curated layout.
 *
 * Header / store-listings / events. The unified `events` table carries
 * youtube_video rows attached to the game, and the per-user `data_sources`
 * registry replaces any per-game channel M:N.
 *
 * Direct service calls (NOT fetch('/api/...')): the Hono API and the page
 * render in the same Node process, so an HTTP roundtrip back to Hono would
 * deadlock SvelteKit's internal_fetch (Hono routes don't live in
 * SvelteKit's route tree).
 *
 * Loader returns:
 *   - game        : GameDto (userId stripped)
 *   - listings    : GameSteamListingDto[]
 *   - events      : EventDto[] (per-game curated, sorted DESC by occurredAt)
 *   - games       : GameDto[] (used by FeedCard to render attached game chips)
 *   - sources     : DataSourceDto[] (for source-chip resolution on FeedRow)
 *
 * Cross-tenant gameId surfaces as 404 (never 403). Child fetches are
 * best-effort: a service throw on any of them returns an empty array so
 * the rest of the page still renders. The parent fetch is load-bearing —
 * `getGameById` short-circuits cross-tenant access first.
 */
export const load: PageServerLoad = async ({ locals, params, url }) => {
  if (!locals.user) {
    throw error(401, "Sign in required");
  }
  const userId = locals.user.id;
  const gameId = params.gameId;
  // ?view=trash mirrors /games/+page.server.ts — the page renders the
  // game's soft-deleted listings as cards (Restore + Delete forever)
  // instead of the active stores/wishlist UI.
  const view = url.searchParams.get("view") === "trash" ? "trash" : ("feed" as const);

  let game;
  try {
    game = await getGameById(userId, gameId);
  } catch (err) {
    if (err instanceof NotFoundError) throw error(404, "Game not found");
    throw error(500, "Failed to load game");
  }

  // Soft-deleted listings load alongside active ones so /games/[gameId]
  // can mount <RecoveryDialog> with entityType="store". Same defensive
  // best-effort pattern as the other child fetches — a service throw
  // returns empty so the rest of the page still renders.
  const [listings, deletedListings, events, gamesAll, sources] = await Promise.all([
    listListings(userId, gameId).catch(() => []),
    listSoftDeletedListings(userId, gameId).catch(() => []),
    listEventsForGame(userId, gameId).catch(() => []),
    listGames(userId).catch(() => []),
    listSources(userId).catch(() => []),
  ]);

  // Per-game events list carries gameIds[] on each row via the batch
  // junction loader. Multi-game events surface their full attachment set;
  // the rendering page can show "also attached to X, Y".
  const eventDtos = await mapEventsToDtos(userId, events);
  // Adapter-driven feed enrichment for the per-game curated view. Same
  // loop as /feed SSR + GET /api/events.
  for (const adapter of allAdapters) {
    if (adapter.enrichFeedDtos) {
      await adapter.enrichFeedDtos(userId, eventDtos);
    }
  }

  // Populate source.channelTitle from youtube_channels cache, mirroring
  // /feed/+page.server.ts. Without this enrichment, FeedCard's
  // `channelLabel` chain falls from event.channelTitle (null when
  // youtube_videos cache lacks the row) through source.channelTitle
  // (always null per toDataSourceDto default) to source.handleUrl
  // (the raw URL) — visually inconsistent with /feed for the same event.
  const sourceDtos = sources.map(toDataSourceDto);
  await enrichDataSourceDtosWithYoutubeChannelTitles(sourceDtos);

  // Derive THIS game's releaseDate / releaseTba directly from the
  // listings we already loaded — no extra query needed. Mirrors the
  // semantics of deriveReleaseInfoForGames (earliest non-null +
  // any-null-means-TBA). The listings array is already filtered to
  // non-deleted rows by listListings.
  const thisGameDerived: DerivedReleaseInfo = { releaseDate: null, releaseTba: false };
  for (const l of listings) {
    if (l.releaseDate === null) {
      thisGameDerived.releaseTba = true;
    } else if (
      thisGameDerived.releaseDate === null ||
      l.releaseDate < thisGameDerived.releaseDate
    ) {
      thisGameDerived.releaseDate = l.releaseDate;
    }
  }

  // Derived release info for the `games` array (FeedCard chip uses
  // game.releaseDate / .releaseTba via the GameLite type). Uses the
  // batch service so we get one JOIN query for all of the user's
  // games. Excluding the current gameId is not worth the branch — it's
  // a single map lookup and a single row in the WHERE IN clause.
  const allGameIds = gamesAll.map((g) => g.id);
  const allGameRelease = await deriveReleaseInfoForGames(userId, allGameIds);

  // Per-listing wishlist mini-summary (WISH-02, D-09) via the service —
  // NOT db.* in the loader. Best-effort like the other child fetches: a
  // throw on any listing returns null so the rest of the page still
  // renders. Keyed by listingId so SteamListingRow looks up its own
  // summary; a listing with no snapshots maps to null (empty state).
  // The trash view (?view=trash) renders soft-deleted listings only — it
  // never reads `wishlistSummaries`, so skip the per-listing summary fetch
  // entirely there and return an empty map. The active (feed) view is
  // unchanged: one bounded getWishlistSummary per active listing (KISS — no
  // batching for a bounded N).
  const wishlistSummaryPairs =
    view === "trash"
      ? []
      : await Promise.all(
          listings.map(
            async (l): Promise<[string, WishlistSummary | null]> => [
              l.id,
              // No catch: getWishlistSummary already returns null for the
              // legitimate no-data / cross-tenant case, so any throw here is a
              // real fault that should surface as a load error, not be masked
              // as "no wishlist data".
              await getWishlistSummary(userId, l.id),
            ],
          ),
        );
  const wishlistSummaries: Record<string, WishlistSummary | null> =
    Object.fromEntries(wishlistSummaryPairs);

  // VIZ-02 == VIZ-03 (D-12) correlation chart inputs, active view only (the
  // trash view never renders the chart). Both come through services — NO
  // db.* in the loader (routes-call-services). One getWishlistSeries per
  // active listing feeds the WISH-04 daily line + the honest D-13 caption
  // (series.lastImportedAt). KISS — bounded N (active listings), mirrors the
  // wishlistSummaries loop above.
  //
  // The per-day delta map (D-05) is NOT built here: it's keyed by an event's
  // calendar day (timezone-dependent), and this loader runs in the container's
  // UTC. The page builds it CLIENT-side from these `points`, keyed by the local
  // `eventDay` — see the page's chartDeltaByDate.
  const wishlistSeriesByListing: Record<string, WishlistSeries> = {};

  if (view !== "trash" && listings.length > 0) {
    await Promise.all(
      listings.map(async (l) => {
        // No catch: `l.id` comes from the scoped `listListings` above, so
        // getWishlistSeries' ownership gate always passes (empty series when no
        // CSV yet) — any throw is a real fault that should surface as a load error.
        wishlistSeriesByListing[l.id] = await getWishlistSeries(userId, l.id);
      }),
    );
  }

  return {
    view,
    game: toGameDto(game, thisGameDerived),
    listings: listings.map(toGameSteamListingDto),
    wishlistSummaries,
    wishlistSeriesByListing,
    // One server-chosen "now" instant threaded to the chart so the honest
    // D-13 "обновлено Xч назад" caption is computed against the server clock,
    // never the client's new Date() (timezone drift would skew the hours).
    today: new Date().toISOString(),
    deletedListings: deletedListings.map(toGameSteamListingDto),
    events: eventDtos,
    games: gamesAll.map((r) =>
      toGameDto(r, allGameRelease.get(r.id) ?? { releaseDate: null, releaseTba: false }),
    ),
    sources: sourceDtos,
  };
};
