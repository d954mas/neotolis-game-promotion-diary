// events service — unified-table CRUD + feed + inbox + per-game view (Phase 2.1).
//
// REPLACES the Phase 2 `events` + `tracked_youtube_videos` split. One row per
// (user, occurrence) regardless of platform. `kind` discriminates platform;
// `author_is_me` discriminates own content from blogger / community coverage;
// nullable `source_id` distinguishes auto-imported from manually-pasted events;
// nullable `game_id` distinguishes attached from inbox events.
//
// Pattern 1 (tenant scope): EVERY function takes `userId: string` first; EVERY
// Drizzle query .where()-clauses on `eq(events.userId, userId)`. The custom
// ESLint rule `tenant-scope/no-unfiltered-tenant-query` (Plan 02-02 / 02.1-01)
// fires on any query that omits this filter — disable comments NOT allowed.
//
// VALID_EVENT_KINDS mirrors the schema enum (Pitfall 6 — defense-in-depth).
// A unit/integration test asserts list equality so a schema enum change forces
// a service-layer update.
//
// listFeedPage (RESEARCH §3.3): chronological pool with 7 filter axes + tuple
// cursor on (occurred_at desc, id desc). Reuses encodeCursor / decodeCursor
// from audit-read.ts (Phase 2 D-31 cursor format). PITFALL P19 mitigation by
// construction: the userId WHERE clause is independent of the cursor — a
// forged cross-tenant cursor returns zero of the other tenant's rows.
//
// attachToGame (RESEARCH §3.4 + Pitfall 4): validates the target gameId
// belongs to the user BEFORE the UPDATE. Cross-tenant attach returns
// NotFoundError → 404 (NOT 500 from a bare PG FK error). Audit-logged
// `event.attached_to_game`.
//
// dismissFromInbox (RESEARCH §6.4): writes metadata.inbox.dismissed=true via
// jsonb_set; only valid on inbox events (game_id IS NULL); otherwise throws
// AppError 'not_in_inbox' (422). Audit-logged `event.dismissed_from_inbox`.
//
// createEventFromPaste — INGEST-02/03/04 reframed under unified events. The
// YouTube paste flow no longer writes to a separate tracked_youtube_videos
// table; one events row carries everything. INGEST-03 author_is_me inheritance:
// match oEmbed.author_url against registered data_sources by handleUrl exact
// match (case-sensitive in 2.1; case-insensitive is a Phase 6 polish).
//
// Audit (D-32 + Phase 2.1): event.created on INSERT, event.edited on UPDATE,
// event.deleted on softDelete, event.attached_to_game on attach, and
// event.dismissed_from_inbox on dismiss.

import { and, eq, gte, isNull, isNotNull, lte, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { events } from "../db/schema/events.js";
import { games } from "../db/schema/games.js";
import { dataSources } from "../db/schema/data-sources.js";
import type { EventKind } from "../integrations/data-source-adapter.js";
import { writeAudit } from "../audit.js";
import { AppError, NotFoundError } from "./errors.js";
import { encodeCursor, decodeCursor } from "./audit-read.js";

export type EventRow = typeof events.$inferSelect;
export type DataSourceRow = typeof dataSources.$inferSelect;

/**
 * VALID_EVENT_KINDS — defense-in-depth mirror of the schema's eventKindEnum
 * (Pitfall 6). MUST stay in lock-step with src/lib/server/db/schema/events.ts;
 * a unit test asserts list equality against the pgEnum's `.enumValues`.
 */
export const VALID_EVENT_KINDS = [
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
] as const satisfies ReadonlyArray<EventKind>;

export const FEED_PAGE_SIZE = 50;

const TITLE_MIN = 1;
const TITLE_MAX = 500;

export interface CreateEventInput {
  gameId?: string | null;
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
}

export interface PasteInput {
  url: string;
  gameId?: string | null;
}

export interface FeedFilters {
  source?: string;
  kind?: EventKind;
  game?: string;
  attached?: boolean;
  authorIsMe?: boolean;
  from?: Date;
  to?: Date;
}

export interface FeedPage {
  rows: EventRow[];
  nextCursor: string | null;
}

function assertValidKind(kind: string): asserts kind is EventKind {
  if (!(VALID_EVENT_KINDS as readonly string[]).includes(kind)) {
    throw new AppError(
      `kind must be one of: ${VALID_EVENT_KINDS.join(", ")}`,
      "validation_failed",
      422,
      { field: "kind" },
    );
  }
}

function validateTitle(title: string): void {
  const trimmed = title.trim();
  if (trimmed.length < TITLE_MIN || trimmed.length > TITLE_MAX) {
    throw new AppError(
      `title must be between ${TITLE_MIN} and ${TITLE_MAX} characters`,
      "validation_failed",
      422,
    );
  }
}

function coerceOccurredAt(value: Date | string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new AppError("occurredAt must be a valid date", "validation_failed", 422);
  }
  return d;
}

function isPgUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code: string }).code === "23505"
  );
}

/**
 * Pitfall 4 mitigation: verify gameId ownership BEFORE INSERT/UPDATE.
 * Throws NotFoundError on miss / cross-tenant — the HTTP boundary translates
 * to 404 (NOT 500 from a bare PG FK error). Soft-deleted games count as
 * missing.
 */
async function assertGameOwnedByUser(userId: string, gameId: string): Promise<void> {
  const [row] = await db
    .select({ id: games.id })
    .from(games)
    .where(
      and(eq(games.userId, userId), eq(games.id, gameId), isNull(games.deletedAt)),
    )
    .limit(1);
  if (!row) throw new NotFoundError();
}

/**
 * INGEST-03 author_is_me inheritance: match oEmbed.author_url against the
 * caller's registered data_sources by handleUrl exact match. Case-sensitive
 * in 2.1; future Phase 6 polish lowercases on insert+match.
 *
 * Inlined here (rather than importing from data-sources service) so events.ts
 * compiles independently of Plan 02.1-04's parallel data-sources service
 * landing.
 */
async function findActiveSourceByHandleUrl(
  userId: string,
  handleUrl: string,
): Promise<DataSourceRow | null> {
  const [row] = await db
    .select()
    .from(dataSources)
    .where(
      and(
        eq(dataSources.userId, userId),
        eq(dataSources.handleUrl, handleUrl),
        isNull(dataSources.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Create an event scoped to userId. Validates kind / title / occurredAt
 * BEFORE any INSERT — never produces an orphan row on validation fail
 * (D-19 / AGENTS.md "validate-first INGEST" anti-pattern).
 *
 * gameId is OPTIONAL (nullable) per Phase 2.1: events with game_id=NULL are
 * the inbox. When provided, the row is verified to belong to userId BEFORE
 * the INSERT (Pitfall 4).
 *
 * Audit: writes `event.created` with metadata
 *   { kind, event_id, game_id, occurred_at }
 *
 * Throws AppError 'duplicate_event' (409) on the partial-unique-index
 * violation `(user_id, kind, source_id, external_id)` — only fires when both
 * sourceId and externalId are present (auto-import dedup); manual paste
 * (sourceId NULL) never collides.
 */
export async function createEvent(
  userId: string,
  input: CreateEventInput,
  ipAddress: string,
  userAgent?: string,
): Promise<EventRow> {
  assertValidKind(input.kind);
  validateTitle(input.title);
  const occurredAt = coerceOccurredAt(input.occurredAt);
  if (input.gameId != null) {
    await assertGameOwnedByUser(userId, input.gameId);
  }

  let row: EventRow | undefined;
  try {
    [row] = await db
      .insert(events)
      .values({
        userId,
        gameId: input.gameId ?? null,
        sourceId: input.sourceId ?? null,
        kind: input.kind,
        authorIsMe: input.authorIsMe ?? false,
        occurredAt,
        title: input.title.trim(),
        url: input.url ?? null,
        notes: input.notes ?? null,
        metadata: input.metadata ?? {},
        externalId: input.externalId ?? null,
      })
      .returning();
  } catch (e: unknown) {
    if (isPgUniqueViolation(e)) {
      throw new AppError(
        "event already exists for this source",
        "duplicate_event",
        409,
        {
          kind: input.kind,
          source_id: input.sourceId ?? null,
          external_id: input.externalId ?? null,
        },
      );
    }
    throw e;
  }
  if (!row) throw new Error("createEvent: INSERT returned no row");

  await writeAudit({
    userId,
    action: "event.created",
    ipAddress,
    userAgent,
    metadata: {
      kind: row.kind,
      event_id: row.id,
      game_id: row.gameId,
      occurred_at: occurredAt.toISOString(),
    },
  });

  return row;
}

/**
 * createEventFromPaste — INGEST-02/03/04 unified path. Replaces the Phase 2
 * `items-youtube.createTrackedYoutubeVideo` flow. The YouTube paste path now
 * writes ONE events row (kind=youtube_video) carrying:
 *   - source_id   = matched data_sources row's id, or NULL on no match
 *   - author_is_me = matched source's is_owned_by_me, or false on no match
 *   - external_id = canonical YouTube videoId (auto-import dedup key)
 *
 * Validate-first invariant (D-19): URL parse + oEmbed validation runs BEFORE
 * any INSERT. On unsupported / private / unavailable / Reddit, the database
 * is provably untouched.
 *
 * Reddit URLs throw AppError 'reddit_pending_phase3' (422) — CONTEXT DV-7:
 * Reddit ingest stays Phase 3 alongside the poll.reddit adapter.
 */
export async function createEventFromPaste(
  userId: string,
  input: PasteInput,
  ipAddress: string,
  userAgent?: string,
): Promise<EventRow> {
  // Lazy-import the parser + oEmbed integration so this module compiles even
  // if the ingest layer is mid-transition (parallel-executor friendly).
  const { parseIngestUrl } = await import("./url-parser.js");
  const { fetchYoutubeOembed } = await import(
    "../integrations/youtube-oembed.js"
  );

  const parsed = parseIngestUrl(input.url);

  if (parsed.kind === "unsupported") {
    throw new AppError("URL not yet supported", "unsupported_url", 422, {
      url: input.url,
    });
  }
  if (parsed.kind === "reddit_deferred") {
    // CONTEXT DV-7: Reddit ingest lands in Phase 3 with poll.reddit. Surface a
    // typed error so the route layer (Plan 02.1-06) can map to the friendly
    // inline-info message.
    throw new AppError(
      "Reddit ingest arrives in Phase 3",
      "reddit_pending_phase3",
      422,
    );
  }
  if (parsed.kind === "twitter_post" || parsed.kind === "telegram_post") {
    // These flows are implemented by the higher-level orchestrator (ingest.ts)
    // because they want to call platform-specific oEmbed integrations.
    // createEventFromPaste is the YouTube-only convenience entry; the
    // orchestrator uses createEvent directly for Twitter / Telegram.
    throw new AppError(
      `paste flow does not yet handle kind '${parsed.kind}' via createEventFromPaste`,
      "kind_not_yet_functional",
      422,
      { kind: parsed.kind },
    );
  }
  if (parsed.kind !== "youtube_video") {
    // Unreachable — exhaustive over the ParsedUrl union — but the assertion
    // makes future kinds (D-09 /events/new free-form) easier to plug in.
    const _exhaustive: never = parsed;
    void _exhaustive;
    throw new AppError("unhandled paste kind", "unsupported_url", 422);
  }

  // YouTube oEmbed validation — Phase 2 precedent (discriminated-union catch
  // mapping). 5xx / network / abort throws; 401 → private; 404 → unavailable.
  let oembed;
  try {
    oembed = await fetchYoutubeOembed(parsed.canonicalUrl);
  } catch (err) {
    throw new AppError(
      "youtube oembed unreachable",
      "youtube_oembed_unreachable",
      502,
      { cause: String((err as Error)?.message ?? err) },
    );
  }
  if (oembed.kind === "private") {
    throw new AppError("video is private", "youtube_unavailable", 422, {
      reason: "private",
    });
  }
  if (oembed.kind === "unavailable") {
    throw new AppError("video unavailable", "youtube_unavailable", 422, {
      reason: "unavailable",
    });
  }

  // INGEST-03: author_url match against registered data_sources for
  // author_is_me inheritance. Case-sensitive exact match in 2.1.
  const matchedSource =
    oembed.data.authorUrl !== ""
      ? await findActiveSourceByHandleUrl(userId, oembed.data.authorUrl)
      : null;

  if (input.gameId != null) {
    await assertGameOwnedByUser(userId, input.gameId);
  }

  return createEvent(
    userId,
    {
      gameId: input.gameId ?? null,
      kind: "youtube_video",
      occurredAt: new Date(),
      title: oembed.data.title || `YouTube video ${parsed.videoId}`,
      url: parsed.canonicalUrl,
      externalId: parsed.videoId,
      sourceId: matchedSource?.id ?? null,
      authorIsMe: matchedSource?.isOwnedByMe ?? false,
      metadata: {
        author_name: oembed.data.authorName,
        author_url: oembed.data.authorUrl,
        thumbnail_url: oembed.data.thumbnailUrl,
      },
    },
    ipAddress,
    userAgent,
  );
}

/**
 * Per-game curated view (replaces Phase 2 listTimelineForGame's JS-merge of
 * events + tracked_youtube_videos — the unified events table makes the merge
 * unnecessary). Soft-deleted rows excluded. Cross-tenant gameId throws 404.
 */
export async function listEventsForGame(
  userId: string,
  gameId: string,
): Promise<EventRow[]> {
  await assertGameOwnedByUser(userId, gameId);
  return db
    .select()
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.gameId, gameId),
        isNull(events.deletedAt),
      ),
    )
    .orderBy(sql`${events.occurredAt} DESC, ${events.id} DESC`);
}

/**
 * Read one event scoped to userId. Soft-deleted rows count as missing.
 * Cross-tenant access throws NotFoundError (PRIV-01: 404, never 403).
 */
export async function getEventById(
  userId: string,
  eventId: string,
): Promise<EventRow> {
  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.id, eventId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.deletedAt !== null) throw new NotFoundError();
  return row;
}

/**
 * Update an event in-place. Validates kind / title / occurredAt only when
 * supplied. Bumps updatedAt. NotFoundError on miss / cross-tenant.
 *
 * Audit: writes `event.edited` with metadata { kind, event_id, fields }.
 */
export async function updateEvent(
  userId: string,
  eventId: string,
  input: UpdateEventInput,
  ipAddress: string,
  userAgent?: string,
): Promise<EventRow> {
  if (input.kind !== undefined) assertValidKind(input.kind);
  if (input.title !== undefined) validateTitle(input.title);

  const patch: Partial<typeof events.$inferInsert> = { updatedAt: new Date() };
  const fields: string[] = [];
  if (input.kind !== undefined) {
    patch.kind = input.kind;
    fields.push("kind");
  }
  if (input.occurredAt !== undefined) {
    patch.occurredAt = coerceOccurredAt(input.occurredAt);
    fields.push("occurredAt");
  }
  if (input.title !== undefined) {
    patch.title = input.title.trim();
    fields.push("title");
  }
  if (input.url !== undefined) {
    patch.url = input.url;
    fields.push("url");
  }
  if (input.notes !== undefined) {
    patch.notes = input.notes;
    fields.push("notes");
  }

  const [row] = await db
    .update(events)
    .set(patch)
    .where(
      and(
        eq(events.userId, userId),
        eq(events.id, eventId),
        isNull(events.deletedAt),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError();

  await writeAudit({
    userId,
    action: "event.edited",
    ipAddress,
    userAgent,
    metadata: { kind: row.kind, event_id: row.id, fields },
  });

  return row;
}

/**
 * Soft-delete an event. NotFoundError on miss / cross-tenant / already-deleted
 * (idempotent — second call surfaces 404, mirroring Phase 2 D-23 precedent).
 *
 * Audit: writes `event.deleted` with metadata { event_id, kind }.
 */
export async function softDeleteEvent(
  userId: string,
  eventId: string,
  ipAddress: string,
  userAgent?: string,
): Promise<void> {
  const result = await db
    .update(events)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(events.userId, userId),
        eq(events.id, eventId),
        isNull(events.deletedAt),
      ),
    )
    .returning({ id: events.id, kind: events.kind });
  const row = result[0];
  if (!row) throw new NotFoundError();

  await writeAudit({
    userId,
    action: "event.deleted",
    ipAddress,
    userAgent,
    metadata: { event_id: row.id, kind: row.kind },
  });
}

/**
 * listFeedPage — chronological pool with 7 filter axes + tuple cursor.
 * Returns up to FEED_PAGE_SIZE (50) rows ordered by (occurred_at desc, id desc)
 * plus a nextCursor when more rows exist.
 *
 * Filters (RESEARCH §3.3):
 *   source       → events.source_id = X
 *   kind         → events.kind = X
 *   game         → events.game_id = X
 *   attached     → true: game_id IS NOT NULL; false: game_id IS NULL AND
 *                  metadata.inbox.dismissed != true (RESEARCH §6.2 — inbox
 *                  view excludes dismissed events).
 *   authorIsMe   → events.author_is_me = X
 *   from / to    → events.occurred_at range
 *
 * Cursor format (D-31): base64url(JSON.stringify({at: ISO, id})). Reuses
 * encodeCursor / decodeCursor from audit-read.ts. Tuple comparison
 * `(occurred_at, id) < ($1, $2)` is stable under same-millisecond ties
 * because UUIDv7 ids are strictly monotonic.
 *
 * PITFALL P19 mitigation BY CONSTRUCTION: the userId WHERE clause is
 * INDEPENDENT of the cursor. A forged cross-tenant cursor returns zero of
 * the other tenant's rows because userId is filtered FIRST in the
 * `and(...)` clause and applied independently of any cursor coordinates.
 */
export async function listFeedPage(
  userId: string,
  filters: FeedFilters,
  cursor: string | null,
): Promise<FeedPage> {
  let parsedCursor: { at: Date; id: string } | null = null;
  if (cursor) parsedCursor = decodeCursor(cursor);

  const cursorClause = parsedCursor
    ? sql`(${events.occurredAt}, ${events.id}) < (${parsedCursor.at}, ${parsedCursor.id})`
    : sql`true`;

  // P1: userId filter is the FIRST clause and is literally present in the
  // .where(...) call so the structural ESLint rule recognizes it. Other
  // filter axes are accumulated into a separate array and combined via
  // `and()` — the userId clause stays load-bearing and visible.
  const filterParts = [isNull(events.deletedAt)];
  if (filters.source !== undefined) {
    filterParts.push(eq(events.sourceId, filters.source));
  }
  if (filters.kind !== undefined) {
    filterParts.push(eq(events.kind, filters.kind));
  }
  if (filters.game !== undefined) {
    filterParts.push(eq(events.gameId, filters.game));
  }
  if (filters.attached === true) {
    filterParts.push(isNotNull(events.gameId));
  }
  if (filters.attached === false) {
    filterParts.push(isNull(events.gameId));
    // RESEARCH §6.2: inbox view excludes events whose
    // metadata.inbox.dismissed === true.
    filterParts.push(
      sql`COALESCE(${events.metadata}->'inbox'->>'dismissed', 'false') = 'false'`,
    );
  }
  if (filters.authorIsMe !== undefined) {
    filterParts.push(eq(events.authorIsMe, filters.authorIsMe));
  }
  if (filters.from !== undefined) {
    filterParts.push(gte(events.occurredAt, filters.from));
  }
  if (filters.to !== undefined) {
    filterParts.push(lte(events.occurredAt, filters.to));
  }

  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), ...filterParts, cursorClause))
    .orderBy(sql`${events.occurredAt} DESC, ${events.id} DESC`)
    .limit(FEED_PAGE_SIZE + 1);

  const hasMore = rows.length > FEED_PAGE_SIZE;
  const page = rows.slice(0, FEED_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: hasMore && last ? encodeCursor(last.occurredAt, last.id) : null,
  };
}

/**
 * attachToGame — set or clear events.game_id. Pitfall 4 mitigation: when
 * gameId is non-null, validate it belongs to userId BEFORE the UPDATE so a
 * cross-tenant attach surfaces as 404 (NotFoundError), not 500 from the bare
 * PG FK rejection.
 *
 * gameId=null is the "move to inbox" affordance; the row's metadata is left
 * intact (a dismissed event that gets attached later would re-clear the
 * dismissed flag if the UI offered that flow — out of scope for 2.1).
 *
 * Audit: writes `event.attached_to_game` with metadata
 *   { event_id, kind, game_id }.
 */
export async function attachToGame(
  userId: string,
  eventId: string,
  gameId: string | null,
  ipAddress: string,
  userAgent?: string,
): Promise<EventRow> {
  if (gameId !== null) {
    await assertGameOwnedByUser(userId, gameId);
  }

  const [row] = await db
    .update(events)
    .set({ gameId, updatedAt: new Date() })
    .where(
      and(
        eq(events.userId, userId),
        eq(events.id, eventId),
        isNull(events.deletedAt),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError();

  await writeAudit({
    userId,
    action: "event.attached_to_game",
    ipAddress,
    userAgent,
    metadata: { event_id: row.id, kind: row.kind, game_id: gameId },
  });

  return row;
}

/**
 * dismissFromInbox — write metadata.inbox.dismissed=true via jsonb_set on an
 * inbox event (game_id IS NULL). Throws AppError 'not_in_inbox' (422) when
 * called on an attached event — only inbox events can be dismissed.
 *
 * Idempotency: a second dismiss on an already-dismissed event succeeds
 * silently (jsonb_set re-sets the same value); the audit row still fires.
 *
 * Audit: writes `event.dismissed_from_inbox` with metadata
 *   { event_id, kind }.
 */
export async function dismissFromInbox(
  userId: string,
  eventId: string,
  ipAddress: string,
  userAgent?: string,
): Promise<EventRow> {
  // getEventById throws NotFoundError on miss / cross-tenant — load-bearing
  // before we decide whether the event is in the inbox.
  const existing = await getEventById(userId, eventId);
  if (existing.gameId !== null) {
    throw new AppError(
      "event is attached to a game; only inbox events can be dismissed",
      "not_in_inbox",
      422,
      { event_id: existing.id, game_id: existing.gameId },
    );
  }

  // Two nested jsonb_set calls: the outer creates `inbox` if absent, the
  // inner creates `inbox.dismissed`. Postgres's `create_missing=true` only
  // creates the LAST key; intermediate parents must already exist (or be
  // created by an outer call). Tested PG 16 behavior — see
  // https://www.postgresql.org/docs/16/functions-json.html#FUNCTIONS-JSON-PROCESSING.
  const [row] = await db
    .update(events)
    .set({
      metadata: sql`jsonb_set(
        jsonb_set(
          COALESCE(${events.metadata}, '{}'::jsonb),
          '{inbox}',
          COALESCE(${events.metadata}->'inbox', '{}'::jsonb),
          true
        ),
        '{inbox,dismissed}',
        'true'::jsonb,
        true
      )`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(events.userId, userId),
        eq(events.id, eventId),
        isNull(events.deletedAt),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError();

  await writeAudit({
    userId,
    action: "event.dismissed_from_inbox",
    ipAddress,
    userAgent,
    metadata: { event_id: row.id, kind: row.kind },
  });

  return row;
}
