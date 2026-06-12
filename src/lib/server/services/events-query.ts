// events-query — read-only functions split from the unified events service.
//
// Every function takes `userId: string` first (tenant scope) and performs
// only SELECT queries. No INSERT / UPDATE / DELETE happens here.
//
// Re-exported through the barrel `events.ts` so existing imports stay
// unchanged.

import { and, eq, gte, isNull, isNotNull, lte, sql, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { events } from "../db/schema/events.js";
import { eventGames } from "../db/schema/event-games.js";
import { instagramPosts, tiktokPosts } from "../db/schema/index.js";
import { env } from "../config/env.js";
import { NotFoundError } from "./errors.js";
import { encodeCursor, decodeCursor } from "./audit-read.js";
import { kindLevelKindsForCategory, type MediaTypeCategory } from "$lib/feed/media-type-filter.js";
import {
  FEED_PAGE_SIZE,
  OFF_TOPIC_TAG,
  assertGameOwnedByUser,
  type FeedFilters,
  type FeedFacets,
  type FeedPage,
  type EventRow,
} from "./events.js";

// ── Internal helpers (query-only) ──────────────────────────────────────

/**
 * escapeLikePattern — escape user-supplied substrings before splicing into
 * an ILIKE pattern (Plan 03.4-10 hybrid-search follow-up).
 *
 * Hybrid search uses `title ILIKE '%' || $q || '%'` to match substrings the
 * FTS lexer can't reach (e.g. `?q=holl` matching "Hollow Knight"). Raw user
 * input MUST be escaped first so `%` / `_` in the query are treated as
 * literal characters, not ILIKE wildcards — otherwise `?q=100%25` would
 * collapse to `'%100%%'` and match every event with `100` anywhere in the
 * title (wildcard injection).
 *
 * The backslash escape is itself escaped first so a user-supplied `\` is
 * treated as a literal backslash (the default ESCAPE clause in Postgres
 * ILIKE is `\`). Order matters — backslash MUST go first, otherwise the
 * subsequent `%` / `_` escapes would each insert a new `\` that gets
 * double-escaped on the next pass.
 */
function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * pushAxis — array-aware helper for the multi-select feed filter axes
 * (source / kind / game). Treats:
 *   - undefined           → no clause appended (axis omitted from URL)
 *   - empty array         → no clause appended ("nothing selected" === no filter)
 *   - one-element array   → eq(column, value[0])  (zero query-plan regression
 *                            against the single-string back-compat path)
 *   - many-element array  → inArray(column, values)
 *   - bare scalar         → eq(column, value)     (legacy single-string callers)
 *
 * The userId WHERE clause is NOT routed through this helper — it stays
 * lexically present in `listFeedPage`'s `.where(...)` so the
 * `tenant-scope/no-unfiltered-tenant-query` ESLint rule sees it.
 */
import type { PgColumn } from "drizzle-orm/pg-core";

function pushAxis<T>(
  parts: SQL[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  column: PgColumn<any>,
  value: T | T[] | undefined,
): void {
  if (value === undefined) return;
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    if (value.length === 1) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parts.push(eq(column, value[0] as any));
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parts.push(inArray(column, value as any[]));
    }
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parts.push(eq(column, value as any));
  }
}

/**
 * buildMediaTypeClause — the MEDIA-TYPE axis (Short / Video / Other) SQL
 * predicate, shared by listFeedPage + buildFeedBaseFilterParts. Returns a single
 * SQL OR clause, or null when the axis is empty (no filter).
 *
 * Filtered IN SQL (not post-enrichment) so cursor pagination stays honest. For
 * each selected category the clause is an OR of:
 *   (a) KIND-LEVEL — `events.kind IN (kinds whose default category == this one)`
 *       (youtube_video → video; reddit/telegram/twitter/discord/conference/talk/
 *       press/other/post → other; none currently default to short). Per-post
 *       kinds (instagram_post / tiktok_post) are NEVER in this set — they need
 *       the cache-row subquery instead.
 *   (b) PER-POST — an EXISTS subquery against the platform cache table whose
 *       media_type maps to this category:
 *         short → media_type = 'short'
 *         video → media_type = 'video'
 *         other → media_type IN ('image','carousel','text')
 *       The join key is events.external_id → instagram_posts.post_id /
 *       tiktok_posts.aweme_id (the cache PKs — verified against
 *       feed-enrichment.ts).
 *   (c) OTHER also matches per-post events whose cache row is MISSING or whose
 *       media_type is NULL/unrecognized (a NOT EXISTS / NULL arm), so NO event
 *       silently vanishes from all three categories. This is what makes the
 *       three categories PARTITION the feed: selecting all three == no filter.
 *
 * Tenant scope: the EXISTS subqueries hit the PUBLIC-DATA cache tables
 * (instagram_posts / tiktok_posts — ESLint-allowlisted, no userId column),
 * keyed by external_id. The tenant guarantee comes from the outer
 * `eq(events.userId, userId)` clause (mirrors feed-enrichment's public-data
 * read pattern). Raw `sql` is used (not db.select().from(...)) so the
 * structural ESLint tenant rule — which keys on `.from(<Identifier>)` — does
 * not fire.
 */
function buildMediaTypeClause(categories: readonly MediaTypeCategory[] | undefined): SQL | null {
  if (categories === undefined || categories.length === 0) return null;

  const categoryClauses: SQL[] = [];
  for (const category of categories) {
    const orParts: SQL[] = [];

    // (a) Kind-level default kinds for this category.
    const kindLevelKinds = kindLevelKindsForCategory(category);
    if (kindLevelKinds.length > 0) {
      orParts.push(
        sql`${events.kind} IN (${sql.join(
          kindLevelKinds.map((k) => sql`${k}`),
          sql.raw(", "),
        )})` as SQL,
      );
    }

    // (b) Per-post arms (instagram_post + tiktok_post).
    //   - short / video: an EXISTS subquery whose cache-row media_type EQUALS
    //     the category. (short ← 'short', video ← 'video'.)
    //   - other: a NOT EXISTS for a short/video cache row — i.e. the per-post
    //     event is "other" iff it does NOT have a short/video cache row. This
    //     covers media_type IN {image, carousel, text}, NULL media_type, AND a
    //     missing cache row, so NO event vanishes from all three categories
    //     (the categories PARTITION the feed: selecting all three == no filter).
    if (category === "other") {
      orParts.push(
        sql`(${events.kind} = 'instagram_post' AND NOT EXISTS (SELECT 1 FROM ${instagramPosts} WHERE ${instagramPosts.postId} = ${events.externalId} AND ${instagramPosts.mediaType} IN ('short', 'video')))` as SQL,
      );
      orParts.push(
        sql`(${events.kind} = 'tiktok_post' AND NOT EXISTS (SELECT 1 FROM ${tiktokPosts} WHERE ${tiktokPosts.awemeId} = ${events.externalId} AND ${tiktokPosts.mediaType} IN ('short', 'video')))` as SQL,
      );
    } else {
      // short | video — exact media_type match on the cache row.
      orParts.push(
        sql`(${events.kind} = 'instagram_post' AND EXISTS (SELECT 1 FROM ${instagramPosts} WHERE ${instagramPosts.postId} = ${events.externalId} AND ${instagramPosts.mediaType} = ${category}))` as SQL,
      );
      orParts.push(
        sql`(${events.kind} = 'tiktok_post' AND EXISTS (SELECT 1 FROM ${tiktokPosts} WHERE ${tiktokPosts.awemeId} = ${events.externalId} AND ${tiktokPosts.mediaType} = ${category}))` as SQL,
      );
    }

    categoryClauses.push(sql`(${sql.join(orParts, sql.raw(" OR "))})` as SQL);
  }

  // The selected categories are OR'd together (a row matching ANY selected
  // category passes). One category → its clause directly; many → OR-joined.
  return categoryClauses.length === 1
    ? categoryClauses[0]!
    : (sql`(${sql.join(categoryClauses, sql.raw(" OR "))})` as SQL);
}

// ── Exported query functions ───────────────────────────────────────────

/**
 * Per-game curated view over the unified events table. Soft-deleted rows
 * excluded. Cross-tenant gameId throws 404.
 *
 * The legacy `events.game_id` FK is GONE; per-game lookups INNER JOIN
 * through `event_games`. The denormalized
 * `eventGames.userId` column lets the ESLint tenant-scope rule see a literal
 * userId WHERE clause on the junction (the rule cannot inspect FK-chained
 * values). Both `events.userId` AND `eventGames.userId` carry the same
 * caller id, so a forged cross-tenant gameId returns zero rows by
 * construction.
 */
/**
 * countEventsByGameIds — per-game live-event count for the /games list.
 *
 * Returns a Map keyed by gameId with the count of non-soft-deleted
 * events attached via the event_games junction. One GROUP BY query for
 * the whole input set (no N+1).
 *
 * Tenant scope: both `eventGames.userId` and `events.userId` are
 * filtered by the caller's userId. The denormalized userId on the
 * junction is what lets the ESLint tenant-scope rule see the predicate
 * directly without spanning a JOIN.
 *
 * Empty input → empty Map (no query issued). Game ids not present in
 * the result are simply absent — the caller defaults to 0 with
 * `.get(id) ?? 0`. Cross-tenant ids fall out via the userId filters.
 *
 * Extracted from `/games/+page.server.ts` per the routes-call-services
 * audit finding: route handlers MUST go through a service, not raw
 * Drizzle queries.
 */
export async function countEventsByGameIds(
  userId: string,
  gameIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (gameIds.length === 0) return out;
  const rows = await db
    .select({
      gameId: eventGames.gameId,
      count: sql<string>`count(*)`,
    })
    .from(eventGames)
    .innerJoin(events, eq(events.id, eventGames.eventId))
    .where(
      and(
        eq(eventGames.userId, userId),
        eq(events.userId, userId),
        isNull(events.deletedAt),
        inArray(eventGames.gameId, gameIds),
      ),
    )
    .groupBy(eventGames.gameId);
  for (const r of rows) out.set(r.gameId, Number(r.count));
  return out;
}

export async function listEventsForGame(userId: string, gameId: string): Promise<EventRow[]> {
  await assertGameOwnedByUser(userId, gameId);
  // Drizzle's join + select-fields shape: pull the events row out of the
  // joined query so consumers continue to receive `EventRow[]` (no shape
  // change at call sites).
  const rows = await db
    .select({ event: events })
    .from(eventGames)
    .innerJoin(events, eq(eventGames.eventId, events.id))
    .where(
      and(
        eq(eventGames.userId, userId),
        eq(eventGames.gameId, gameId),
        eq(events.userId, userId),
        isNull(events.deletedAt),
      ),
    )
    .orderBy(sql`${events.occurredAt} DESC, ${events.id} DESC`);
  return rows.map((r) => r.event);
}

/**
 * Read one event scoped to userId. Soft-deleted rows count as missing by
 * default. Pass `{ includeSoftDeleted: true }` to surface soft-deleted rows
 * for the Restore flow on /events/[id]?deleted=1 — the userId WHERE clause
 * is unaffected so cross-tenant access still throws NotFoundError
 * regardless of the opts flag (404, never 403).
 */
export async function getEventById(
  userId: string,
  eventId: string,
  opts?: { includeSoftDeleted?: boolean },
): Promise<EventRow> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.id, eventId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError();
  if (row.deletedAt !== null && !opts?.includeSoftDeleted) throw new NotFoundError();
  return row;
}

/**
 * listDeletedEvents — return rows the user can still restore.
 *
 * Tenant scope: userId-first; eq(events.userId, userId) is the first AND
 * clause. Retention window: deletedAt > now() - RETENTION_DAYS days.
 * Past-retention rows are NOT returned (they are pending purge); the UI
 * never surfaces them.
 *
 * Sorted by deletedAt DESC so the most-recently-deleted row rises to the top.
 */
export async function listDeletedEvents(userId: string): Promise<EventRow[]> {
  const cutoff = new Date(Date.now() - env.RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return db
    .select()
    .from(events)
    .where(
      and(eq(events.userId, userId), isNotNull(events.deletedAt), gte(events.deletedAt, cutoff)),
    )
    .orderBy(sql`${events.deletedAt} DESC, ${events.id} DESC`);
}

/**
 * listFeedPage — chronological pool with 7 filter axes + tuple cursor.
 * Returns up to FEED_PAGE_SIZE (50) rows ordered by (occurred_at desc, id desc)
 * plus a nextCursor when more rows exist.
 *
 * Filters:
 *   source       → events.source_id IN (...) (multi-select)
 *   kind         → events.kind IN (...) (multi-select)
 *   show         → discriminated union:
 *                    { kind: 'any' }      → no clause (default)
 *                    { kind: 'inbox' }    → game_id IS NULL AND
 *                                           metadata.inbox.dismissed != true
 *                    { kind: 'specific', gameIds: [...] } → game_id IN (...)
 *   authorIsMe   → events.author_is_me = X
 *   from / to    → events.occurred_at range
 *
 * Cursor format: base64url(JSON.stringify({at: ISO, id})). Reuses
 * encodeCursor / decodeCursor from audit-read.ts. Tuple comparison
 * `(occurred_at, id) < ($1, $2)` is stable under same-millisecond ties
 * because UUIDv7 ids are strictly monotonic.
 *
 * Cross-tenant cursors are safe BY CONSTRUCTION: the userId WHERE clause
 * is INDEPENDENT of the cursor. A forged cross-tenant cursor returns zero
 * of the other tenant's rows because userId is filtered FIRST in the
 * `and(...)` clause and applied independently of any cursor coordinates.
 */
export async function listFeedPage(
  userId: string,
  filters: FeedFilters,
  cursor: string | null,
  opts?: { scope?: "live" | "trash"; sortDir?: "asc" | "desc" },
): Promise<FeedPage> {
  // sortDir flips both the ORDER BY direction AND the cursor comparison
  // operator. With DESC sort the cursor needs <, with ASC sort it needs >.
  const sortAsc = opts?.sortDir === "asc";

  // Search-mode pagination: when `?q=` is active the ORDER BY includes
  // FTS tier + ts_rank which the standard (occurredAt, id) cursor cannot
  // represent. Offset-based pagination is safe here because search
  // result sets are small (bounded by the user's own content volume) and
  // deep-paging is rare. The page offset is encoded inside the cursor
  // string with a "p:" prefix so callers (SSR loader, API route, client
  // loadMore) stay unchanged.
  const trimmedQueryEarly = filters.query?.trim() ?? "";
  const isSearchMode = trimmedQueryEarly !== "";

  let parsedCursor: { at: Date; id: string } | null = null;
  let searchPage = 0;
  if (cursor) {
    if (isSearchMode && cursor.startsWith("p:")) {
      searchPage = Math.max(0, parseInt(cursor.slice(2), 10) || 0);
    } else if (!isSearchMode) {
      parsedCursor = decodeCursor(cursor);
    }
    // When switching between search/non-search modes the old cursor
    // format becomes meaningless — fall through with defaults (page 0
    // or no cursor predicate).
  }

  const cursorClause =
    !isSearchMode && parsedCursor
      ? sortAsc
        ? sql`(${events.occurredAt}, ${events.id}) > (${parsedCursor.at}, ${parsedCursor.id})`
        : sql`(${events.occurredAt}, ${events.id}) < (${parsedCursor.at}, ${parsedCursor.id})`
      : sql`true`;

  // P1: userId filter is the FIRST clause and is literally present in the
  // .where(...) call so the structural ESLint rule recognizes it. Other
  // filter axes are accumulated into a separate array and combined via
  // `and()` — the userId clause stays load-bearing and visible.
  //
  // Phase 3.4 D-19: opts.scope="trash" flips the soft-delete predicate so
  // /feed?view=trash renders the user's trash with the same filter axes
  // (kind/source/show/authorIsMe/from/to) applied. The trash view
  // additionally enforces the 30-day retention cutoff so past-retention
  // rows (pending purge by purgeStaleDeletedEvents) never surface in the
  // UI. Default "live" preserves the legacy isNull(deletedAt) shape.
  const scope = opts?.scope ?? "live";
  const filterParts: SQL[] = [];
  if (scope === "live") {
    filterParts.push(isNull(events.deletedAt) as SQL);
  } else {
    const cutoff = new Date(Date.now() - env.RETENTION_DAYS * 86_400_000);
    filterParts.push(isNotNull(events.deletedAt) as SQL);
    filterParts.push(gte(events.deletedAt, cutoff) as SQL);
  }
  // source / kind are multi-valued. pushAxis turns each axis into eq() or
  // inArray() depending on shape.
  pushAxis(filterParts, events.sourceId, filters.source);
  pushAxis(filterParts, events.kind, filters.kind);
  // Show axis collapses attached + game into a single discriminated union.
  // The UI's 3-radio Show fieldset cannot emit "Inbox AND specific games"
  // simultaneously, so we encode that in the type.
  //
  // Every show.kind branch JOINs against the `event_games` junction. The
  // userId clause is duplicated INSIDE every EXISTS / NOT EXISTS subquery
  // so the eventGames table is also tenant-scoped at the read site (the
  // ESLint tenant-scope rule fires on the outer-only filter; cross-tenant
  // data isolation needs both layers).
  if (filters.show?.kind === "inbox") {
    // Inbox = event has ZERO event_games rows AND not dismissed AND not
    // standalone. The NOT EXISTS subquery is the M:N translation of the
    // legacy `game_id IS NULL` predicate.
    filterParts.push(
      sql`NOT EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId})` as SQL,
    );
    // Inbox view excludes events whose metadata.inbox.dismissed === 'true'.
    // Without this, dismissed events would resurface in the inbox.
    filterParts.push(sql`COALESCE(${events.metadata}->'inbox'->>'dismissed', 'false') = 'false'`);
    // Inbox view ALSO excludes standalone events. "Standalone" is a
    // separate triage state — the user has explicitly said the event is
    // not related to any game, so it does NOT belong in the inbox awaiting
    // triage.
    filterParts.push(sql`COALESCE(${events.metadata}->'triage'->>'offTopic', 'false') = 'false'`);
  } else if (filters.show?.kind === "standalone") {
    // Standalone view = events the user explicitly marked "not related to
    // any game" (a.k.a. off-topic — the JSONB key is `offTopic` since
    // Plan 03.4-10 unified the field name with bulkEdit's write path).
    // The junction-empty clause + metadata.triage.offTopic clause are
    // independent — historically this view excluded attached events
    // because off-topic+attached was forbidden; under the decoupled axes
    // both must hold so the view stays focused on inbox-shaped events.
    filterParts.push(
      sql`NOT EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId})` as SQL,
    );
    filterParts.push(sql`COALESCE(${events.metadata}->'triage'->>'offTopic', 'false') = 'true'`);
  } else if (filters.show?.kind === "specific") {
    if (filters.show.gameIds.length === 1) {
      // Single-game EXISTS subquery — equivalent query plan to the legacy
      // `events.gameId = $1` predicate plus the junction lookup cost.
      const gid = filters.show.gameIds[0]!;
      filterParts.push(
        sql`EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId} AND ${eventGames.gameId} = ${gid})` as SQL,
      );
    } else if (filters.show.gameIds.length > 1) {
      // Multi-game EXISTS subquery — IN over the junction. Drizzle's `inArray`
      // emits a parameterized list; we splice it into the raw subquery via
      // `sql.join` so each value gets its own bind slot (no string
      // interpolation of caller-supplied ids).
      filterParts.push(
        sql`EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId} AND ${eventGames.gameId} IN (${sql.join(
          filters.show.gameIds.map((id) => sql`${id}`),
          sql.raw(", "),
        )}))` as SQL,
      );
    }
    // Empty gameIds = no clause appended — semantically equivalent to "any"
    // (the UI prevents this state but the service stays defensive).
  }
  // show.kind === "any" or undefined: no clause appended (default).

  // GAME axis multi-select (Plan 03.4-10). `filters.gameTags` is a flat
  // array where each entry is EITHER a game id OR the OFF_TOPIC_TAG
  // sentinel. The clause is `(event_games.gameId IN (gameIds_filter)) OR
  // (metadata.triage.offTopic = true)` — OR semantics so the user can pick
  // "Off topic" + "Neotolis: Last Light" at once and see both groups in
  // the same feed.
  //
  // The userId clause is duplicated INSIDE the EXISTS subquery so the
  // event_games junction is tenant-scoped at the read site (mirrors the
  // show.kind === "specific" branch above). Drizzle's `inArray` would
  // require the column ref; we use raw `IN (...)` with `sql.join` so each
  // value gets its own bind slot (no string interpolation of caller-
  // supplied ids).
  if (filters.gameTags !== undefined && filters.gameTags.length > 0) {
    const wantsOffTopic = filters.gameTags.includes(OFF_TOPIC_TAG);
    const gameIdsFilter = filters.gameTags.filter((t) => t !== OFF_TOPIC_TAG);
    const orParts: SQL[] = [];
    if (gameIdsFilter.length === 1) {
      const gid = gameIdsFilter[0]!;
      orParts.push(
        sql`EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId} AND ${eventGames.gameId} = ${gid})` as SQL,
      );
    } else if (gameIdsFilter.length > 1) {
      orParts.push(
        sql`EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId} AND ${eventGames.gameId} IN (${sql.join(
          gameIdsFilter.map((id) => sql`${id}`),
          sql.raw(", "),
        )}))` as SQL,
      );
    }
    if (wantsOffTopic) {
      orParts.push(
        sql`COALESCE(${events.metadata}->'triage'->>'offTopic', 'false') = 'true'` as SQL,
      );
    }
    if (orParts.length === 1) {
      filterParts.push(orParts[0]!);
    } else if (orParts.length > 1) {
      // Combine via SQL OR. Drizzle's `or(...)` would work but emits
      // parens around each operand; raw OR-join keeps the SQL compact and
      // mirrors the manual subquery pattern used elsewhere in this file.
      filterParts.push(sql`(${sql.join(orParts, sql.raw(" OR "))})` as SQL);
    }
  }

  // MEDIA-TYPE axis (Short / Video / Other) — filtered in SQL so pagination
  // stays honest. See buildMediaTypeClause for the full kind-level + per-post
  // cache-row partition rationale.
  const mediaTypeClause = buildMediaTypeClause(filters.mediaType);
  if (mediaTypeClause !== null) filterParts.push(mediaTypeClause);

  if (filters.authorIsMe !== undefined) {
    filterParts.push(eq(events.authorIsMe, filters.authorIsMe));
  }
  if (filters.from !== undefined) {
    filterParts.push(gte(events.occurredAt, filters.from));
  }
  if (filters.to !== undefined) {
    filterParts.push(lte(events.occurredAt, filters.to));
  }

  // Hybrid search predicate (Plan 03.4-10 follow-up — pg_trgm rollout).
  //
  // Two complementary halves run as an OR union:
  //   1. FTS — `search_vec @@ plainto_tsquery('english', $q)`. Word-level
  //      English stemming (`promote` matches `promotion`, `viking` matches
  //      `vikings`), backed by GIN(search_vec). `plainto_tsquery` (not
  //      `to_tsquery`) accepts freeform input — auto-ANDs words and
  //      escapes operators that would otherwise raise `syntax error in
  //      tsquery` (e.g. `?q=foo!bar`).
  //   2. Trigram — `title ILIKE '%q%' OR notes ILIKE '%q%'`. Substring
  //      search (`?q=holl` matches "Hollow Knight"), backed by
  //      GIN(title gin_trgm_ops) + GIN(notes gin_trgm_ops) from migration
  //      0045. Trigrams turn what would be O(n) seq scans into O(log n)
  //      index-backed lookups; the planner picks the trigram GIN
  //      automatically for `column ILIKE '%pattern%'` shape (NOT the
  //      anchored `'pattern%'` shape — that uses btree).
  //
  // User input is splice-escaped via escapeLikePattern so `%` / `_` from
  // the user are treated as literals (wildcard injection guard); the SQL
  // bind itself is parameterized so the value never lands inline.
  //
  // Ranking ORDER BY (when query is set): FTS matches sort first (rank 0),
  // partial-only matches sort second (rank 1); within each tier sort by
  // ts_rank DESC for FTS relevance, then by occurred_at DESC. Without
  // ranking, an FTS-perfect match buried under partial matches would
  // surface AFTER less-relevant trigram hits sharing the same date.
  //
  // Whitespace-only queries are dropped (treated as "no filter") so the
  // user typing then deleting characters doesn't briefly return an empty
  // result set. The trim happens here at the service boundary rather
  // than in the loader so every caller benefits.
  const trimmedQuery = filters.query?.trim() ?? "";
  const hasQuery = trimmedQuery !== "";
  if (hasQuery) {
    const likePattern = `%${escapeLikePattern(trimmedQuery)}%`;
    filterParts.push(
      sql`(
      ${events.searchVec} @@ plainto_tsquery('english', ${trimmedQuery})
      OR ${events.title} ILIKE ${likePattern}
      OR COALESCE(${events.notes}, '') ILIKE ${likePattern}
    )` as SQL,
    );
  }

  // ORDER BY: when the query is active, tier FTS matches above trigram-only
  // matches, then within each tier order by ts_rank (relevance) and
  // finally occurred_at. When no query, fall back to the legacy cursor
  // ordering (occurred_at + id, asc or desc per opts.sortDir).
  const orderBy = hasQuery
    ? sortAsc
      ? sql`
          CASE WHEN ${events.searchVec} @@ plainto_tsquery('english', ${trimmedQuery}) THEN 0 ELSE 1 END,
          ts_rank(${events.searchVec}, plainto_tsquery('english', ${trimmedQuery})) DESC,
          ${events.occurredAt} ASC, ${events.id} ASC
        `
      : sql`
          CASE WHEN ${events.searchVec} @@ plainto_tsquery('english', ${trimmedQuery}) THEN 0 ELSE 1 END,
          ts_rank(${events.searchVec}, plainto_tsquery('english', ${trimmedQuery})) DESC,
          ${events.occurredAt} DESC, ${events.id} DESC
        `
    : sortAsc
      ? sql`${events.occurredAt} ASC, ${events.id} ASC`
      : sql`${events.occurredAt} DESC, ${events.id} DESC`;

  const baseQuery = db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), ...filterParts, cursorClause))
    .orderBy(orderBy)
    .limit(FEED_PAGE_SIZE + 1);

  const rows = isSearchMode ? await baseQuery.offset(searchPage * FEED_PAGE_SIZE) : await baseQuery;

  const hasMore = rows.length > FEED_PAGE_SIZE;
  const page = rows.slice(0, FEED_PAGE_SIZE);

  let nextCursor: string | null = null;
  if (hasMore) {
    if (isSearchMode) {
      nextCursor = `p:${searchPage + 1}`;
    } else {
      const last = page[page.length - 1];
      if (last) nextCursor = encodeCursor(last.occurredAt, last.id);
    }
  }

  return { rows: page, nextCursor };
}

/**
 * buildFeedBaseFilterParts — shared WHERE-clause builder for listFeedPage +
 * listFeedFacets. Returns the same SQL[] array that listFeedPage assembles
 * for its `and(eq(events.userId, userId), ...filterParts)` clause MINUS the
 * cursor and the axes the caller asked to exclude.
 *
 * `exclude` is a set of axis names — when an axis is excluded, its WHERE
 * clause is NOT appended. Used by listFeedFacets so each facet query
 * excludes its own axis (the faceted axis becomes the GROUP BY / variant
 * dimension instead of a filter). The userId clause is NEVER routed
 * through this helper — callers add it directly to their .where(...) so
 * the ESLint tenant-scope rule sees it lexically.
 */
type FeedAxis = "kind" | "source" | "show" | "gameTags" | "mediaType" | "author" | "date" | "query";
function buildFeedBaseFilterParts(
  userId: string,
  filters: FeedFilters,
  scope: "live" | "trash",
  exclude: ReadonlySet<FeedAxis>,
): SQL[] {
  const filterParts: SQL[] = [];

  // Soft-delete predicate — always applied, regardless of `exclude`.
  if (scope === "live") {
    filterParts.push(isNull(events.deletedAt) as SQL);
  } else {
    const cutoff = new Date(Date.now() - env.RETENTION_DAYS * 86_400_000);
    filterParts.push(isNotNull(events.deletedAt) as SQL);
    filterParts.push(gte(events.deletedAt, cutoff) as SQL);
  }

  if (!exclude.has("source")) pushAxis(filterParts, events.sourceId, filters.source);
  if (!exclude.has("kind")) pushAxis(filterParts, events.kind, filters.kind);

  if (!exclude.has("show")) {
    if (filters.show?.kind === "inbox") {
      filterParts.push(
        sql`NOT EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId})` as SQL,
      );
      filterParts.push(sql`COALESCE(${events.metadata}->'inbox'->>'dismissed', 'false') = 'false'`);
      filterParts.push(sql`COALESCE(${events.metadata}->'triage'->>'offTopic', 'false') = 'false'`);
    } else if (filters.show?.kind === "standalone") {
      filterParts.push(
        sql`NOT EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId})` as SQL,
      );
      filterParts.push(sql`COALESCE(${events.metadata}->'triage'->>'offTopic', 'false') = 'true'`);
    } else if (filters.show?.kind === "specific") {
      if (filters.show.gameIds.length === 1) {
        const gid = filters.show.gameIds[0]!;
        filterParts.push(
          sql`EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId} AND ${eventGames.gameId} = ${gid})` as SQL,
        );
      } else if (filters.show.gameIds.length > 1) {
        filterParts.push(
          sql`EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId} AND ${eventGames.gameId} IN (${sql.join(
            filters.show.gameIds.map((id) => sql`${id}`),
            sql.raw(", "),
          )}))` as SQL,
        );
      }
    }
  }

  if (!exclude.has("gameTags") && filters.gameTags !== undefined && filters.gameTags.length > 0) {
    const wantsOffTopic = filters.gameTags.includes(OFF_TOPIC_TAG);
    const gameIdsFilter = filters.gameTags.filter((t) => t !== OFF_TOPIC_TAG);
    const orParts: SQL[] = [];
    if (gameIdsFilter.length === 1) {
      const gid = gameIdsFilter[0]!;
      orParts.push(
        sql`EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId} AND ${eventGames.gameId} = ${gid})` as SQL,
      );
    } else if (gameIdsFilter.length > 1) {
      orParts.push(
        sql`EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId} AND ${eventGames.gameId} IN (${sql.join(
          gameIdsFilter.map((id) => sql`${id}`),
          sql.raw(", "),
        )}))` as SQL,
      );
    }
    if (wantsOffTopic) {
      orParts.push(
        sql`COALESCE(${events.metadata}->'triage'->>'offTopic', 'false') = 'true'` as SQL,
      );
    }
    if (orParts.length === 1) filterParts.push(orParts[0]!);
    else if (orParts.length > 1)
      filterParts.push(sql`(${sql.join(orParts, sql.raw(" OR "))})` as SQL);
  }

  if (!exclude.has("mediaType")) {
    const mediaTypeClause = buildMediaTypeClause(filters.mediaType);
    if (mediaTypeClause !== null) filterParts.push(mediaTypeClause);
  }

  if (!exclude.has("author") && filters.authorIsMe !== undefined) {
    filterParts.push(eq(events.authorIsMe, filters.authorIsMe));
  }
  if (!exclude.has("date")) {
    if (filters.from !== undefined) filterParts.push(gte(events.occurredAt, filters.from));
    if (filters.to !== undefined) filterParts.push(lte(events.occurredAt, filters.to));
  }

  // Hybrid search predicate carries through to facet counts so chip
  // counts respect the current `?q=...` scope. Mirrors listFeedPage's
  // FTS-OR-trigram clause exactly — without it, partial-match queries
  // (`?q=holl`) would show inflated facet counts compared to the page
  // results. The query axis is NEVER a facet (there are no chips to
  // render), but it IS a filter that should narrow every other facet's
  // count — exclude.has("query") is therefore effectively always false
  // in current callers. See listFeedPage for the full hybrid-search
  // rationale + ranking notes.
  if (!exclude.has("query")) {
    const trimmedQuery = filters.query?.trim() ?? "";
    if (trimmedQuery !== "") {
      const likePattern = `%${escapeLikePattern(trimmedQuery)}%`;
      filterParts.push(
        sql`(
        ${events.searchVec} @@ plainto_tsquery('english', ${trimmedQuery})
        OR ${events.title} ILIKE ${likePattern}
        OR COALESCE(${events.notes}, '') ILIKE ${likePattern}
      )` as SQL,
      );
    }
  }

  return filterParts;
}

/**
 * listFeedFacets — server-side facet counts for the /feed chip rows
 * (Plan 03.4-10 follow-up Option B).
 *
 * Returns one count per chip on each filter axis, computed against the
 * FULL event pool (not the cursor-paginated first page). Each facet
 * query applies all axes EXCEPT the one being faceted, so chip counts
 * are stable when chips on the SAME axis are toggled but recompute when
 * other axes change.
 *
 * Four facet queries run in parallel via Promise.all:
 *   1. GAME — GROUP BY game_id via event_games junction (+ off-topic sentinel).
 *   2. KIND — GROUP BY events.kind.
 *   3. SHOW — two COUNT queries (all + inbox-eligible).
 *   4. AUTHOR — three COUNT queries (anyone + mine + others).
 *
 * Tenant scope: every query carries `eq(events.userId, userId)` as a
 * first-class WHERE clause + every junction reference duplicates the
 * userId filter inside the EXISTS/JOIN subquery (mirrors listFeedPage).
 *
 * Total latency: each facet is one query and they all run concurrently,
 * so the wall-clock cost is `max(query_time)` not `sum(query_time)`.
 * Combined with the loader's existing parallel listFeedPage / listGames /
 * listSources fetch, the facets piggyback on the same Promise.all batch
 * with no incremental round-trip cost.
 */
export async function listFeedFacets(
  userId: string,
  filters: FeedFilters,
  opts?: { scope?: "live" | "trash" },
): Promise<FeedFacets> {
  const scope = opts?.scope ?? "live";

  // GAME facet — exclude the gameTags axis from the base filter, then
  // GROUP BY game_id via the junction. Off-topic sentinel is counted via a
  // separate query (it's a metadata flag, not a game id, so it can't share
  // the GROUP BY).
  const gameBaseParts = buildFeedBaseFilterParts(userId, filters, scope, new Set(["gameTags"]));

  const gameGroupQuery = db
    .select({
      gameId: eventGames.gameId,
      // count(*) emits bigint; Postgres returns it as a JS string from the
      // driver, so we cast to text + parse on the client. Drizzle's
      // sql<number> generic forces the typed shape.
      count: sql<string>`count(*)`,
    })
    .from(events)
    .innerJoin(eventGames, and(eq(eventGames.eventId, events.id), eq(eventGames.userId, userId)))
    .where(and(eq(events.userId, userId), ...gameBaseParts))
    .groupBy(eventGames.gameId);

  const offTopicQuery = db
    .select({ count: sql<string>`count(*)` })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        ...gameBaseParts,
        sql`COALESCE(${events.metadata}->'triage'->>'offTopic', 'false') = 'true'`,
      ),
    );

  // "All games" sentinel count — total events matching the GAME-axis-
  // excluded base (= count of every event the user would see if they
  // cleared gameTags). DISTINCT because a single event attached to two
  // games would double-count via the junction GROUP BY.
  const gameTagsAllQuery = db
    .select({ count: sql<string>`count(*)` })
    .from(events)
    .where(and(eq(events.userId, userId), ...gameBaseParts));

  // KIND facet — exclude the kind axis from the base filter, then GROUP BY
  // events.kind.
  const kindBaseParts = buildFeedBaseFilterParts(userId, filters, scope, new Set(["kind"]));
  const kindGroupQuery = db
    .select({ kind: events.kind, count: sql<string>`count(*)` })
    .from(events)
    .where(and(eq(events.userId, userId), ...kindBaseParts))
    .groupBy(events.kind);
  const kindsAllQuery = db
    .select({ count: sql<string>`count(*)` })
    .from(events)
    .where(and(eq(events.userId, userId), ...kindBaseParts));

  // SHOW facet — `all` reuses the full-axes base count; `inbox` adds the
  // inbox-eligibility clause on top of a base that excludes the SHOW axis.
  const showBaseParts = buildFeedBaseFilterParts(userId, filters, scope, new Set(["show"]));
  const showAllQuery = db
    .select({ count: sql<string>`count(*)` })
    .from(events)
    .where(and(eq(events.userId, userId), ...showBaseParts));
  const showInboxQuery = db
    .select({ count: sql<string>`count(*)` })
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        ...showBaseParts,
        sql`NOT EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId})` as SQL,
        sql`COALESCE(${events.metadata}->'inbox'->>'dismissed', 'false') = 'false'`,
        sql`COALESCE(${events.metadata}->'triage'->>'offTopic', 'false') = 'false'`,
      ),
    );

  // MEDIA-TYPE facet — exclude the mediaType axis from the base, then run one
  // COUNT per category with the single-category clause applied. `all` is the
  // base count with the axis cleared (the "All" sentinel chip). Each per-
  // category count answers "how many events would match if THIS were the only
  // TYPE selection" — stable across same-axis toggles (the axis is excluded
  // from the base).
  const mediaTypeBaseParts = buildFeedBaseFilterParts(
    userId,
    filters,
    scope,
    new Set(["mediaType"]),
  );
  const mediaTypeAllQuery = db
    .select({ count: sql<string>`count(*)` })
    .from(events)
    .where(and(eq(events.userId, userId), ...mediaTypeBaseParts));
  const mediaTypeShortQuery = db
    .select({ count: sql<string>`count(*)` })
    .from(events)
    .where(and(eq(events.userId, userId), ...mediaTypeBaseParts, buildMediaTypeClause(["short"])!));
  const mediaTypeVideoQuery = db
    .select({ count: sql<string>`count(*)` })
    .from(events)
    .where(and(eq(events.userId, userId), ...mediaTypeBaseParts, buildMediaTypeClause(["video"])!));
  const mediaTypeOtherQuery = db
    .select({ count: sql<string>`count(*)` })
    .from(events)
    .where(and(eq(events.userId, userId), ...mediaTypeBaseParts, buildMediaTypeClause(["other"])!));

  // AUTHOR facet — `anyone` reuses the full-axes base count; `mine` /
  // `others` apply the authorIsMe predicate on the author-excluded base.
  const authorBaseParts = buildFeedBaseFilterParts(userId, filters, scope, new Set(["author"]));
  const authorAnyoneQuery = db
    .select({ count: sql<string>`count(*)` })
    .from(events)
    .where(and(eq(events.userId, userId), ...authorBaseParts));
  const authorMineQuery = db
    .select({ count: sql<string>`count(*)` })
    .from(events)
    .where(and(eq(events.userId, userId), ...authorBaseParts, eq(events.authorIsMe, true)));
  const authorOthersQuery = db
    .select({ count: sql<string>`count(*)` })
    .from(events)
    .where(and(eq(events.userId, userId), ...authorBaseParts, eq(events.authorIsMe, false)));

  // TOTAL — full-axes count (no exclusions). Drives data.facets.total +
  // the "All games" / "All kinds" sentinel chip predictions.
  const totalParts = buildFeedBaseFilterParts(userId, filters, scope, new Set());
  const totalQuery = db
    .select({ count: sql<string>`count(*)` })
    .from(events)
    .where(and(eq(events.userId, userId), ...totalParts));

  const [
    gameRows,
    offTopicRows,
    gameTagsAllRows,
    kindRows,
    kindsAllRows,
    showAllRows,
    showInboxRows,
    mediaTypeAllRows,
    mediaTypeShortRows,
    mediaTypeVideoRows,
    mediaTypeOtherRows,
    authorAnyoneRows,
    authorMineRows,
    authorOthersRows,
    totalRows,
  ] = await Promise.all([
    gameGroupQuery,
    offTopicQuery,
    gameTagsAllQuery,
    kindGroupQuery,
    kindsAllQuery,
    showAllQuery,
    showInboxQuery,
    mediaTypeAllQuery,
    mediaTypeShortQuery,
    mediaTypeVideoQuery,
    mediaTypeOtherQuery,
    authorAnyoneQuery,
    authorMineQuery,
    authorOthersQuery,
    totalQuery,
  ]);

  const gameTags: Record<string, number> = {};
  for (const r of gameRows) gameTags[r.gameId] = Number(r.count);
  const offTopicCount = Number(offTopicRows[0]?.count ?? 0);
  if (offTopicCount > 0) gameTags[OFF_TOPIC_TAG] = offTopicCount;

  const kinds: Record<string, number> = {};
  for (const r of kindRows) kinds[r.kind] = Number(r.count);

  return {
    gameTags,
    gameTagsAll: Number(gameTagsAllRows[0]?.count ?? 0),
    kinds,
    kindsAll: Number(kindsAllRows[0]?.count ?? 0),
    show: {
      all: Number(showAllRows[0]?.count ?? 0),
      inbox: Number(showInboxRows[0]?.count ?? 0),
    },
    mediaType: {
      short: Number(mediaTypeShortRows[0]?.count ?? 0),
      video: Number(mediaTypeVideoRows[0]?.count ?? 0),
      other: Number(mediaTypeOtherRows[0]?.count ?? 0),
      all: Number(mediaTypeAllRows[0]?.count ?? 0),
    },
    author: {
      anyone: Number(authorAnyoneRows[0]?.count ?? 0),
      mine: Number(authorMineRows[0]?.count ?? 0),
      others: Number(authorOthersRows[0]?.count ?? 0),
    },
    total: Number(totalRows[0]?.count ?? 0),
  };
}
