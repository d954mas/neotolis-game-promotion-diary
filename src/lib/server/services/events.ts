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

import { and, eq, gte, isNull, isNotNull, lte, sql, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "../db/client.js";
import { events } from "../db/schema/events.js";
import { games } from "../db/schema/games.js";
import { dataSources } from "../db/schema/data-sources.js";
import type { EventKind } from "../integrations/data-source-adapter.js";
import { writeAudit } from "../audit.js";
import { env } from "../config/env.js";
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
  // Plan 02.1-17 — author_is_me toggle restoration on the edit path so the
  // /events/[id]/edit form (Plan 02.1-18) can flip the discriminator without
  // re-creating the event.
  authorIsMe?: boolean;
}

export interface PasteInput {
  url: string;
  gameId?: string | null;
}

/**
 * Plan 02.1-19: ShowFilter — discriminated union collapses Plan 02.1-15's
 * `attached?: boolean` + `game?: string | string[]` pair into one axis. The
 * UI cannot construct `attached=false AND game=X` simultaneously by
 * construction (FiltersSheet renders one 3-radio for "Show: Any/Inbox/
 * Specific games"); the backend mirrors that constraint by replacing two
 * orthogonal filters with one tagged shape.
 *
 * Plan 02.1-24 (UAT-NOTES.md §6.1-redesign): adds the `standalone` branch
 * for the new "not related to any game" triage state. Standalone events
 * have game_id IS NULL AND metadata.triage.standalone='true'. The Show
 * fieldset's 4-option radio (Any / Inbox / Standalone / Specific) cannot
 * represent invalid combinations by construction.
 */
export type ShowFilter =
  | { kind: "any" }
  | { kind: "inbox" }
  | { kind: "standalone" }
  | { kind: "specific"; gameIds: string[] };

export interface FeedFilters {
  source?: string | string[];
  kind?: EventKind | EventKind[];
  show?: ShowFilter;
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

/**
 * pushAxis (Plan 02.1-15) — array-aware helper for the multi-select feed
 * filter axes (source / kind / game). Treats:
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
 * Plan 02.1-17 — kind-aware external_id enrichment for the manual-create
 * path. When `kind === "youtube_video"` AND `input.externalId` is null /
 * undefined AND `input.url` is set, parse the URL synchronously (no oEmbed
 * fetch) and set externalId from the canonical videoId so the FeedCard
 * thumbnail renders end-to-end. Idempotent — explicit `input.externalId`
 * always wins (caller-supplied value is never overwritten). Defense-in-depth
 * vs the route-layer superRefine: a malformed YouTube URL slipping past the
 * route silently leaves externalId null rather than throwing (the route is
 * the load-bearing validator; the service is opportunistic enrichment).
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

  // Plan 02.1-17 — opportunistic external_id derivation for kind=youtube_video.
  // Synchronous URL parse only; oEmbed enrichment is a separate concern handled
  // by enrichFromUrl below (and POST /api/events/preview-url). Caller-supplied
  // externalId always wins — this branch only runs when input.externalId is
  // null/undefined and a YouTube URL is present.
  let derivedExternalId: string | null = input.externalId ?? null;
  if (
    input.kind === "youtube_video" &&
    derivedExternalId == null &&
    input.url != null &&
    input.url !== ""
  ) {
    const { parseIngestUrl } = await import("./url-parser.js");
    const parsed = parseIngestUrl(input.url);
    if (parsed.kind === "youtube_video") {
      derivedExternalId = parsed.videoId;
    }
    // Any other shape (unsupported / reddit_deferred / etc.) — leave null.
    // The route-layer superRefine catches malformed YouTube URLs before
    // service is called; this is defense-in-depth only.
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
        externalId: derivedExternalId,
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
          external_id: derivedExternalId,
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
 * Plan 02.1-17 — EnrichmentResult is the shared shape returned by
 * `enrichFromUrl` (used by both the paste flow and the new
 * POST /api/events/preview-url endpoint). Pure data — no side effects, no DB
 * write. The route handler decides whether to INSERT or just preview.
 *
 * `occurredAt` is `null` in 2.1 because YouTube oEmbed has no `published_at`
 * field; auto-fill of the date lands in Phase 3 alongside the YouTube Data API
 * key (KEYS-01). The /events/new client falls back to today's date.
 *
 * `sourceMatch` carries the matched data_sources row's id + isOwnedByMe so
 * createEventFromPaste can inherit `author_is_me` from a registered source
 * without re-querying.
 */
export interface EnrichmentResult {
  kind: EventKind;
  externalId: string | null;
  title: string;
  occurredAt: Date | null;
  thumbnailUrl: string | null;
  authorName: string | null;
  authorUrl: string | null;
  canonicalUrl: string;
  sourceMatch: { id: string; isOwnedByMe: boolean } | null;
}

/**
 * Plan 02.1-17 — enrichFromUrl is the URL → metadata bridge shared by the
 * paste flow (createEventFromPaste) and the new POST /api/events/preview-url
 * endpoint. Pure read: parses the URL, calls oEmbed, matches author_url
 * against registered data_sources, returns the enrichment payload. NO DB
 * write happens here — both callers consume the result and either INSERT
 * (paste) or render (preview).
 *
 * Error mapping mirrors createEventFromPaste exactly so the route layer
 * preserves UX:
 *   - unsupported URL          → AppError 'unsupported_url' 422
 *   - reddit_deferred          → AppError 'reddit_pending_phase3' 422
 *   - twitter_post/telegram_post → AppError 'kind_not_yet_functional' 422
 *   - oEmbed 5xx/network       → AppError 'youtube_oembed_unreachable' 502
 *   - oEmbed 401 (private)     → AppError 'youtube_unavailable' 422
 *   - oEmbed 404 (unavailable) → AppError 'youtube_unavailable' 422
 */
export async function enrichFromUrl(
  userId: string,
  url: string,
): Promise<EnrichmentResult> {
  const { parseIngestUrl } = await import("./url-parser.js");
  const { fetchYoutubeOembed } = await import(
    "../integrations/youtube-oembed.js"
  );

  const parsed = parseIngestUrl(url);

  if (parsed.kind === "unsupported") {
    throw new AppError("URL not yet supported", "unsupported_url", 422, { url });
  }
  if (parsed.kind === "reddit_deferred") {
    throw new AppError(
      "Reddit ingest arrives in Phase 3",
      "reddit_pending_phase3",
      422,
    );
  }
  if (parsed.kind === "twitter_post" || parsed.kind === "telegram_post") {
    throw new AppError(
      `paste flow does not yet handle kind '${parsed.kind}'`,
      "kind_not_yet_functional",
      422,
      { kind: parsed.kind },
    );
  }
  if (parsed.kind !== "youtube_video") {
    // Exhaustive guard — every ParsedUrl variant handled above.
    const _exhaustive: never = parsed;
    void _exhaustive;
    throw new AppError("unhandled paste kind", "unsupported_url", 422);
  }

  // YouTube oEmbed (5xx/network → 502; 401 → private; 404 → unavailable).
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

  return {
    kind: "youtube_video",
    externalId: parsed.videoId,
    title: oembed.data.title || `YouTube video ${parsed.videoId}`,
    // 2.1 SKIP — YouTube oEmbed has no published_at. Phase 3 fills via
    // YouTube Data API key (KEYS-01) alongside the polling worker.
    occurredAt: null,
    // Deterministic public-CDN thumbnail; oEmbed's `thumbnail_url` is HQ but
    // platform-versioned. mqdefault.jpg matches the Plan 02.1-16 FeedCard.
    thumbnailUrl: `https://img.youtube.com/vi/${parsed.videoId}/mqdefault.jpg`,
    authorName: oembed.data.authorName || null,
    authorUrl: oembed.data.authorUrl || null,
    canonicalUrl: parsed.canonicalUrl,
    sourceMatch: matchedSource
      ? { id: matchedSource.id, isOwnedByMe: matchedSource.isOwnedByMe }
      : null,
  };
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
 * Plan 02.1-17 refactor: the URL parse + oEmbed fetch + author-match logic
 * is extracted into the shared `enrichFromUrl` helper so the new
 * POST /api/events/preview-url endpoint can call it without duplicating the
 * fetch (DRY). The paste-specific logic that remains here is gameId
 * validation + the createEvent INSERT.
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
  const enriched = await enrichFromUrl(userId, input.url);

  if (input.gameId != null) {
    await assertGameOwnedByUser(userId, input.gameId);
  }

  return createEvent(
    userId,
    {
      gameId: input.gameId ?? null,
      kind: "youtube_video",
      // Paste flow defaults occurredAt to "now" (the moment the user pasted);
      // the unified shape preserves this — preview-url callers get null and
      // the client renders today's date instead.
      occurredAt: new Date(),
      title: enriched.title,
      url: enriched.canonicalUrl,
      externalId: enriched.externalId,
      sourceId: enriched.sourceMatch?.id ?? null,
      authorIsMe: enriched.sourceMatch?.isOwnedByMe ?? false,
      metadata: {
        author_name: enriched.authorName ?? "",
        author_url: enriched.authorUrl ?? "",
        thumbnail_url: enriched.thumbnailUrl ?? "",
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
 * Read one event scoped to userId. Soft-deleted rows count as missing by
 * default. Pass `{ includeSoftDeleted: true }` (Plan 02.1-18) to surface
 * soft-deleted rows for the Restore flow on /events/[id]?deleted=1 — the
 * userId WHERE clause is unaffected so cross-tenant access still throws
 * NotFoundError regardless of the opts flag (PRIV-01: 404, never 403).
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
  // Plan 02.1-17 — authorIsMe toggle on the edit path. Round-trips through
  // the same `events.author_is_me` column the discriminator uses everywhere.
  if (input.authorIsMe !== undefined) {
    patch.authorIsMe = input.authorIsMe;
    fields.push("authorIsMe");
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
 * listDeletedEvents — return rows the user can still restore (Plan 02.1-14
 * gap closure — VERIFICATION.md Gap 2).
 *
 * Tenant scope (CLAUDE.md invariant 1): userId-first; eq(events.userId, userId)
 * is the first AND clause. Retention window: deletedAt > now() - RETENTION_DAYS
 * days. Past-retention rows are NOT returned (they are pending Phase 6 purge);
 * the UI never surfaces them.
 *
 * Sorted by deletedAt DESC so the most-recently-deleted row rises to the top.
 */
export async function listDeletedEvents(userId: string): Promise<EventRow[]> {
  const cutoff = new Date(Date.now() - env.RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return db
    .select()
    .from(events)
    .where(
      and(
        eq(events.userId, userId),
        isNotNull(events.deletedAt),
        gte(events.deletedAt, cutoff),
      ),
    )
    .orderBy(sql`${events.deletedAt} DESC, ${events.id} DESC`);
}

/**
 * restoreEvent — clear deletedAt on a tenant-owned soft-deleted event (Plan
 * 02.1-14 gap closure — VERIFICATION.md Gap 2).
 *
 * Tenant scope (CLAUDE.md invariants 1, 2): userId-first; cross-tenant /
 * not-yet-deleted / past-retention-window all collapse to NotFoundError → 404
 * at the HTTP boundary. The UPDATE's WHERE clause is the load-bearing barrier:
 * the row only matches when (userId, id, deleted_at IS NOT NULL, deleted_at >=
 * cutoff) all agree, so a forged event id from a different tenant returns no
 * rows and the post-UPDATE `if (!row)` throws.
 *
 * Audit (CLAUDE.md invariant 4): writes `event.restored` AFTER the UPDATE
 * succeeds. Ordering rationale: NotFoundError fires BEFORE writeAudit so a
 * cross-tenant attempt does not generate a misleading audit trail. (The Phase 2
 * `removeSteamKey` precedent — D-32 forensics order writing BEFORE the UPDATE —
 * applies to security-relevant destructive actions; restore is non-destructive.)
 */
export async function restoreEvent(
  userId: string,
  eventId: string,
  ipAddress: string,
  userAgent?: string,
): Promise<EventRow> {
  const cutoff = new Date(Date.now() - env.RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const [row] = await db
    .update(events)
    .set({ deletedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(events.userId, userId),
        eq(events.id, eventId),
        isNotNull(events.deletedAt),
        gte(events.deletedAt, cutoff),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError();

  await writeAudit({
    userId,
    action: "event.restored",
    ipAddress,
    userAgent,
    metadata: { event_id: row.id, kind: row.kind },
  });

  return row;
}

/**
 * listFeedPage — chronological pool with 7 filter axes + tuple cursor.
 * Returns up to FEED_PAGE_SIZE (50) rows ordered by (occurred_at desc, id desc)
 * plus a nextCursor when more rows exist.
 *
 * Filters (RESEARCH §3.3 + Plan 02.1-19 reshape):
 *   source       → events.source_id IN (...) (multi-select)
 *   kind         → events.kind IN (...) (multi-select)
 *   show         → discriminated union (Plan 02.1-19):
 *                    { kind: 'any' }      → no clause (default)
 *                    { kind: 'inbox' }    → game_id IS NULL AND
 *                                           metadata.inbox.dismissed != true
 *                                           (RESEARCH §6.2)
 *                    { kind: 'specific', gameIds: [...] } → game_id IN (...)
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
  const filterParts: SQL[] = [isNull(events.deletedAt) as SQL];
  // Plan 02.1-15: source / kind are multi-valued. pushAxis turns each axis
  // into eq() or inArray() depending on shape.
  pushAxis(filterParts, events.sourceId, filters.source);
  pushAxis(filterParts, events.kind, filters.kind);
  // Plan 02.1-19: show axis (collapses Plan 02.1-15 attached + game into a
  // single discriminated union). The UI's 3-radio Show fieldset cannot emit
  // "Inbox AND specific games" simultaneously, so we encode that in the type.
  if (filters.show?.kind === "inbox") {
    filterParts.push(isNull(events.gameId) as SQL);
    // RESEARCH §6.2 + Plan 02.1-15 attached=false precedent: inbox view
    // excludes events whose metadata.inbox.dismissed === 'true'. Without
    // this, dismissed events would resurface in the inbox.
    filterParts.push(
      sql`COALESCE(${events.metadata}->'inbox'->>'dismissed', 'false') = 'false'`,
    );
    // Plan 02.1-24 (UAT-NOTES.md §6.1-redesign): inbox view ALSO excludes
    // standalone events. "Standalone" is a separate triage state — the
    // user has explicitly said the event is not related to any game, so
    // it does NOT belong in the inbox awaiting triage.
    filterParts.push(
      sql`COALESCE(${events.metadata}->'triage'->>'standalone', 'false') = 'false'`,
    );
  } else if (filters.show?.kind === "standalone") {
    // Plan 02.1-24: standalone view = events the user explicitly marked
    // "not related to any game". game_id IS NULL by construction (the
    // markStandalone service detaches the game at the same time it sets
    // the flag); the metadata.triage.standalone clause is what
    // distinguishes standalone from plain inbox.
    filterParts.push(isNull(events.gameId) as SQL);
    filterParts.push(
      sql`COALESCE(${events.metadata}->'triage'->>'standalone', 'false') = 'true'`,
    );
  } else if (filters.show?.kind === "specific") {
    if (filters.show.gameIds.length === 1) {
      filterParts.push(eq(events.gameId, filters.show.gameIds[0]!) as SQL);
    } else if (filters.show.gameIds.length > 1) {
      filterParts.push(inArray(events.gameId, filters.show.gameIds) as SQL);
    }
    // Empty gameIds = no clause appended — semantically equivalent to "any"
    // (the UI prevents this state but the service stays defensive).
  }
  // show.kind === "any" or undefined: no clause appended (default).
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

/**
 * markStandalone — set metadata.triage.standalone=true AND detach the event
 * from any game (game_id=null). Plan 02.1-24 (UAT-NOTES.md §6.1-redesign).
 * The user has explicitly said this event is not related to any game; the
 * /feed view dims standalone events (FeedCard opacity 0.55) so they don't
 * distract from game-tied events.
 *
 * Tenant scope (CLAUDE.md invariant 1): userId-first; the UPDATE WHERE
 * clause `eq(events.userId, userId) AND eq(events.id, eventId)` ensures
 * cross-tenant attempts return zero rows and surface as NotFoundError →
 * 404 at the HTTP boundary (CLAUDE.md invariant 2: 404, never 403).
 *
 * Idempotency: jsonb_set with create_missing=true is idempotent. Calling
 * markStandalone twice in a row is safe — both calls succeed; both write
 * fresh audit rows (mirroring the dismissFromInbox precedent — Plan 02.1-05).
 *
 * Audit (CLAUDE.md invariant 4): writes `event.marked_standalone` AFTER the
 * UPDATE succeeds. Ordering rationale: NotFoundError fires BEFORE writeAudit
 * so a cross-tenant attempt does not generate a misleading audit trail
 * (mirrors restoreEvent — Plan 02.1-14 — for non-destructive triage).
 */
export async function markStandalone(
  userId: string,
  eventId: string,
  ipAddress: string,
  userAgent?: string,
): Promise<EventRow> {
  // Two nested jsonb_set calls: outer creates `triage` parent; inner sets
  // `triage.standalone=true`. Mirrors dismissFromInbox's nested-jsonb_set
  // pattern so a future metadata.triage.* sibling key (e.g., a flagged-as-
  // duplicate marker) won't collide. Also detaches gameId=null in the same
  // UPDATE — standalone implies "not tied to any game" by definition.
  const [row] = await db
    .update(events)
    .set({
      gameId: null,
      metadata: sql`jsonb_set(
        jsonb_set(
          COALESCE(${events.metadata}, '{}'::jsonb),
          '{triage}',
          COALESCE(${events.metadata}->'triage', '{}'::jsonb),
          true
        ),
        '{triage,standalone}',
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
    action: "event.marked_standalone",
    ipAddress,
    userAgent,
    metadata: { event_id: row.id, kind: row.kind },
  });

  return row;
}

/**
 * unmarkStandalone — clear metadata.triage.standalone (set to false). Plan
 * 02.1-24. Restores the event to plain inbox state (game_id remains null;
 * the user can re-attach via /events/[id]/edit if they change their mind).
 *
 * Tenant scope + audit ordering match markStandalone exactly. Audit verb is
 * `event.unmarked_standalone`.
 */
export async function unmarkStandalone(
  userId: string,
  eventId: string,
  ipAddress: string,
  userAgent?: string,
): Promise<EventRow> {
  const [row] = await db
    .update(events)
    .set({
      metadata: sql`jsonb_set(
        jsonb_set(
          COALESCE(${events.metadata}, '{}'::jsonb),
          '{triage}',
          COALESCE(${events.metadata}->'triage', '{}'::jsonb),
          true
        ),
        '{triage,standalone}',
        'false'::jsonb,
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
    action: "event.unmarked_standalone",
    ipAddress,
    userAgent,
    metadata: { event_id: row.id, kind: row.kind },
  });

  return row;
}
