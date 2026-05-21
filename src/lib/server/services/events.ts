// events service — unified-table CRUD + feed + inbox + per-game view.
//
// One row per (user, occurrence) regardless of platform. `kind` discriminates
// platform; `author_is_me` discriminates own content from blogger / community
// coverage; nullable `source_id` distinguishes auto-imported from
// manually-pasted events.
//
// M:N: events relate to ZERO-or-MORE games via the `event_games` junction
// table. Inbox criterion is "no event_games rows for this event"; standalone
// criterion is the same junction-empty check PLUS
// metadata.triage.standalone === true.
//
// Tenant scope: EVERY function takes `userId: string` first; EVERY Drizzle
// query .where()-clauses on `eq(events.userId, userId)` AND, when querying
// `eventGames`, also `eq(eventGames.userId, userId)`. The custom ESLint rule
// `tenant-scope/no-unfiltered-tenant-query` fires on any query that omits
// these filters — disable comments NOT allowed.
//
// VALID_EVENT_KINDS mirrors the schema enum as defense-in-depth. A
// unit/integration test asserts list equality so a schema enum change forces
// a service-layer update.
//
// listFeedPage: chronological pool with filter axes + tuple cursor on
// (occurred_at desc, id desc). Show-axis branches (inbox / standalone /
// specific) use EXISTS / NOT EXISTS / IN subqueries against `event_games`.
// The outer userId clause stays FIRST (so a cursor can never observe
// another tenant's row IDs by construction); the EXISTS subqueries
// duplicate the userId clause INSIDE so the eventGames table is also
// tenant-scoped at every read site.
//
// attachEventToGames: SET semantics over the junction. Diffs the current
// attached set against the requested set; INSERTs added rows; DELETEs
// removed rows; writes one audit row per add (event.attached_to_game) and
// one per remove (event.detached_from_game). Cross-tenant gameIds throw
// NotFoundError → 404 by construction (assertGameOwnedByUser pre-check).
//
// Standalone↔game mutual exclusion: markStandalone REJECTS when the event
// has ≥ 1 event_games rows; attachEventToGames REJECTS when the event is
// already metadata.triage.standalone === true AND non-empty gameIds are
// passed. AppError 'standalone_conflicts_with_game' (422). Defense-in-depth
// — the UI hides the conflicting affordances.
//
// dismissFromInbox: writes metadata.inbox.dismissed=true via jsonb_set;
// only valid on inbox events (zero junction rows); otherwise throws
// AppError 'not_in_inbox' (422). Audit-logged `event.dismissed_from_inbox`.
//
// Audit: event.created on INSERT, event.edited on UPDATE, event.deleted on
// softDelete, event.attached_to_game on each game added to the junction,
// event.detached_from_game on each game removed from the junction,
// event.dismissed_from_inbox on dismiss.

import { and, eq, gte, isNull, isNotNull, lte, sql, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { db } from "../db/client.js";
import { events } from "../db/schema/events.js";
import { eventGames } from "../db/schema/event-games.js";
import { games } from "../db/schema/games.js";
import { dataSources } from "../db/schema/data-sources.js";
import type { EventKind } from "$lib/sources/adapter.js";
import { writeAudit } from "../audit.js";
import { env } from "../config/env.js";
import { AppError, NotFoundError } from "./errors.js";
import { withQuotaGuard, getUserQuotaUsedToday } from "./quota.js";
import { encodeCursor, decodeCursor } from "./audit-read.js";
import { eventKindToSourceKind } from "$lib/sources/event-to-source-kind.js";
import { getAdapter } from "$lib/sources/registry.js";
import { logger } from "../logger.js";
import { mapEventsToDtos, type EventDto } from "../dto.js";

export type EventRow = typeof events.$inferSelect;
export type DataSourceRow = typeof dataSources.$inferSelect;

/**
 * VALID_EVENT_KINDS — defense-in-depth mirror of the schema's eventKindEnum.
 * MUST stay in lock-step with src/lib/server/db/schema/events.ts; a unit test
 * asserts list equality against the pgEnum's `.enumValues`.
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
 * metadata.triage.standalone='true'. The Show
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
 * Extract the constraint name from a Postgres unique-violation. The shape
 * differs across pg drivers / versions: `node-pg` exposes `constraint`,
 * older drivers use `constraint_name`. Returns null when neither is set.
 */
function pgUniqueViolationConstraint(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const obj = e as { constraint?: unknown; constraint_name?: unknown };
  if (typeof obj.constraint === "string") return obj.constraint;
  if (typeof obj.constraint_name === "string") return obj.constraint_name;
  return null;
}

/**
 * Verify gameId ownership BEFORE INSERT/UPDATE so the boundary handles
 * cross-tenant cleanly. Throws NotFoundError on miss / cross-tenant — the
 * HTTP boundary translates to 404 (NOT 500 from a bare PG FK error).
 * Soft-deleted games count as
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
 * author_is_me inheritance: match oEmbed.author_url against the caller's
 * registered data_sources by handleUrl exact match. Case-sensitive;
 * lowercasing on insert+match is a possible future polish.
 *
 * Inlined here (rather than importing from data-sources service) so events.ts
 * compiles independently.
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
 * (AGENTS.md "validate-first INGEST" anti-pattern).
 *
 * M:N: events have ZERO-or-MORE attached games via the event_games
 * junction. `input.gameIds ?? []` controls the initial attached set.
 * Empty = inbox. Each gameId is verified to belong to userId BEFORE the
 * INSERT. The HTTP route schema accepts both `gameId` (deprecated alias)
 * and `gameIds`; the normalization happens in the route's superRefine, so
 * by the time we get here, `input.gameIds` is the only shape that matters.
 *
 * Kind-aware external_id enrichment for the manual-create path. When
 * `kind === "youtube_video"` AND `input.externalId` is null / undefined
 * AND `input.url` is set, parse the URL synchronously (no oEmbed
 * fetch) and set externalId from the canonical videoId so the FeedCard
 * thumbnail renders end-to-end. Idempotent — explicit `input.externalId`
 * always wins (caller-supplied value is never overwritten). Defense-in-depth
 * vs the route-layer superRefine: a malformed YouTube URL slipping past the
 * route silently leaves externalId null rather than throwing (the route is
 * the load-bearing validator; the service is opportunistic enrichment).
 *
 * Audit: writes `event.created` with metadata
 *   { kind, event_id, game_ids, occurred_at }
 * `game_ids` (plural array) replaced the legacy singular `game_id`. The
 * audit consumers are forensics-only (no UI surface), so the shape change
 * is non-breaking at the user level.
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
  // Auto-import path must catch quota_exceeded and defer the polling job,
  // not throw. Manual paste + manual create are user-facing today; when
  // auto-import wires through this same service, hitting the events_per_day
  // quota should THROTTLE (defer the job), NOT throw.
  //
  // Quota is checked INSIDE the withQuotaGuard tx below. Pure validation
  // stays here.
  assertValidKind(input.kind);
  validateTitle(input.title);
  const occurredAt = coerceOccurredAt(input.occurredAt);

  // Validate every gameId belongs to userId BEFORE any INSERT
  // (validate-first). De-dup the input via Set so the same gameId passed
  // twice doesn't trigger duplicate junction INSERTs (composite PK would
  // catch it, but we'd surface 23505 as duplicate_event which is
  // misleading — the M:N relation is set-valued by definition).
  const targetGameIds = Array.from(new Set(input.gameIds ?? []));
  for (const gid of targetGameIds) {
    await assertGameOwnedByUser(userId, gid);
  }

  // Opportunistic external_id derivation for any event kind whose adapter
  // knows how to parse the URL.
  //
  // Registry-driven match replaced the legacy kind === "youtube_video"
  // switch with a registry-driven match: `parseAnyUrl(input.url)` returns
  // `{kind, externalId, ...}` for whatever adapter recognized the host. If
  // the parsed kind matches the event's kind (caller's stated intent), use
  // its externalId; otherwise leave null. This generalizes to Reddit /
  // Twitter / future adapters without touching this code.
  //
  // Caller-supplied externalId always wins — this branch only runs when
  // input.externalId is null/undefined and a URL is present. Any URL shape
  // mismatch is silently left as null; the route-layer superRefine catches
  // malformed kind/URL pairs before the service is called.
  let derivedExternalId: string | null = input.externalId ?? null;
  if (derivedExternalId == null && input.url != null && input.url !== "") {
    // CYCLE-BREAKER: source URL parsing imports the adapter registry, and
    // the registry resolves adapter barrels that call back into event
    // services through syncStats/create flows.
    const { parseAnyUrl } = await import("$lib/sources/url.js");
    const parsed = parseAnyUrl(input.url);
    if (parsed !== null && parsed.kind === input.kind) {
      derivedExternalId = parsed.externalId;
    }
  }

  // The events INSERT + junction INSERT loop run in a single tx so a
  // junction-INSERT failure rolls the parent INSERT back. Validation +
  // ownership pre-checks above are pure and stay outside. withQuotaGuard
  // wraps that tx with the per-user advisory lock + quota check and emits
  // the quota.limit_hit audit AFTER the tx releases its pool connection.
  // The event.created audit below also stays OUTSIDE the tx (AGENTS.md
  // item 4 —
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

      // Write event_games junction rows. Loop is fine for the expected
      // size (single-digit attached games per event in typical usage);
      // a future bulk-INSERT optimization is a one-line change if
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
      const constraint = pgUniqueViolationConstraint(e);
      // The (user_id, kind, external_id) unique index was DROPPED in
      // migration 0013. The constraint had blocked the operator's actual
      // workflow ("one review video covers 5 games →
      // I want 5 events with different game attachments + different notes").
      // Duplicate-on-paste detection becomes a UI concern: the future "you
      // already have this video — add another note?" flow lives on the
      // /events/[id] detail view. This branch becomes dead code post-0013;
      // kept as a safety guard against accidental re-introduction of the
      // constraint and as a documented historical link.
      if (constraint === "events_user_kind_ext_active_unq") {
        throw new AppError(
          "event already exists for this URL (legacy constraint — should be impossible after migration 0013)",
          "duplicate_event",
          422,
          { kind: input.kind, external_id: derivedExternalId, url: input.url ?? null },
        );
      }
      // Pre-existing auto-import dedup constraint preserved at 409 — the
      // auto-import worker catches and silently skips, so the user-facing
      // surface never sees this code. Keeping 409 here avoids breaking any
      // back-compat caller that already discriminates by status.
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

  // Adapter-driven sync stats fetch. After ANY event create with
  // externalId, ask the adapter to pull view/like counts synchronously
  // (1 unit, user pool) so /feed shows
  // stats immediately. Errors swallowed — event row already exists;
  // stats will land via cron tick if this path failed.
  //
  // Cap check FIRST. syncStats.fetch writes an audit row with
  // flow=stats_refresh which counts toward the per-user requestsPerDay
  // cap. Without a pre-check, a user at 100/100 could push to 101 by
  // pasting a new event — letting them silently bypass the cap.
  // Pre-check: if used >= cap, skip stats fetch and let cron pick up
  // the polling later (no user-visible error — paste still succeeds).
  if (row.externalId) {
    const sourceKindForStats = eventKindToSourceKind(row.kind);
    if (sourceKindForStats !== null) {
      try {
        const statsAdapter = getAdapter(sourceKindForStats);
        if (statsAdapter.syncStats !== undefined) {
          let allow = true;
          const guard = await statsAdapter.syncStats.canRun?.({
            externalId: row.externalId,
            userId,
            eventKind: row.kind,
            now: new Date(),
          });
          if (guard?.action === "skip") {
            logger.info(
              {
                eventId: row.id,
                externalId: row.externalId,
                reason: guard.reason,
                retryAfterMs: guard.retryAfterMs,
              },
              "syncStats.fetch skipped by adapter guard",
            );
            allow = false;
          }

          const cap = statsAdapter.observability.userQuotaCap;
          if (allow && cap?.requestsPerDay !== undefined) {
            const used = await getUserQuotaUsedToday(userId, sourceKindForStats);
            if (used.requests >= cap.requestsPerDay) {
              logger.info(
                {
                  eventId: row.id,
                  externalId: row.externalId,
                  used: used.requests,
                  cap: cap.requestsPerDay,
                },
                "syncStats.fetch skipped — per-user requestsPerDay cap reached",
              );
              allow = false;
            }
          }
          if (allow) {
            const stats = await statsAdapter.syncStats.fetch(row.externalId, {
              userId,
              ipAddress,
            });
            if (stats !== null) {
              const now = new Date();
              // Two things to write: (1) last_user_refresh_at marker for
              // the RefreshNowButton cooldown gate; (2) author_is_me if
              // the adapter inherited it AND the caller didn't pass an
              // explicit value (input.authorIsMe). Adapter inheritance
              // wins over default-false but never overrides caller intent.
              const adapterAuthorIsMe = stats.authorIsMe;
              const shouldUpdateAuthor =
                adapterAuthorIsMe === true &&
                (input.authorIsMe === undefined || input.authorIsMe === false);
              await db
                .update(events)
                .set(
                  shouldUpdateAuthor
                    ? {
                        metadata: sql`jsonb_set(COALESCE(${events.metadata}, '{}'::jsonb), '{last_user_refresh_at}', to_jsonb(${now.toISOString()}::text), true)`,
                        authorIsMe: true,
                      }
                    : {
                        metadata: sql`jsonb_set(COALESCE(${events.metadata}, '{}'::jsonb), '{last_user_refresh_at}', to_jsonb(${now.toISOString()}::text), true)`,
                      },
                )
                .where(and(eq(events.userId, userId), eq(events.id, row.id)));
              if (shouldUpdateAuthor) row.authorIsMe = true;
            }
          }
        }
      } catch (err) {
        logger.warn(
          { eventId: row.id, externalId: row.externalId, err: String(err) },
          "syncStats.fetch failed on createEvent; UI will rely on cron polling",
        );
      }
    }
  }

  return row;
}

/**
 * EnrichmentResult is the shared shape returned by `enrichFromUrl` (used
 * by both the paste flow and the POST /api/events/preview-url endpoint).
 * Pure data — no side effects, no DB
 * write. The route handler decides whether to INSERT or just preview.
 *
 * `occurredAt` is `null` because YouTube oEmbed has no `published_at`
 * field; auto-fill of the date lands alongside the YouTube Data API key.
 * The /events/new client falls back to today's date.
 *
 * `sourceMatch` carries the matched data_sources row's id + isOwnedByMe
 * so callers can inherit `author_is_me` from a registered source without
 * re-querying.
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
 * enrichFromUrl is the URL → metadata bridge powering the
 * POST /api/events/preview-url endpoint. Adapter-driven: parses the URL,
 * dispatches to the matched adapter's fetchEventPreviewMetadata, and
 * shapes the result into the cross-source EnrichmentResult contract.
 *
 * Side effects vary per adapter. YouTube's preview is a keyless oEmbed
 * read — no DB write, no cap consumed. Reddit's preview is the same
 * /api/info.json call the paste flow uses (see fetchEventPreviewMetadata
 * in $lib/sources/reddit/server/index.ts) — it UPSERTs the reddit_posts /
 * reddit_users / reddit_subreddits caches, writes a snapshot row, AND
 * writes the user_post cap-counter row gated by enforceAdapterUserQuota.
 * `userId` + `ipAddress` are required for cap enforcement on Reddit;
 * YouTube ignores them.
 *
 * Error mapping (route layer preserves UX):
 *   - unsupported URL                → AppError 'unsupported_url' 422
 *   - reddit_post unreachable        → AppError 'reddit_unreachable' 502
 *   - reddit_post private/unavailable → AppError 'reddit_post_not_found' 404
 *   - twitter_post/telegram_post     → AppError 'kind_not_yet_functional' 422
 *   - oEmbed 5xx/network             → AppError 'youtube_oembed_unreachable' 502
 *   - oEmbed 401 (private)           → AppError 'youtube_unavailable' 422
 *   - oEmbed 404 (unavailable)       → AppError 'youtube_unavailable' 422
 */
export async function enrichFromUrl(
  userId: string,
  url: string,
  ipAddress: string,
): Promise<EnrichmentResult> {
  // CYCLE-BREAKER: URL parsing and adapter lookup load the adapter
  // registry; adapter barrels call this service from create/preview flows.
  const { parseIngestUrl } = await import("./url-parser.js");
  const { eventKindToSourceKind } = await import("$lib/sources/event-to-source-kind.js");
  const { getAdapter } = await import("$lib/sources/registry.js");

  const parsed = parseIngestUrl(url);

  if (parsed.kind === "unsupported") {
    throw new AppError("URL not yet supported", "unsupported_url", 422, { url });
  }

  // Reddit branch — adapter-driven preview through
  // redditAdapter.fetchEventPreviewMetadata. /api/events/preview-url
  // (this endpoint) and /api/reddit/fetch-metadata both go through the
  // same hook; the EnrichmentResult shape adapts Reddit's response so
  // POST /api/events/preview-url returns a uniform contract across
  // adapters.
  if (parsed.kind === "reddit_post") {
    const adapter = getAdapter("reddit_account");
    if (adapter.fetchEventPreviewMetadata === undefined) {
      throw new AppError(
        "reddit adapter does not support event preview",
        "kind_not_yet_functional",
        422,
        { kind: parsed.kind },
      );
    }
    const preview = await adapter.fetchEventPreviewMetadata(parsed.canonicalUrl, {
      userId,
      ipAddress,
    });
    if (preview.kind === "unreachable") {
      // Map operator-issue (unconfigured) vs network error vs rate-limit
      // to a useful response code. `cause` from the adapter carries the
      // discriminator.
      if (preview.cause === "reddit_not_configured") {
        throw new AppError("Reddit ingest is not available", "reddit_not_configured", 503, {
          cause: preview.cause,
        });
      }
      if (preview.cause === "rate_limited") {
        throw new AppError("Reddit rate-limited; try again shortly", "reddit_rate_limited", 429, {
          cause: preview.cause,
        });
      }
      throw new AppError("Reddit endpoint unreachable", "reddit_unreachable", 502, {
        cause: preview.cause,
      });
    }
    if (preview.kind === "private" || preview.kind === "unavailable") {
      throw new AppError("Reddit post unavailable", "reddit_post_not_found", 404, {
        reason: preview.kind,
      });
    }
    return {
      kind: "reddit_post",
      externalId: parsed.externalId,
      title: preview.title,
      occurredAt: preview.occurredAt ?? null,
      thumbnailUrl: preview.thumbnailUrl ?? null,
      authorName: preview.authorName || null,
      authorUrl: preview.authorUrl || null,
      canonicalUrl: parsed.canonicalUrl,
      // author_is_me inheritance for Reddit lives in syncStats.fetch
      // (matches t3.author against owned reddit_account.metadata.username).
      // enrichFromUrl is the PREVIEW path — no DB write happens here, so
      // we don't pre-compute sourceMatch.
      sourceMatch: null,
    };
  }

  if (parsed.kind === "twitter_post" || parsed.kind === "telegram_post") {
    throw new AppError(
      `paste flow does not yet handle kind '${parsed.kind}' through enrichFromUrl`,
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

  // Adapter-driven preview metadata. Cross-source code never calls
  // `fetchYoutubeOembed` directly; the adapter wraps oEmbed (or whatever
  // per-source preview API exists) into a uniform EventPreviewMetadata
  // shape. A future Reddit adapter implements fetchEventPreviewMetadata
  // with Reddit's oEmbed-equivalent; this code stays unchanged.
  //
  // Error vocab is preserved per parsed.kind to keep the UX contract stable
  // (`youtube_oembed_unreachable` / `youtube_unavailable` codes are pinned
  // by Paraglide messages + integration tests). A future generic vocab
  // would mean a coordinated UI + Paraglide migration; out of scope here.
  const sourceKind = eventKindToSourceKind(parsed.kind);
  if (sourceKind === null) {
    throw new AppError(
      `event kind '${parsed.kind}' has no source-kind mapping`,
      "kind_not_yet_functional",
      422,
      { kind: parsed.kind },
    );
  }
  const adapter = getAdapter(sourceKind);
  if (adapter.fetchEventPreviewMetadata === undefined) {
    throw new AppError(
      `adapter for ${sourceKind} does not support event preview`,
      "kind_not_yet_functional",
      422,
      { kind: parsed.kind },
    );
  }
  const preview = await adapter.fetchEventPreviewMetadata(parsed.canonicalUrl, {
    userId,
    ipAddress,
  });
  if (preview.kind === "unreachable") {
    throw new AppError("youtube oembed unreachable", "youtube_oembed_unreachable", 502, {
      cause: preview.cause,
    });
  }
  if (preview.kind === "private") {
    throw new AppError("video is private", "youtube_unavailable", 422, {
      reason: "private",
    });
  }
  if (preview.kind === "unavailable") {
    throw new AppError("video unavailable", "youtube_unavailable", 422, {
      reason: "unavailable",
    });
  }

  // author_url match against registered data_sources for
  // author_is_me inheritance. Case-sensitive exact match in 2.1.
  const matchedSource =
    preview.authorUrl !== "" ? await findActiveSourceByHandleUrl(userId, preview.authorUrl) : null;

  return {
    kind: "youtube_video",
    externalId: parsed.videoId,
    title: preview.title || `YouTube video ${parsed.videoId}`,
    // YouTube oEmbed has no published_at; the polling worker fills this
    // via the YouTube Data API key.
    occurredAt: null,
    // Deterministic public-CDN thumbnail; oEmbed's `thumbnail_url` is HQ but
    // platform-versioned. mqdefault.jpg matches FeedCard.
    thumbnailUrl: `https://img.youtube.com/vi/${parsed.videoId}/mqdefault.jpg`,
    authorName: preview.authorName || null,
    authorUrl: preview.authorUrl || null,
    canonicalUrl: parsed.canonicalUrl,
    sourceMatch: matchedSource
      ? { id: matchedSource.id, isOwnedByMe: matchedSource.isOwnedByMe }
      : null,
  };
}

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
 * Update an event in-place. Validates kind / title / occurredAt only when
 * supplied. Bumps updatedAt. NotFoundError on miss / cross-tenant.
 *
 * When `input.gameIds` is supplied, calls attachEventToGames
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

  // Load the existing row up-front so the merged-state validator below
  // can compare input against the persisted state. Tenant scope: userId
  // is the FIRST .where() clause; cross-tenant / missing / soft-deleted
  // rows surface as NotFoundError → 404 at the HTTP boundary. The
  // merged-state check runs AFTER this load, so a cross-tenant PATCH
  // never reaches the kind/url validator.
  const [existing] = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.id, eventId), isNull(events.deletedAt)));
  if (!existing) throw new NotFoundError();

  // Merged-state validator for the kind=youtube_video → URL invariant.
  // The route-layer schema validates the request body in isolation; it
  // returns early when the body lacks `kind`, so a PATCH like {url: null}
  // with no kind on a row whose existing kind is youtube_video would slip
  // past. This service-layer check validates the MERGED state
  // (input ∪ existing). createEventSchema STILL carries its superRefine
  // (create body IS the full state); only the update path moved.
  //
  // `input.url` semantics: undefined = "don't change", null = "clear url",
  // string = "set url". The conditional treats null as a real intent to clear,
  // distinct from undefined.
  const mergedKind = input.kind ?? existing.kind;
  const mergedUrl = input.url !== undefined ? input.url : existing.url;

  // Adapter-driven event-input validation. Cross-source code never
  // switches on event.kind here; the adapter for the matching source kind
  // (via eventKindToSourceKind) owns its kind-specific input validation
  // (e.g. youtube_video requires a parseable YouTube URL). Adapters that
  // don't impose constraints simply omit validateEventInput.
  // CYCLE-BREAKER: registry imports adapter barrels, while adapters call
  // back into event services for sync stats and validation workflows.
  const { eventKindToSourceKind } = await import("$lib/sources/event-to-source-kind.js");
  const { getAdapter, hasAdapter } = await import("$lib/sources/registry.js");
  const sourceKindForValidation = eventKindToSourceKind(mergedKind);
  if (sourceKindForValidation !== null && hasAdapter(sourceKindForValidation)) {
    const adapter = getAdapter(sourceKindForValidation);
    if (adapter.validateEventInput !== undefined) {
      try {
        adapter.validateEventInput({ kind: mergedKind, url: mergedUrl });
      } catch (err) {
        // Re-throw with event_id metadata pinned (legacy contract: the route
        // surfaces event_id in the 422 response).
        if (err instanceof AppError && err.code === "kind_url_inconsistent") {
          throw new AppError(err.message, err.code, err.status, {
            event_id: eventId,
            ...err.metadata,
          });
        }
        throw err;
      }
    }
  }

  // gameIds patch flows through attachEventToGames so the standalone-
  // conflict guard fires + the per-add/per-remove audit rows are written.
  // Order: gameIds FIRST so a 422 on conflict aborts before we touch the
  // patch fields (caller sees the 422 atomically — they never see a
  // half-applied edit where title changed but gameIds refused). The
  // merged-state validator above runs BEFORE gameIds so a kind/url
  // inconsistency aborts before any junction mutation (preserves
  // "validate first; mutate after pass").
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
  // authorIsMe toggle round-trips through the same `events.author_is_me`
  // column the discriminator uses everywhere.
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

  // Skip the event.edited audit when ONLY gameIds was supplied
  // (attachEventToGames already wrote per-add/per-remove audit rows; an
  // empty event.edited with fields=[] would be noise). When
  // fields.length === 0 and input.gameIds was supplied, the only change
  // was the junction set — the attached_to_game/detached_from_game audit
  // chain captures it.
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
 * (idempotent — second call surfaces 404).
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
 * restoreEvent — clear deletedAt on a tenant-owned soft-deleted event.
 *
 * Tenant scope: userId-first; cross-tenant / not-yet-deleted /
 * past-retention-window all collapse to NotFoundError → 404 at the HTTP
 * boundary. The UPDATE's WHERE clause is the load-bearing barrier: the
 * row only matches when (userId, id, deleted_at IS NOT NULL, deleted_at >=
 * cutoff) all agree, so a forged event id from a different tenant returns
 * no rows and the post-UPDATE `if (!row)` throws.
 *
 * Audit: writes `event.restored` AFTER the UPDATE succeeds. NotFoundError
 * fires BEFORE writeAudit so a cross-tenant attempt does not generate a
 * misleading audit trail. (The forensics-order-BEFORE-the-UPDATE pattern
 * `removeSteamKey` uses applies to security-relevant destructive actions;
 * restore is non-destructive.)
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
  opts?: { scope?: "live" | "trash" },
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
    filterParts.push(sql`COALESCE(${events.metadata}->'triage'->>'standalone', 'false') = 'false'`);
  } else if (filters.show?.kind === "standalone") {
    // Standalone view = events the user explicitly marked "not related to
    // any game". The junction-empty constraint is structural (markStandalone
    // refuses if any junction rows exist); the metadata.triage.standalone
    // clause is what distinguishes standalone from plain inbox.
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
 * Events have ZERO-or-MORE attached games via the event_games junction.
 * This function takes the full target set (gameIds[]) and SETs it via a
 * forward-only diff:
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
 * Tenant scope: every gameId is validated against `assertGameOwnedByUser`
 * BEFORE any junction write — a cross-tenant gameId in the array surfaces
 * as NotFoundError → 404, not 500 from the bare PG FK rejection. The
 * eventId itself is also validated by the initial events SELECT
 * (cross-tenant eventId returns zero rows → NotFoundError 404 by
 * construction).
 *
 * Standalone↔game mutual exclusion: if `gameIds.length > 0` AND the event
 * has metadata.triage.standalone === true, throws
 * AppError(422, 'standalone_conflicts_with_game'). The user must
 * un-standalone first (or the UI hides the conflicting affordances).
 * Defense-in-depth at the service layer regardless of the UI's enforcement.
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

  // 2. Standalone↔game mutual exclusion guard. Fires BEFORE we touch the
  //    junction so the 422 surfaces atomically — a partial add/remove
  //    sequence followed by a 422 would be a confusing UX.
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
  //    Cross-tenant gameId throws NotFoundError → 404. De-dup via Set so
  //    duplicate input doesn't fire the same assertGameOwnedByUser twice
  //    (perf-only refinement).
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

  // 6+7. Wrap the junction DELETE/INSERT loops + the parent UPDATE in
  //      db.transaction so a partial failure rolls the diff back
  //      atomically. A FK violation on INSERT (race with another tab
  //      dropping the game between assertGameOwnedByUser and the INSERT)
  //      used to leave the junction half-deleted; now the rollback is
  //      automatic.
  //
  //      When the diff is non-empty (any attach OR detach), strip the
  //      `inbox` jsonb key from the parent's metadata so a previously-
  //      dismissed event re-engages with the inbox triage flow. The strip
  //      uses Postgres' jsonb `-` operator to remove the entire `inbox`
  //      key when present (cheaper + cleaner than jsonb_set with 'false'
  //      — keeps the metadata object minimal when dismissed was the only
  //      entry under inbox).
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
    // On any non-empty junction diff, additionally strip metadata.inbox so
    // the event re-enters the inbox triage flow if the user later detaches
    // all games.
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
 * Inbox criterion is "zero event_games rows" (M:N junction); the legacy
 * `events.gameId IS NULL` check is replaced with a COUNT(*) lookup against
 * the junction. Tenant-scoped on both events (via getEventById) and
 * eventGames (via the userId WHERE clause).
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

  // Junction-count check replaces the legacy `gameId IS NULL` predicate.
  // Any event_games row attached to this event disqualifies it from the
  // inbox-dismiss flow.
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
        // Pass through the attached game_ids so the UI can surface a
        // "this is attached to {Game} — detach first" hint without a
        // second round-trip. Non-breaking — legacy callers didn't read
        // this field.
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
 * attached games. The user has explicitly said this event is not related
 * to any game; the /feed view dims standalone events (FeedCard opacity
 * 0.55) so they don't distract from game-tied events.
 *
 * Standalone↔game mutual exclusion: REJECTS when the event has ≥ 1
 * event_games rows. AppError 'standalone_conflicts_with_game' (422). The
 * legacy "detach gameId at the same time" behavior is REMOVED — the
 * column is gone, and silent detachment was the wrong UX anyway (the user
 * might not realize a game is attached). The route layer surfaces the
 * 422; the UI hides the conflicting affordance, so this code path is
 * defense-in-depth.
 *
 * Tenant scope: userId-first; the UPDATE WHERE clause
 * `eq(events.userId, userId) AND eq(events.id, eventId)` ensures
 * cross-tenant attempts return zero rows and surface as NotFoundError →
 * 404 at the HTTP boundary (404, never 403).
 *
 * Idempotency: jsonb_set with create_missing=true is idempotent. Calling
 * markStandalone twice in a row is safe — both calls succeed; both write
 * fresh audit rows (mirroring the dismissFromInbox precedent).
 *
 * Audit: writes `event.marked_standalone` AFTER the UPDATE succeeds.
 * NotFoundError fires BEFORE writeAudit so a cross-tenant attempt does not
 * generate a misleading audit trail (mirrors restoreEvent for
 * non-destructive triage).
 */
export async function markStandalone(
  userId: string,
  eventId: string,
  ipAddress: string,
  userAgent?: string,
): Promise<EventRow> {
  // Conflict guard: if the event has any junction rows, reject with a 422
  // rather than silently detaching. The user must
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
  // The legacy `gameId: null` field is GONE (column dropped); the
  // conflict guard above ensures the junction is already empty when we
  // reach the UPDATE.
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

// ============================================================
// Phase 3.4 design-v2-ux — bulk operations (D-12..D-15, D-21).
// ============================================================
//
// PATCH /api/events/bulk + DELETE /api/events/bulk (route landed in Plan 06)
// reach into this file for tri-state edit + soft-delete + hard-delete-from-
// trash. The shapes here are the source of truth — the Hono handlers are
// mechanical adapters that destructure the validated request body and call
// these functions.
//
// Cross-tenant ids are silently filtered via the userId WHERE clause (D-13)
// rather than throwing NotFoundError — bulk endpoints take a list of ids
// from a multi-select; a single forged or stale id should not cancel the
// whole batch. That diverges from single-id endpoints (which DO throw
// NotFoundError on cross-tenant) but the bulk shape's invariant is
// "process every owned id; ignore every other id". Reconciles with
// AGENTS.md "404 not 403 for cross-tenant" — for bulk, the 404 surface is
// the per-id silent drop visible in affected_count vs requested_count.
//
// ONE audit row per bulk action (D-14, GDPR Art. 17 "one row per
// user-intent"). The audit row sits OUTSIDE the transaction so audit
// failure cannot deadlock the pool nor block the business path (AGENTS.md
// item 4 — same pattern as createEvent / attachEventToGames).

/**
 * checkGameOwnership — boolean variant of assertGameOwnedByUser.
 *
 * Returns true iff a live (not soft-deleted) game with that id exists AND
 * is owned by userId. Does NOT throw on miss / cross-tenant — bulkEdit
 * uses this to silently filter cross-tenant gameStates keys per D-13
 * instead of leaking 404s. Single-id paths continue to use the throwing
 * assertGameOwnedByUser.
 */
export async function checkGameOwnership(userId: string, gameId: string): Promise<boolean> {
  const rows = await db
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.userId, userId), eq(games.id, gameId), isNull(games.deletedAt)))
    .limit(1);
  return rows.length === 1;
}

/**
 * bulkEdit — PATCH /api/events/bulk handler tx body (D-12 + D-14).
 *
 * Tri-state semantics per game:
 *   on    → INSERT junction row if not present
 *   off   → DELETE junction row if present
 *   mixed → leave alone (no-op)
 *
 * offTopicState mirrors the same tri-state and writes
 * events.metadata.triage.offTopic via jsonb_set when not "mixed".
 *
 * Cross-tenant ids silently dropped via the WHERE clause (D-13). Cross-tenant
 * gameStates keys silently dropped via checkGameOwnership BEFORE the tx so
 * the per-event diff loop only sees owned game ids.
 *
 * ONE audit row per call (D-14) carrying { affected_ids, game_diffs,
 * off_topic_state, requested_count, affected_count }. Empty-diff calls
 * (all states "mixed" OR no owned ids matched OR every per-event diff was
 * a no-op) return [] AND write NO audit row — the operation is a true
 * no-op and shouldn't pollute the audit stream.
 *
 * Returns affected events projected through mapEventsToDtos so DTO
 * discipline holds (gameIds + videoData populated; ciphertext fields
 * stripped — none exist on events today but the projection is the runtime
 * barrier per AGENTS.md).
 */
export async function bulkEdit(
  userId: string,
  ids: string[],
  gameStates: Record<string, "on" | "off" | "mixed">,
  offTopicState: "on" | "off" | "mixed",
  ipAddress: string,
  userAgent?: string,
): Promise<EventDto[]> {
  // 1. Silently filter cross-tenant gameIds (D-13). checkGameOwnership
  //    returns false for missing / cross-tenant / soft-deleted games; the
  //    key is dropped rather than throwing NotFoundError.
  const validGameIds = new Set<string>();
  for (const gid of Object.keys(gameStates)) {
    if (await checkGameOwnership(userId, gid)) validGameIds.add(gid);
  }
  const filteredGameStates: Record<string, "on" | "off" | "mixed"> = {};
  for (const [k, v] of Object.entries(gameStates)) {
    if (validGameIds.has(k)) filteredGameStates[k] = v;
  }

  // 2. Load owned + live events from the id list. Cross-tenant + soft-deleted
  //    ids fall out of the rows array via the userId / deletedAt WHERE
  //    clauses (D-13 silent filter at the read site).
  const rows = await db
    .select()
    .from(events)
    .where(
      and(eq(events.userId, userId), isNull(events.deletedAt), inArray(events.id, ids)),
    );

  if (rows.length === 0) return [];

  const affectedIds: string[] = [];

  // 3. Single tx — per-event diff INSERT/DELETE on event_games + off-topic
  //    update. The per-event existing-set read happens INSIDE the tx so a
  //    concurrent attach/detach from another request rolls back cleanly.
  await db.transaction(async (tx) => {
    for (const event of rows) {
      const existing = await tx
        .select({ gameId: eventGames.gameId })
        .from(eventGames)
        .where(and(eq(eventGames.userId, userId), eq(eventGames.eventId, event.id)));
      const existingSet = new Set(existing.map((r) => r.gameId));

      const toAdd: string[] = [];
      const toRemove: string[] = [];
      for (const [gid, state] of Object.entries(filteredGameStates)) {
        if (state === "on" && !existingSet.has(gid)) toAdd.push(gid);
        if (state === "off" && existingSet.has(gid)) toRemove.push(gid);
      }

      for (const gid of toAdd) {
        await tx.insert(eventGames).values({ userId, eventId: event.id, gameId: gid });
      }
      for (const gid of toRemove) {
        await tx
          .delete(eventGames)
          .where(
            and(
              eq(eventGames.userId, userId),
              eq(eventGames.eventId, event.id),
              eq(eventGames.gameId, gid),
            ),
          );
      }

      if (offTopicState !== "mixed") {
        const next = offTopicState === "on";
        await tx
          .update(events)
          .set({
            metadata: sql`jsonb_set(COALESCE(${events.metadata}, '{}'::jsonb), '{triage,offTopic}', to_jsonb(${next}::boolean), true)`,
            updatedAt: new Date(),
          })
          .where(and(eq(events.userId, userId), eq(events.id, event.id)));
      }

      if (toAdd.length > 0 || toRemove.length > 0 || offTopicState !== "mixed") {
        affectedIds.push(event.id);
      }
    }
  });

  if (affectedIds.length === 0) return [];

  // 4. ONE audit row (D-14), OUTSIDE the tx (pool-deadlock-safe).
  await writeAudit({
    userId,
    action: "events.bulk_edit",
    ipAddress,
    userAgent,
    metadata: {
      affected_ids: affectedIds,
      game_diffs: filteredGameStates,
      off_topic_state: offTopicState,
      requested_count: ids.length,
      affected_count: affectedIds.length,
    },
  });

  // 5. Re-read affected rows so DTO projection sees jsonb_set result.
  const updated = await db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), inArray(events.id, affectedIds)));
  return mapEventsToDtos(userId, updated);
}

/**
 * bulkDelete — DELETE /api/events/bulk soft-delete path (D-13 + D-14).
 *
 * Soft-deletes only owned + live events from the id list. Cross-tenant ids
 * and already-soft-deleted ids silently filtered via the WHERE clause.
 * Returns affected_count only (no event bodies — the UI doesn't need to
 * re-render rows that just disappeared from the feed).
 *
 * Zero affected → returns {affected_count: 0} AND writes NO audit row
 * (empty bulk operation is a true no-op).
 */
export async function bulkDelete(
  userId: string,
  ids: string[],
  ipAddress: string,
  userAgent?: string,
): Promise<{ affected_count: number }> {
  const result = await db
    .update(events)
    .set({ deletedAt: new Date() })
    .where(
      and(eq(events.userId, userId), isNull(events.deletedAt), inArray(events.id, ids)),
    )
    .returning({ id: events.id });

  if (result.length === 0) return { affected_count: 0 };

  await writeAudit({
    userId,
    action: "events.bulk_delete",
    ipAddress,
    userAgent,
    metadata: {
      affected_ids: result.map((r) => r.id),
      requested_count: ids.length,
      affected_count: result.length,
    },
  });
  return { affected_count: result.length };
}

/**
 * bulkDeleteForever — DELETE /api/events/bulk?force=true (D-21).
 *
 * Hard-deletes ONLY already-soft-deleted owned events from the id list.
 * Live events and cross-tenant ids silently filtered via the WHERE clause
 * (isNotNull(deletedAt) requires the row to already be in the trash;
 * eq(userId, userId) enforces tenant scope). This is the "Delete forever"
 * action available only from the trash view.
 *
 * Zero affected → returns {affected_count: 0} AND writes NO audit row.
 */
export async function bulkDeleteForever(
  userId: string,
  ids: string[],
  ipAddress: string,
  userAgent?: string,
): Promise<{ affected_count: number }> {
  const result = await db
    .delete(events)
    .where(
      and(eq(events.userId, userId), isNotNull(events.deletedAt), inArray(events.id, ids)),
    )
    .returning({ id: events.id });

  if (result.length === 0) return { affected_count: 0 };

  await writeAudit({
    userId,
    action: "events.delete_forever",
    ipAddress,
    userAgent,
    metadata: {
      affected_ids: result.map((r) => r.id),
      requested_count: ids.length,
      affected_count: result.length,
    },
  });
  return { affected_count: result.length };
}
