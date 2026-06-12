// events service — barrel re-export + shared types/constants.
//
// Split into three files for maintainability:
//   - events-query.ts  — read-only functions (listFeedPage, listFeedFacets, etc.)
//   - events-mutation.ts — write functions (createEvent, updateEvent, bulkEdit, etc.)
//   - events.ts (this file) — shared types, constants, internal helpers, barrel re-export
//
// Existing imports (`from "services/events.js"`) stay unchanged because
// this barrel re-exports everything from both sub-modules.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { games } from "../db/schema/games.js";
import { events } from "../db/schema/events.js";
import { dataSources } from "../db/schema/data-sources.js";
import type { EventKind } from "$lib/sources/adapter.js";
import type { MediaTypeCategory } from "$lib/feed/media-type-filter.js";
import { NotFoundError } from "./errors.js";

// ── Shared types ───────────────────────────────────────────────────────

export type EventRow = typeof events.$inferSelect;
export type DataSourceRow = typeof dataSources.$inferSelect;

export interface CreateEventInput {
  // M:N: events have ZERO-or-MORE attached games via the event_games
  // junction. Empty array (or omission) means "create in inbox" (no
  // junction rows).
  // The HTTP route schema accepts BOTH `gameId` (deprecated alias) AND
  // `gameIds`; the route's superRefine normalizes singular→plural before
  // calling this service.
  gameIds?: string[];
  kind: EventKind;
  occurredAt: Date | string;
  title: string;
  url?: string | null;
  notes?: string | null;
  metadata?: Record<string, unknown>;
  sourceId?: string | null;
  authorIsMe?: boolean;
  externalId?: string | null;
}

export interface UpdateEventInput {
  kind?: EventKind;
  occurredAt?: Date | string;
  title?: string;
  url?: string | null;
  notes?: string | null;
  // author_is_me toggle so the /events/[id]/edit form can flip the
  // discriminator without re-creating the event.
  authorIsMe?: boolean;
  // gameIds patch. When supplied, calls attachEventToGames BEFORE the main
  // UPDATE so the standalone-conflict guard fires first. Omit to leave the
  // junction unchanged.
  gameIds?: string[];
}

/**
 * ShowFilter — discriminated union collapsing the legacy
 * `attached?: boolean` + `game?: string | string[]` pair into one axis. The
 * UI cannot construct `attached=false AND game=X` simultaneously by
 * construction (FiltersSheet renders one 3-radio for "Show: Any/Inbox/
 * Specific games"); the backend mirrors that constraint by replacing two
 * orthogonal filters with one tagged shape.
 *
 * The `standalone` branch is the "not related to any game" triage state.
 * Standalone events have game_id IS NULL AND
 * metadata.triage.offTopic='true' (URL filter mode name `standalone` stays
 * even though the JSONB key was renamed in Plan 03.4-10). The Show
 * fieldset's 4-option radio (Any / Inbox / Standalone / Specific) cannot
 * represent invalid combinations by construction.
 */
export type ShowFilter =
  | { kind: "any" }
  | { kind: "inbox" }
  | { kind: "standalone" }
  | { kind: "specific"; gameIds: string[] };

/**
 * Sentinel value carried in `FeedFilters.gameTags` to flag the off-topic
 * branch of the GAME axis multi-select. Must stay in lock-step with
 * OFF_TOPIC_TAG in src/lib/feed/url-state.ts — they're the SAME wire value
 * but the two modules don't import each other (client-vs-server isolation).
 */
export const OFF_TOPIC_TAG = "off_topic";

export interface FeedFilters {
  source?: string | string[];
  kind?: EventKind | EventKind[];
  show?: ShowFilter;
  /**
   * GAME axis multi-select (Plan 03.4-10). Each entry is either a game id
   * OR the sentinel `OFF_TOPIC_TAG`. When non-empty, the listFeedPage SQL
   * adds a clause that matches events attached to ANY game in the list OR
   * (when `OFF_TOPIC_TAG` is present) marked off-topic via
   * metadata.triage.offTopic. Empty / undefined = no GAME-axis filter.
   *
   * Replaces the legacy `show: { kind: "specific" | "standalone" }`
   * branches as the canonical input for the GAME axis; those legacy
   * variants are kept on `show` for back-compat with the /api/events HTTP
   * route + FeedQuickNav per-game tab URL contract, but the /feed UI
   * routes through `gameTags` exclusively so off-topic + games can be
   * selected simultaneously.
   */
  gameTags?: string[];
  /**
   * MEDIA-TYPE axis multi-select (Short / Video / Other). Each entry is a
   * MediaTypeCategory. When non-empty, listFeedPage + listFeedFacets add an OR
   * of, per selected category: (a) `events.kind IN (kind-level-default kinds for
   * that category)` and (b) for the per-post kinds (instagram_post /
   * tiktok_post) an EXISTS subquery against the platform cache table
   * (instagram_posts / tiktok_posts) matching media_type values for that
   * category. "other" additionally matches per-post events whose cache row is
   * MISSING (NOT EXISTS) so no event silently vanishes from all three
   * categories — the three categories PARTITION the feed (selecting all three ==
   * no filter). Filtered in SQL (not post-enrichment) so pagination stays
   * honest. Empty / undefined = no media-type filter.
   */
  mediaType?: MediaTypeCategory[];
  authorIsMe?: boolean;
  from?: Date;
  to?: Date;
  /**
   * Free-text search over `events.title` + `events.notes` (Plan 03.4-10
   * follow-up). When non-empty, listFeedPage + listFeedFacets add a
   * `search_vec @@ plainto_tsquery('english', $query)` predicate so the
   * `?q=...` URL param drives a real server-side FTS filter (not the
   * client-side `filter-math` heuristic).
   *
   * `plainto_tsquery` (not `to_tsquery`) handles freeform user input —
   * it auto-ANDs the supplied words and escapes operators that would
   * otherwise raise a syntax error. Empty / undefined / whitespace-only
   * value → no clause appended.
   *
   * The `search_vec` column is a Postgres-side GENERATED ALWAYS AS
   * tsvector backed by GIN index `idx_events_search_vec` (migration
   * drizzle/0044_events_fts.sql). The app never reads or writes the
   * column directly.
   */
  query?: string;
}

export interface FeedPage {
  rows: EventRow[];
  nextCursor: string | null;
}

/**
 * FeedFacets — server-side facet counts for /feed chip rows (Plan 03.4-10
 * follow-up Option B). Each facet count answers the prototype contract
 * (docs/design/v2/ui-kit/app.jsx lines 1394-1409): "how many events would
 * match the rest of the filter state if THIS chip were the only selection
 * on its axis".
 *
 * Stability invariant — toggling a chip on the SAME axis must NOT change
 * other chips' counts on that axis. The server achieves this by stripping
 * the faceted axis from the filter set before counting, then GROUP BY-ing
 * over that axis (or running per-variant COUNT(*) queries for axes without
 * a natural GROUP BY column).
 *
 * Responsiveness invariant — changing DATE / KIND / AUTHOR / SHOW / SOURCE
 * DOES recompute all facets. Other axes are still applied as WHERE
 * predicates inside each facet query, so the facet only excludes its own
 * axis from the filter pipeline.
 *
 * Replaces the legacy client-side `countWithGame/Kind/Show/Author` helpers
 * for the /feed orchestrator (those helpers stay exported for standalone
 * callers + the unit tests they backstop). The legacy helpers counted on
 * `data.rows` — the server-paginated first page (50 rows max) — so chip
 * counts mutated when the user toggled chips. Facets count against the
 * full event pool so the numbers are stable per scope.
 */
export interface FeedFacets {
  /**
   * GAME axis facet. Maps each game id → events attached to that game
   * after the rest of the axes are applied. Adds the OFF_TOPIC_TAG
   * sentinel → count of events where metadata.triage.offTopic === true.
   * Games with zero matching events are OMITTED (callers use `?? 0`).
   */
  gameTags: Record<string, number>;
  /**
   * "All games" sentinel count — events matching every axis EXCEPT the
   * GAME axis (i.e. what the user would see if they cleared gameTags).
   * Stable across same-axis (GAME) toggles, mirrors the per-game chip
   * stability invariant.
   */
  gameTagsAll: number;
  /**
   * KIND axis facet. Maps each EventKind → events with that kind after the
   * rest of the axes are applied. Empty kinds omitted.
   */
  kinds: Record<string, number>;
  /**
   * "All kinds" sentinel count — events matching every axis EXCEPT the
   * KIND axis (i.e. what the user would see if they cleared the kind
   * filter). Stable across same-axis (KIND) toggles.
   */
  kindsAll: number;
  /**
   * SHOW axis facet. `all` = total matching every other axis (the "All"
   * sentinel chip count + the visible-rows count at the page bottom).
   * `inbox` = same with the inbox-eligibility clause applied (zero
   * attached games AND not dismissed AND not off-topic).
   */
  show: { all: number; inbox: number };
  /**
   * MEDIA-TYPE axis facet (Short / Video / Other). Each category → count of
   * events classifying into it after the rest of the axes are applied (the
   * mediaType axis itself excluded). `all` is the sentinel = total matching
   * every other axis with the MEDIA-TYPE axis cleared (stable across same-axis
   * toggles, mirrors kindsAll). Drives the predicted-count tails on the TYPE
   * axis chips.
   */
  mediaType: { short: number; video: number; other: number; all: number };
  /**
   * AUTHOR axis facet. `anyone` is the same as show.all; `mine` filters
   * authorIsMe=true; `others` filters authorIsMe=false.
   */
  author: { anyone: number; mine: number; others: number };
  /**
   * Convenience copy of `show.all` — total events matching ALL axes. Use
   * for "current visible count" displays where the SHOW axis isn't relevant.
   */
  total: number;
}

// ── Shared constants ───────────────────────────────────────────────────

/**
 * VALID_EVENT_KINDS — defense-in-depth mirror of the schema's eventKindEnum.
 * MUST stay in lock-step with src/lib/server/db/schema/events.ts; a unit test
 * asserts list equality against the pgEnum's `.enumValues`.
 */
export const VALID_EVENT_KINDS = [
  "youtube_video",
  "reddit_post",
  "instagram_post",
  "tiktok_post",
  "twitter_post",
  "telegram_post",
  "discord_drop",
  "conference",
  "talk",
  "press",
  "other",
  "post",
] as const satisfies ReadonlyArray<EventKind>;

export const FEED_PAGE_SIZE = 50;

// ── Shared internal helpers ────────────────────────────────────────────

/**
 * Verify gameId ownership BEFORE INSERT/UPDATE so the boundary handles
 * cross-tenant cleanly. Throws NotFoundError on miss / cross-tenant — the
 * HTTP boundary translates to 404 (NOT 500 from a bare PG FK error).
 * Soft-deleted games count as missing.
 *
 * Used by both query (listEventsForGame) and mutation (createEvent,
 * attachEventToGames) modules — lives in the barrel so both can import it.
 */
export async function assertGameOwnedByUser(userId: string, gameId: string): Promise<void> {
  const [row] = await db
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.userId, userId), eq(games.id, gameId), isNull(games.deletedAt)))
    .limit(1);
  if (!row) throw new NotFoundError();
}

// ── Barrel re-exports ──────────────────────────────────────────────────

export {
  listFeedPage,
  listFeedFacets,
  listDeletedEvents,
  getEventById,
  listEventsForGame,
  countEventsByGameIds,
} from "./events-query.js";

export {
  createEvent,
  enrichFromUrl,
  updateEvent,
  softDeleteEvent,
  restoreEvent,
  attachEventToGames,
  dismissFromInbox,
  bulkEdit,
  bulkDelete,
  bulkDeleteForever,
} from "./events-mutation.js";

export type { EnrichmentResult } from "./events-mutation.js";
