// events service — unified-table CRUD + feed + inbox + per-game view (Phase 2.1).
//
// REPLACES the Phase 2 `events` + `tracked_youtube_videos` split. One row per
// (user, occurrence) regardless of platform. `kind` discriminates platform;
// `author_is_me` discriminates own content from blogger / community coverage;
// nullable `source_id` distinguishes auto-imported from manually-pasted events.
//
// Plan 02.1-28 (UAT-NOTES.md §4.24.G — M:N migration application layer):
// events relate to ZERO-or-MORE games via the `event_games` junction table
// (Plan 02.1-27 schema). `events.game_id` is GONE. Inbox criterion is
// "no event_games rows for this event"; standalone criterion is the same
// junction-empty check PLUS metadata.triage.standalone === true.
//
// Pattern 1 (tenant scope): EVERY function takes `userId: string` first; EVERY
// Drizzle query .where()-clauses on `eq(events.userId, userId)` AND, when
// querying `eventGames`, also `eq(eventGames.userId, userId)`. The custom
// ESLint rule `tenant-scope/no-unfiltered-tenant-query` (Plan 02-02 / 02.1-01
// / 02.1-27) fires on any query that omits these filters — disable comments
// NOT allowed.
//
// VALID_EVENT_KINDS mirrors the schema enum (Pitfall 6 — defense-in-depth).
// A unit/integration test asserts list equality so a schema enum change forces
// a service-layer update.
//
// listFeedPage (RESEARCH §3.3 + Plan 02.1-28): chronological pool with 7
// filter axes + tuple cursor on (occurred_at desc, id desc). Show-axis
// branches (inbox / standalone / specific) use EXISTS / NOT EXISTS / IN
// subqueries against `event_games`. The outer userId clause stays FIRST
// (PITFALL P19 mitigation by construction); the EXISTS subqueries duplicate
// the userId clause INSIDE so the eventGames table is also tenant-scoped at
// every read site.
//
// attachEventToGames (Plan 02.1-28 — replaces Plan 02.1-05 attachToGame):
// SET semantics over the junction. Diffs the current attached set against
// the requested set; INSERTs added rows; DELETEs removed rows; writes one
// audit row per add (event.attached_to_game) and one per remove
// (event.detached_from_game). Cross-tenant gameIds throw NotFoundError →
// 404 by construction (assertGameOwnedByUser pre-check). Pitfall 4 holds.
//
// Plan 02.1-28 standalone↔game mutual exclusion (UAT-NOTES.md §4.24.C):
// markStandalone REJECTS when the event has ≥ 1 event_games rows;
// attachEventToGames REJECTS when the event is already metadata.triage.
// standalone === true AND non-empty gameIds are passed. AppError
// 'standalone_conflicts_with_game' (422). Defense-in-depth — the UI
// (Plan 02.1-32) hides the conflicting affordances.
//
// dismissFromInbox (RESEARCH §6.4 + Plan 02.1-28): writes
// metadata.inbox.dismissed=true via jsonb_set; only valid on inbox events
// (zero junction rows); otherwise throws AppError 'not_in_inbox' (422).
// Audit-logged `event.dismissed_from_inbox`.
//
// createEventFromPaste — INGEST-02/03/04 reframed under unified events. The
// YouTube paste flow no longer writes to a separate tracked_youtube_videos
// table; one events row carries everything. INGEST-03 author_is_me inheritance:
// match oEmbed.author_url against registered data_sources by handleUrl exact
// match (case-sensitive in 2.1; case-insensitive is a Phase 6 polish).
//
// Audit (D-32 + Phase 2.1 + Plan 02.1-28): event.created on INSERT, event.
// edited on UPDATE, event.deleted on softDelete, event.attached_to_game on
// each game added to the junction, event.detached_from_game on each game
// removed from the junction, event.dismissed_from_inbox on dismiss.

import { and, eq, gte, isNull, isNotNull, lte, sql, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "../db/client.js";
import { events } from "../db/schema/events.js";
import { eventGames } from "../db/schema/event-games.js";
import { games } from "../db/schema/games.js";
import { dataSources } from "../db/schema/data-sources.js";
import type { EventKind } from "../integrations/data-source-adapter.js";
import { writeAudit } from "../audit.js";
import { env } from "../config/env.js";
import { AppError, NotFoundError } from "./errors.js";
import { withQuotaGuard } from "./quota.js";
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
  // Plan 02.1-28: M:N migration. The legacy singular `gameId` is GONE —
  // events have ZERO-or-MORE attached games via the event_games junction.
  // Empty array (or omission) means "create in inbox" (no junction rows).
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
  // Plan 02.1-17 — author_is_me toggle restoration on the edit path so the
  // /events/[id]/edit form (Plan 02.1-18) can flip the discriminator without
  // re-creating the event.
  authorIsMe?: boolean;
  // Plan 02.1-28 — gameIds patch. When supplied, calls attachEventToGames
  // BEFORE the main UPDATE so the standalone-conflict guard fires first.
  // Omit to leave the junction unchanged.
  gameIds?: string[];
}

export interface PasteInput {
  url: string;
  // Plan 02.1-28: aligned with CreateEventInput.gameIds (M:N junction).
  // Empty array = inbox; non-empty = pre-attached.
  gameIds?: string[];
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
    typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "23505"
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
    .where(and(eq(games.userId, userId), eq(games.id, gameId), isNull(games.deletedAt)))
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
 * Plan 02.1-28 (M:N migration): events have ZERO-or-MORE attached games via
 * the event_games junction. `input.gameIds ?? []` controls the initial
 * attached set. Empty = inbox. Each gameId is verified to belong to userId
 * BEFORE the INSERT (Pitfall 4). The HTTP route schema accepts both
 * `gameId` (deprecated alias for one round of UAT) and `gameIds`; the
 * normalization happens in the route's superRefine, so by the time we get
 * here, `input.gameIds` is the only shape that matters.
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
 *   { kind, event_id, game_ids, occurred_at }
 * Plan 02.1-28: `game_ids` (plural array) replaces the v2.1-pre-28 singular
 * `game_id`. The audit consumers are forensics-only (no UI surface), so the
 * shape change is non-breaking at the user level.
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
  // PUTOFF Phase 3: auto-import path must catch quota_exceeded and defer the
  // polling job, not throw. For Phase 2.2 only the user-facing path exists
  // (manual paste + manual create); when the polling adapter lands in Phase 3,
  // hitting the events_per_day quota should THROTTLE (defer the job), NOT throw.
  //
  // Quota is checked INSIDE the withQuotaGuard tx below (Codex P2.1 race fix
  // + post-fix pool-deadlock fix). Pure validation stays here.
  assertValidKind(input.kind);
  validateTitle(input.title);
  const occurredAt = coerceOccurredAt(input.occurredAt);

  // Plan 02.1-28: validate every gameId belongs to userId BEFORE any INSERT
  // (validate-first; Pitfall 4). De-dup the input via Set so the same gameId
  // passed twice doesn't trigger duplicate junction INSERTs (composite PK
  // would catch it, but we'd surface 23505 as duplicate_event which is
  // misleading — the M:N relation is set-valued by definition).
  const targetGameIds = Array.from(new Set(input.gameIds ?? []));
  for (const gid of targetGameIds) {
    await assertGameOwnedByUser(userId, gid);
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

  // Plan 02.1-35 (UAT-NOTES.md §5.12 — P1): the events INSERT + junction
  // INSERT loop run in a single tx so a junction-INSERT failure rolls the
  // parent INSERT back. Validation + ownership pre-checks above are pure and
  // stay outside. withQuotaGuard wraps that tx with the per-user advisory
  // lock + quota check (Codex P2.1) and emits the quota.limit_hit audit
  // AFTER the tx releases its pool connection (Codex post-fix). The
  // event.created audit below also stays OUTSIDE the tx (AGENTS.md item 4 —
  // audit failure must not block the business path).
  let row: EventRow;
  try {
    row = await withQuotaGuard(userId, "events_per_day", ipAddress, async (tx) => {
      const [parent] = await tx
        .insert(events)
        .values({
          userId,
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
      if (!parent) throw new Error("createEvent: INSERT returned no row");

      // Plan 02.1-28: write event_games junction rows. Loop is fine for the
      // expected size (single-digit attached games per event in typical
      // usage); a future bulk-INSERT optimization is a one-line change if
      // profiling surfaces the need.
      for (const gid of targetGameIds) {
        await tx.insert(eventGames).values({
          userId,
          eventId: parent.id,
          gameId: gid,
        });
      }
      return parent;
    });
  } catch (e: unknown) {
    if (isPgUniqueViolation(e)) {
      throw new AppError("event already exists for this source", "duplicate_event", 409, {
        kind: input.kind,
        source_id: input.sourceId ?? null,
        external_id: derivedExternalId,
      });
    }
    throw e;
  }

  await writeAudit({
    userId,
    action: "event.created",
    ipAddress,
    userAgent,
    metadata: {
      kind: row.kind,
      event_id: row.id,
      game_ids: targetGameIds,
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
export async function enrichFromUrl(userId: string, url: string): Promise<EnrichmentResult> {
  const { parseIngestUrl } = await import("./url-parser.js");
  const { fetchYoutubeOembed } = await import("../integrations/youtube-oembed.js");

  const parsed = parseIngestUrl(url);

  if (parsed.kind === "unsupported") {
    throw new AppError("URL not yet supported", "unsupported_url", 422, { url });
  }
  if (parsed.kind === "reddit_deferred") {
    throw new AppError("Reddit ingest arrives in Phase 3", "reddit_pending_phase3", 422);
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
    throw new AppError("youtube oembed unreachable", "youtube_oembed_unreachable", 502, {
      cause: String((err as Error)?.message ?? err),
    });
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

  // Plan 02.1-28: validate every requested gameId belongs to userId before
  // calling through to createEvent (which also validates — this is a fast-fail
  // for the paste-flow's own UX). Set-dedup mirrors createEvent.
  const pasteGameIds = Array.from(new Set(input.gameIds ?? []));
  for (const gid of pasteGameIds) {
    await assertGameOwnedByUser(userId, gid);
  }

  return createEvent(
    userId,
    {
      gameIds: pasteGameIds,
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
 *
 * Plan 02.1-28 (M:N migration): the legacy `events.game_id` FK is GONE;
 * per-game lookups now INNER JOIN through `event_games`. The denormalized
 * `eventGames.userId` column lets the ESLint tenant-scope rule see a literal
 * userId WHERE clause on the junction (the rule cannot inspect FK-chained
 * values). Both `events.userId` AND `eventGames.userId` carry the same
 * caller id, so a forged cross-tenant gameId returns zero rows by
 * construction.
 */
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
 * Plan 02.1-28: when `input.gameIds` is supplied, calls attachEventToGames
 * BEFORE the main UPDATE so the standalone-conflict guard fires first
 * (a kind/title patch shouldn't be allowed to side-step the 422 the
 * junction-set update would otherwise raise). The two operations are
 * sequenced rather than transactional — attachEventToGames already audits
 * its own changes per add/remove; the events.edited audit row that follows
 * captures the patch fields independently.
 *
 * Audit: writes `event.edited` with metadata { kind, event_id, fields }.
 * `gameIds` is NOT listed in `fields` because the attachEventToGames call
 * already wrote attached_to_game / detached_from_game audit rows for each
 * delta. Listing it on event.edited would double-count.
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

  // Plan 02.1-37 / UAT-NOTES.md §5.11 — load the existing row up-front so the
  // merged-state validator below can compare input against the persisted state.
  // Tenant scope: userId is the FIRST .where() clause; cross-tenant / missing /
  // soft-deleted rows surface as NotFoundError → 404 at the HTTP boundary
  // (PRIV-01 / AGENTS.md item 2). The merged-state check runs AFTER this load,
  // so a cross-tenant PATCH never reaches the kind/url validator.
  const [existing] = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.id, eventId), isNull(events.deletedAt)));
  if (!existing) throw new NotFoundError();

  // Plan 02.1-37 / UAT-NOTES.md §5.11 — merged-state validator for the
  // kind=youtube_video → URL invariant. The route-layer schema (Plan 02.1-17
  // superRefine) validates the request body in isolation; it returns early when
  // the body lacks `kind`, so a PATCH like {url: null} with no kind on a row
  // whose existing kind is youtube_video used to slip past. This service-layer
  // check validates the MERGED state (input ∪ existing), mirroring the
  // assertGameOwnedByUser defense-in-depth pattern. createEventSchema STILL
  // carries its superRefine (create body IS the full state); only the update
  // path moved.
  //
  // `input.url` semantics: undefined = "don't change", null = "clear url",
  // string = "set url". The conditional treats null as a real intent to clear,
  // distinct from undefined.
  const mergedKind = input.kind ?? existing.kind;
  const mergedUrl = input.url !== undefined ? input.url : existing.url;
  if (mergedKind === "youtube_video") {
    if (!mergedUrl) {
      throw new AppError("url is required when kind=youtube_video", "kind_url_inconsistent", 422, {
        event_id: eventId,
        reason: "youtube_video_requires_url",
      });
    }
    const { parseIngestUrl } = await import("./url-parser.js");
    const parsed = parseIngestUrl(mergedUrl);
    if (parsed.kind !== "youtube_video") {
      throw new AppError("url is not a recognized YouTube URL", "kind_url_inconsistent", 422, {
        event_id: eventId,
        reason: "url_not_youtube",
      });
    }
  }

  // Plan 02.1-28: gameIds patch flows through attachEventToGames so the
  // standalone-conflict guard fires + the per-add/per-remove audit rows
  // are written. Order: gameIds FIRST so a 422 on conflict aborts before
  // we touch the patch fields (caller sees the 422 atomically — they
  // never see a half-applied edit where title changed but gameIds
  // refused). Plan 02.1-37 ordering: the merged-state validator above runs
  // BEFORE gameIds so a kind/url inconsistency aborts before any junction
  // mutation (preserves "validate first; mutate after pass").
  if (input.gameIds !== undefined) {
    await attachEventToGames(userId, eventId, input.gameIds, ipAddress, userAgent);
  }

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
    .where(and(eq(events.userId, userId), eq(events.id, eventId), isNull(events.deletedAt)))
    .returning();
  if (!row) throw new NotFoundError();

  // Plan 02.1-28: skip the event.edited audit when ONLY gameIds was supplied
  // (attachEventToGames already wrote per-add/per-remove audit rows; an empty
  // event.edited with fields=[] would be noise). When fields.length === 0
  // and input.gameIds was supplied, the only change was the junction set —
  // the attached_to_game/detached_from_game audit chain captures it.
  if (fields.length > 0) {
    await writeAudit({
      userId,
      action: "event.edited",
      ipAddress,
      userAgent,
      metadata: { kind: row.kind, event_id: row.id, fields },
    });
  }

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
    .where(and(eq(events.userId, userId), eq(events.id, eventId), isNull(events.deletedAt)))
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
      and(eq(events.userId, userId), isNotNull(events.deletedAt), gte(events.deletedAt, cutoff)),
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
  //
  // Plan 02.1-28 (M:N migration): every show.kind branch now JOINs against
  // the `event_games` junction. The old `events.gameId` column is GONE
  // (Plan 02.1-27 schema). The userId clause is duplicated INSIDE every
  // EXISTS / NOT EXISTS subquery so the eventGames table is also tenant-
  // scoped at the read site (the ESLint tenant-scope rule fires on the
  // outer-only filter; cross-tenant data isolation needs both layers).
  if (filters.show?.kind === "inbox") {
    // Inbox = event has ZERO event_games rows AND not dismissed AND not
    // standalone. The NOT EXISTS subquery is the M:N translation of the
    // legacy `game_id IS NULL` predicate.
    filterParts.push(
      sql`NOT EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId})` as SQL,
    );
    // RESEARCH §6.2 + Plan 02.1-15 attached=false precedent: inbox view
    // excludes events whose metadata.inbox.dismissed === 'true'. Without
    // this, dismissed events would resurface in the inbox.
    filterParts.push(sql`COALESCE(${events.metadata}->'inbox'->>'dismissed', 'false') = 'false'`);
    // Plan 02.1-24 (UAT-NOTES.md §6.1-redesign): inbox view ALSO excludes
    // standalone events. "Standalone" is a separate triage state — the
    // user has explicitly said the event is not related to any game, so
    // it does NOT belong in the inbox awaiting triage.
    filterParts.push(sql`COALESCE(${events.metadata}->'triage'->>'standalone', 'false') = 'false'`);
  } else if (filters.show?.kind === "standalone") {
    // Plan 02.1-24 + 02.1-28: standalone view = events the user explicitly
    // marked "not related to any game". The junction-empty constraint is
    // structural (markStandalone refuses if any junction rows exist — Plan
    // 02.1-28 mutual exclusion); the metadata.triage.standalone clause is
    // what distinguishes standalone from plain inbox.
    filterParts.push(
      sql`NOT EXISTS (SELECT 1 FROM ${eventGames} WHERE ${eventGames.eventId} = ${events.id} AND ${eventGames.userId} = ${userId})` as SQL,
    );
    filterParts.push(sql`COALESCE(${events.metadata}->'triage'->>'standalone', 'false') = 'true'`);
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
 * attachEventToGames — replace the event's attached-games set atomically.
 *
 * Plan 02.1-28 (UAT-NOTES.md §4.24.G — M:N migration): events have ZERO-or-
 * MORE attached games via the event_games junction. This function takes the
 * full target set (gameIds[]) and SETs it via a forward-only diff:
 *
 *   - INSERT junction rows for gameIds in the target set NOT in the current
 *     set (one event.attached_to_game audit row per addition).
 *   - DELETE junction rows in the current set NOT in the target set (one
 *     event.detached_from_game audit row per removal).
 *   - Update the event's updatedAt timestamp so consumers see the row as
 *     freshly modified.
 *
 * Empty target set === "move to inbox" (idempotent — calling with [] on an
 * already-empty junction is a no-op + no audit).
 *
 * Tenant scope (Pitfall 4 + CLAUDE.md invariant 1): every gameId is
 * validated against `assertGameOwnedByUser` BEFORE any junction write — a
 * cross-tenant gameId in the array surfaces as NotFoundError → 404, not
 * 500 from the bare PG FK rejection. The eventId itself is also validated
 * by the initial events SELECT (cross-tenant eventId returns zero rows →
 * NotFoundError 404 by construction).
 *
 * Plan 02.1-28 standalone↔game mutual exclusion (UAT-NOTES.md §4.24.C):
 * if `gameIds.length > 0` AND the event has metadata.triage.standalone ===
 * true, throws AppError(422, 'standalone_conflicts_with_game'). The user
 * must un-standalone first (or the UI hides the conflicting affordances —
 * Plan 02.1-32). Defense-in-depth at the service layer regardless of the
 * UI's enforcement.
 *
 * Set-input dedup: the input array is normalized via `Set` so the same
 * gameId passed twice doesn't trip the composite-PK 23505 (which would
 * surface as a misleading "duplicate_event" error code). M:N junctions are
 * set-valued by construction; idempotent input handling is the right shape.
 *
 * Audit shape: each write carries `{ event_id, kind, game_id }` (singular
 * game_id per row) so existing consumers (AuditRow + FilterChips +
 * FiltersSheet auditActionLabel switch) render unchanged. The new
 * detached_from_game verb mirrors the attached_to_game payload exactly.
 */
export async function attachEventToGames(
  userId: string,
  eventId: string,
  gameIds: string[],
  ipAddress: string,
  userAgent?: string,
): Promise<EventRow> {
  // 1. Load + validate the event ownership. Cross-tenant eventId surfaces
  //    as 404 here (zero rows → NotFoundError) BEFORE any junction read or
  //    write. The userId WHERE clause is the load-bearing privacy guard.
  const [event] = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.id, eventId), isNull(events.deletedAt)))
    .limit(1);
  if (!event) throw new NotFoundError();

  // 2. Plan 02.1-28 standalone↔game mutual exclusion guard. Fires BEFORE
  //    we touch the junction so the 422 surfaces atomically — a partial
  //    add/remove sequence followed by a 422 would be a confusing UX.
  if (gameIds.length > 0) {
    const md = event.metadata as { triage?: { standalone?: boolean } } | null;
    if (md?.triage?.standalone === true) {
      throw new AppError(
        "event marked standalone cannot be attached to a game",
        "standalone_conflicts_with_game",
        422,
        { event_id: eventId },
      );
    }
  }

  // 3. Validate every gameId in the target set belongs to userId.
  //    Cross-tenant gameId throws NotFoundError → 404 (Pitfall 4 explicit
  //    guard). De-dup via Set so duplicate input doesn't fire the same
  //    assertGameOwnedByUser twice (perf-only refinement).
  const uniqueGameIds = Array.from(new Set(gameIds));
  for (const gid of uniqueGameIds) {
    await assertGameOwnedByUser(userId, gid);
  }

  // 4. Read the current attached set (tenant-scoped — userId on the
  //    junction is the literal column name the ESLint rule walks for).
  const existing = await db
    .select({ gameId: eventGames.gameId })
    .from(eventGames)
    .where(and(eq(eventGames.userId, userId), eq(eventGames.eventId, eventId)));
  const existingSet = new Set(existing.map((r) => r.gameId));
  const targetSet = new Set(uniqueGameIds);

  // 5. Compute add / remove diffs.
  const toAdd = uniqueGameIds.filter((gid) => !existingSet.has(gid));
  const toRemove = [...existingSet].filter((gid) => !targetSet.has(gid));
  const diffNonEmpty = toAdd.length > 0 || toRemove.length > 0;

  // 6+7. Plan 02.1-35 (UAT-NOTES.md §5.12 — P1): wrap the junction DELETE/
  //      INSERT loops + the parent UPDATE in db.transaction so a partial
  //      failure rolls the diff back atomically. A FK violation on INSERT
  //      (race with another tab dropping the game between
  //      assertGameOwnedByUser and the INSERT) used to leave the junction
  //      half-deleted; now the rollback is automatic.
  //
  //      Plan 02.1-35 (UAT-NOTES.md §5.1 — P0): when the diff is non-empty
  //      (any attach OR detach), strip the `inbox` jsonb key from the
  //      parent's metadata so a previously-dismissed event re-engages with
  //      the inbox triage flow. The strip uses Postgres' jsonb `-` operator
  //      to remove the entire `inbox` key when present (cheaper + cleaner
  //      than jsonb_set with 'false' — keeps the metadata object minimal
  //      when dismissed was the only entry under inbox).
  //
  //      Audit writes (step 8 below) stay OUTSIDE the transaction
  //      (AGENTS.md item 4 — audit failure must not block business path).
  await db.transaction(async (tx) => {
    for (const gid of toRemove) {
      await tx
        .delete(eventGames)
        .where(
          and(
            eq(eventGames.userId, userId),
            eq(eventGames.eventId, eventId),
            eq(eventGames.gameId, gid),
          ),
        );
    }
    for (const gid of toAdd) {
      await tx.insert(eventGames).values({
        userId,
        eventId,
        gameId: gid,
      });
    }

    // Bump updatedAt on the parent event so list consumers see the change.
    // On any non-empty junction diff, additionally strip metadata.inbox
    // (UAT-NOTES.md §5.1) so the event re-enters the inbox triage flow if
    // the user later detaches all games.
    if (diffNonEmpty) {
      await tx
        .update(events)
        .set({
          updatedAt: new Date(),
          metadata: sql`COALESCE(${events.metadata}, '{}'::jsonb) - 'inbox'`,
        })
        .where(and(eq(events.userId, userId), eq(events.id, eventId)));
    } else {
      // No-op call — preserve metadata as-is (dismissed flag survives).
      await tx
        .update(events)
        .set({ updatedAt: new Date() })
        .where(and(eq(events.userId, userId), eq(events.id, eventId)));
    }
  });

  // 8. Audit — one row per add (event.attached_to_game) and one per remove
  //    (event.detached_from_game). The {event_id, kind, game_id} payload
  //    mirrors the legacy attachToGame shape so existing forensics
  //    consumers keep working.
  for (const gid of toAdd) {
    await writeAudit({
      userId,
      action: "event.attached_to_game",
      ipAddress,
      userAgent,
      metadata: { event_id: eventId, kind: event.kind, game_id: gid },
    });
  }
  for (const gid of toRemove) {
    await writeAudit({
      userId,
      action: "event.detached_from_game",
      ipAddress,
      userAgent,
      metadata: { event_id: eventId, kind: event.kind, game_id: gid },
    });
  }

  // Re-SELECT the parent row so the returned shape reflects the post-strip
  // metadata (the DTO projection downstream sees the cleared inbox key).
  // Falls back to the in-memory `event` row if the re-SELECT misses (should
  // never happen — the parent UPDATE above succeeded inside the transaction).
  const [refreshed] = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.id, eventId)))
    .limit(1);
  return refreshed ?? { ...event, updatedAt: new Date() };
}

/**
 * dismissFromInbox — write metadata.inbox.dismissed=true via jsonb_set on an
 * inbox event (no event_games rows). Throws AppError 'not_in_inbox' (422)
 * when called on an attached event — only inbox events can be dismissed.
 *
 * Plan 02.1-28: the inbox criterion is now "zero event_games rows" (M:N
 * junction); the legacy `events.gameId IS NULL` check is replaced with a
 * COUNT(*) lookup against the junction. Tenant-scoped on both events
 * (via getEventById) and eventGames (via the userId WHERE clause).
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

  // Plan 02.1-28: junction-count check replaces the legacy `gameId IS NULL`
  // predicate. Any event_games row attached to this event disqualifies it
  // from the inbox-dismiss flow.
  const attached = await db
    .select({ gameId: eventGames.gameId })
    .from(eventGames)
    .where(and(eq(eventGames.userId, userId), eq(eventGames.eventId, eventId)));
  if (attached.length > 0) {
    throw new AppError(
      "event is attached to a game; only inbox events can be dismissed",
      "not_in_inbox",
      422,
      {
        event_id: existing.id,
        // Plan 02.1-28: pass through the attached game_ids so the UI can
        // surface a "this is attached to {Game} — detach first" hint
        // without a second round-trip. Non-breaking — Phase 2 callers
        // didn't read this field.
        game_ids: attached.map((r) => r.gameId),
      },
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
    .where(and(eq(events.userId, userId), eq(events.id, eventId), isNull(events.deletedAt)))
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
 * markStandalone — set metadata.triage.standalone=true on an event with NO
 * attached games. Plan 02.1-24 (UAT-NOTES.md §6.1-redesign). The user has
 * explicitly said this event is not related to any game; the /feed view
 * dims standalone events (FeedCard opacity 0.55) so they don't distract
 * from game-tied events.
 *
 * Plan 02.1-28 (UAT-NOTES.md §4.24.C — standalone↔game mutual exclusion):
 * REJECTS when the event has ≥ 1 event_games rows. AppError 'standalone_
 * conflicts_with_game' (422). The legacy "detach gameId at the same time"
 * behavior is REMOVED — the column is gone, and silent detachment was
 * the wrong UX anyway (the user might not realize a game is attached).
 * The route layer surfaces the 422; the UI (Plan 02.1-32) hides the
 * conflicting affordance, so this code path is defense-in-depth.
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
  // Plan 02.1-28 conflict guard: if the event has any junction rows,
  // reject with a 422 rather than silently detaching. The user must
  // detach explicitly (via attachEventToGames(..., [])) before marking
  // standalone. We need to load the event ID first (cross-tenant 404)
  // before the junction lookup so a forged eventId from a different
  // tenant returns 404 not "standalone_conflicts_with_game".
  const [eventRow] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.id, eventId), isNull(events.deletedAt)))
    .limit(1);
  if (!eventRow) throw new NotFoundError();
  const attached = await db
    .select({ gameId: eventGames.gameId })
    .from(eventGames)
    .where(and(eq(eventGames.userId, userId), eq(eventGames.eventId, eventId)));
  if (attached.length > 0) {
    throw new AppError(
      "event has attached games; detach before marking standalone",
      "standalone_conflicts_with_game",
      422,
      {
        event_id: eventId,
        game_count: attached.length,
      },
    );
  }

  // Two nested jsonb_set calls: outer creates `triage` parent; inner sets
  // `triage.standalone=true`. Mirrors dismissFromInbox's nested-jsonb_set
  // pattern so a future metadata.triage.* sibling key (e.g., a flagged-as-
  // duplicate marker) won't collide.
  // Plan 02.1-28: the legacy `gameId: null` field is GONE (column dropped
  // by Plan 02.1-27); the conflict guard above ensures the junction is
  // already empty when we reach the UPDATE.
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
        'true'::jsonb,
        true
      )`,
      updatedAt: new Date(),
    })
    .where(and(eq(events.userId, userId), eq(events.id, eventId), isNull(events.deletedAt)))
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
    .where(and(eq(events.userId, userId), eq(events.id, eventId), isNull(events.deletedAt)))
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
