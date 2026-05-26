// Events HTTP routes.
//
// Routes:
//   POST   /api/events                         — createEvent
//   POST   /api/events/preview-url             — enrichFromUrl (no DB write)
//   GET    /api/events                         — listFeedPage (chronological pool)
//   GET    /api/events/deleted                 — listDeletedEvents
//   PATCH  /api/events/bulk                    — bulkEdit (tri-state, D-12)
//   DELETE /api/events/bulk                    — bulkDelete / bulkDeleteForever (?force=true, D-13/D-21)
//   GET    /api/events/:id                     — getEventById
//   PATCH  /api/events/:id                     — updateEvent
//   DELETE /api/events/:id                     — softDeleteEvent
//   PATCH  /api/events/:id/attach              — attachEventToGames (M:N)
//   PATCH  /api/events/:id/dismiss-inbox       — dismissFromInbox
//   PATCH  /api/events/:id/restore             — restoreEvent
//
// createEventSchema and attachSchema accept BOTH the canonical
// {gameIds: string[]} shape AND the deprecated singular
// {gameId: string | null} alias. The route's transform normalizes to
// gameIds before calling the service.
//
// Enrichment does NOT auto-fill `occurredAt`. YouTube oEmbed has no
// `published_at`; HTML scraping is fragile. Client shows occurredAt =
// today (existing default) and lets the user override.
//
// Hono path-precedence: GET /events/deleted is registered BEFORE
// GET /events/:id because Hono matches the first declaration at a given depth.
// Without this ordering, the parametric `:id` route would consume the literal
// `deleted` segment and the deleted-events list endpoint would never fire.
// The same precedence rule applies to PATCH/DELETE /events/bulk — both /bulk
// handlers MUST register BEFORE the parametric /:id PATCH/DELETE pair, or
// `:id` would match `"bulk"` as the id param and the bulk endpoints would
// never fire (D-12/D-21 Phase 3.4).
//
// `kind` mirrors the unified-events pgEnum (eventKindEnum from
// src/lib/server/db/schema/events.ts). Service-layer `assertValidKind` is
// the second layer (defense-in-depth).
//
// AppError code mapping is automatic via `mapErr`:
//   - createEvent / updateEvent kind mismatch → AppError 'validation_failed' 422
//   - createEvent gameId cross-tenant → NotFoundError 404
//   - dismissFromInbox on attached event → AppError 'not_in_inbox' 422
//   - attachToGame cross-tenant gameId → NotFoundError 404
//   - cross-tenant /:id access → NotFoundError 404
//
// GET /api/events query-string uses ?show=any|inbox|standalone|specific.
// The ?attached parameter is not recognized.

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  createEvent,
  enrichFromUrl,
  getEventById,
  updateEvent,
  softDeleteEvent,
  listFeedPage,
  attachEventToGames,
  dismissFromInbox,
  listDeletedEvents,
  restoreEvent,
  bulkEdit,
  bulkDelete,
  bulkDeleteForever,
  VALID_EVENT_KINDS,
  type ShowFilter,
} from "../../services/events.js";
import { requestRefreshPoll } from "../../services/refresh-poll.js";
import { AppError } from "../../services/errors.js";
import { parseIngestUrl } from "../../services/url-parser.js";
import type { EventKind } from "$lib/sources/adapter.js";
import { allAdapters } from "$lib/sources/registry.js";
import { toEventDto, loadGameIdsForEvent, mapEventsToDtos } from "../../dto.js";
import { getAuditContext } from "../middleware/audit-ip.js";
import { mapErr, type RouteVars } from "./_shared.js";

const eventKindEnum = z.enum([
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
]);

/**
 * URL-required validator for pollable event kinds. youtube_video AND
 * reddit_post both MUST carry a parseable URL of the matching shape;
 * the service-layer createEvent is the second layer of defense
 * (opportunistic external_id derivation + adapter.syncStats.fetch).
 *
 * Shared between createEventSchema and updateEventSchema so a kind-change
 * PATCH that drops the url tripwires here too. Free-form kinds (post,
 * conference, talk, press, other) accept null/undefined url.
 *
 * Adding a new pollable kind = extend the {kind→expected ParsedUrl.kind}
 * map below. Mirrors the FUNCTIONAL_KINDS expansion in /events/new UI.
 */
const URL_REQUIRED_KINDS: Readonly<Record<string, string>> = {
  youtube_video: "youtube_video",
  reddit_post: "reddit_post",
};

function urlRequiredForPollableKinds(
  obj: { kind?: string | undefined; url?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  const kind = obj.kind;
  if (kind === undefined) return;
  const expectedParsedKind = URL_REQUIRED_KINDS[kind];
  if (expectedParsedKind === undefined) return;
  if (!obj.url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: `url is required for kind=${kind}`,
    });
    return;
  }
  const parsed = parseIngestUrl(obj.url);
  if (parsed.kind !== expectedParsedKind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: `url must be a recognized ${kind} URL`,
    });
  }
}

const createEventSchema = z
  .object({
    // gameId is the DEPRECATED back-compat alias; gameIds is canonical.
    // The transform below normalizes singular → plural.
    gameId: z.string().min(1).nullable().optional(),
    gameIds: z.array(z.string().min(1)).max(500).optional(),
    kind: eventKindEnum,
    occurredAt: z.string().datetime(),
    title: z.string().min(1).max(500),
    url: z.string().url().nullable().optional(),
    notes: z.string().max(50_000).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    // authorIsMe round-trips through the schema so /events/new can flip
    // "Author: me / not me" at create time. Service defaults to false when
    // omitted (preserves existing semantics).
    authorIsMe: z.boolean().optional(),
  })
  .superRefine(urlRequiredForPollableKinds)
  .transform((obj) => {
    // Normalize back-compat alias. When gameIds is absent and gameId is
    // supplied, internalize gameId → gameIds (single-element array, or
    // empty array if gameId is null). gameIds wins when both are supplied
    // (UI consumers migrating to the new shape are expected to send only
    // gameIds; the alias path is for in-flight legacy callers).
    const out: typeof obj & { gameIds: string[] } = { ...obj, gameIds: [] };
    if (obj.gameIds !== undefined) {
      out.gameIds = obj.gameIds;
    } else if (obj.gameId != null) {
      out.gameIds = [obj.gameId];
    }
    delete (out as { gameId?: unknown }).gameId;
    return out;
  });

// updateEventSchema does NOT call .superRefine(urlRequiredForPollableKinds). The
// create-side superRefine validates the full body (which IS the full state
// on create), but on a PATCH the body is partial — a `{url: null}` body
// with no `kind` field would slip past the body-only check on a row whose
// existing kind is youtube_video. The merged-state validator lives in the
// service layer (updateEvent in src/lib/server/services/events.ts), which
// sees both the input AND the existing row, mirroring the existing
// assertGameOwnedByUser pattern.
const updateEventSchema = z
  .object({
    kind: eventKindEnum.optional(),
    occurredAt: z.string().datetime().optional(),
    title: z.string().min(1).max(500).optional(),
    url: z.string().url().nullable().optional(),
    notes: z.string().max(50_000).nullable().optional(),
    // authorIsMe is editable; the /events/[id]/edit form flips the
    // discriminator without re-creating the event.
    authorIsMe: z.boolean().optional(),
    // gameIds patch on the edit path. Optional — omitting leaves the
    // junction unchanged; supplying replaces (set semantics via
    // attachEventToGames).
    gameIds: z.array(z.string().min(1)).max(500).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "at least one field must be supplied",
  });
// NOTE: NO .superRefine(urlRequiredForPollableKinds) here — moved to service layer.

// Feed query schema. Multi-value axes (source / kind / game) are NOT
// validated here because Hono's `c.req.queries(name)` returns string[] for
// repeated params and the zod validator only sees the FIRST value of a
// repeated key. The multi-value axes are read separately via
// `c.req.queries(...)` below; the schema only enforces the single-value
// back-compat surface (one ?source=, one ?kind=, one ?game=).
// Defense-in-depth on the kind values lives in-handler against
// VALID_EVENT_KINDS.
//
// Booleans arrive as the strings "true"|"false" because URL query params are
// stringly-typed; we coerce to real booleans before calling listFeedPage.
const feedQuerySchema = z.object({
  cursor: z.string().optional(),
  show: z.enum(["any", "inbox", "standalone", "specific"]).optional(),
  authorIsMe: z.enum(["true", "false"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  all: z.enum(["1", "0"]).optional(),
  q: z.string().optional(),
  // Infinite-scroll continuation must carry the same scope + sort the SSR
  // loader used, otherwise subsequent pages silently default to live/desc.
  view: z.enum(["feed", "trash"]).optional(),
  sort: z.enum(["asc", "desc"]).optional(),
});

// PATCH /api/events/:id/attach accepts BOTH the canonical
// {gameIds: string[]} shape AND the deprecated {gameId: string | null}
// alias. The union + transform pattern below normalizes either shape into
// a `{gameIds: string[]}` payload before the handler reads it.
const attachSchema = z.union([
  z.object({ gameIds: z.array(z.string().min(1)).max(500) }),
  z
    .object({ gameId: z.string().min(1).nullable() })
    .transform((o) => ({ gameIds: o.gameId === null ? [] : [o.gameId] })),
]);

// Read-only enrichment endpoint. Pure URL parse + oEmbed fetch, no DB
// write. The /events/new client calls this before the user submits the
// form so they see auto-filled title + thumbnail + external_id without
// committing the row.
const previewUrlSchema = z.object({
  url: z.string().url(),
});

// PATCH /api/events/bulk schema (D-12). Tri-state semantics per game id
// ("on" = attach, "off" = detach, "mixed" = leave alone); offTopicState
// mirrors the same vocab and writes events.metadata.triage.offTopic. The
// ids cap (.max(500)) is the rate-limit-friendly upper bound — mass-select
// in the UI tops out at the feed-page size; 500 is comfortable headroom
// without becoming a quota laundering vector.
const bulkEditSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  gameStates: z.record(z.string(), z.enum(["on", "off", "mixed"])).default({}),
  offTopicState: z.enum(["on", "off", "mixed"]).default("mixed"),
});

// DELETE /api/events/bulk schema (D-13 / D-21). `?force=true` query param
// switches the handler from bulkDelete (soft-delete owned + live events)
// to bulkDeleteForever (hard-delete owned + already-soft-deleted events).
// Both paths reuse the same body shape; the query string is the disambiguator.
const bulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
});

export const eventsRoutes = new Hono<RouteVars>();

eventsRoutes.post(
  "/events",
  zValidator("json", createEventSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    try {
      const ev = await createEvent(
        ctx.userId,
        c.req.valid("json"),
        ctx.ipAddress,
        ctx.userAgent ?? undefined,
      );
      // Load the freshly-inserted junction rows for the response DTO. The
      // createEvent service already wrote them in the same call, so this
      // is a deterministic single-event lookup.
      const gameIds = await loadGameIdsForEvent(ctx.userId, ev.id);
      return c.json(toEventDto(ev, gameIds), 201);
    } catch (err) {
      return mapErr(c, err, "POST /api/events");
    }
  },
);

eventsRoutes.get(
  "/events",
  zValidator("query", feedQuerySchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const q = c.req.valid("query");
    // Multi-value axes via Hono's c.req.queries() — repeated
    // ?source=A&source=B query params produce string[]. Single-param /
    // back-compat callers receive a one-element array which the service-layer
    // pushAxis helper collapses to eq() (zero query-plan regression).
    const sourceList = c.req.queries("source") ?? undefined;
    const kindList = c.req.queries("kind") as EventKind[] | undefined;
    const gameList = c.req.queries("game") ?? [];
    // Defense-in-depth: validate each kind value against the closed enum
    // BEFORE the service. Service-level assertValidKind is the second
    // layer; the route-layer 422 here keeps the failure mode crisp for
    // malformed multi-value URLs.
    if (kindList) {
      for (const k of kindList) {
        if (!(VALID_EVENT_KINDS as readonly string[]).includes(k)) {
          return c.json(
            { error: "validation_failed", details: [{ field: "kind", value: k }] },
            422,
          );
        }
      }
    }
    // Discriminated show axis. Post-Plan-03.4-10 the /feed orchestrator
    // narrows ?show= to "any" | "inbox" and emits the new flat
    // ?game=g1,g2,off_topic multi-select for the GAME axis. Legacy
    // ?show=standalone / ?show=specific URLs from old bookmarks /
    // FeedQuickNav stay supported as a back-compat hook.
    const showParam = q.show ?? "any";
    const showFilter: ShowFilter =
      showParam === "inbox"
        ? { kind: "inbox" }
        : showParam === "standalone"
          ? { kind: "standalone" }
          : showParam === "specific"
            ? { kind: "specific", gameIds: gameList }
            : { kind: "any" };
    // GAME axis multi-select (Plan 03.4-10). When ?show is absent OR
    // explicitly "any" AND ?game= is present, the params encode the new
    // flat multi-select (game IDs + optional "off_topic" sentinel). The
    // legacy ?show=specific&game=... path keeps its own gameIds plumbing
    // (above); the new path routes through filters.gameTags. Comma-split
    // is honored so ?game=g1,off_topic and ?game=g1&game=off_topic both
    // parse the same way (mirrors parseGameTags in url-state.ts).
    const gameTagsFromUrl =
      showParam === "any" && gameList.length > 0
        ? Array.from(new Set(gameList.flatMap((v) => v.split(",")).filter((v) => v !== "")))
        : undefined;
    try {
      const scope: "live" | "trash" = q.view === "trash" ? "trash" : "live";
      const sortDir: "asc" | "desc" = q.sort === "asc" ? "asc" : "desc";
      const page = await listFeedPage(
        c.var.userId,
        {
          source: sourceList && sourceList.length > 0 ? sourceList : undefined,
          kind: kindList && kindList.length > 0 ? kindList : undefined,
          show: showFilter,
          gameTags: gameTagsFromUrl,
          authorIsMe: q.authorIsMe === "true" ? true : q.authorIsMe === "false" ? false : undefined,
          // Date-only (YYYY-MM-DD) is inclusive on both ends — see /feed/+page.server.ts.
          from: q.from ? new Date(`${q.from}T00:00:00.000Z`) : undefined,
          to: q.to ? new Date(`${q.to}T23:59:59.999Z`) : undefined,
          query: q.q ?? undefined,
        },
        q.cursor ?? null,
        { scope, sortDir },
      );
      // Batch-load junction rows for every event in the page so each
      // EventDto carries its gameIds[] without an N+1 lookup. Two queries
      // total: one for events (page.rows above), one for the junction
      // (mapEventsToDtos).
      const dtos = await mapEventsToDtos(c.var.userId, page.rows);
      // Adapter-driven feed enrichment. Same loop as the /feed SSR loader
      // so cursor-paginated batches carry stats + channelTitle.
      for (const adapter of allAdapters) {
        if (adapter.enrichFeedDtos) {
          await adapter.enrichFeedDtos(c.var.userId, dtos);
        }
      }
      return c.json({
        rows: dtos,
        nextCursor: page.nextCursor,
      });
    } catch (err) {
      return mapErr(c, err, "GET /api/events");
    }
  },
);

// POST /api/events/preview-url. Adapter-driven preview. Tenant-scoped
// (mounted under tenantScope) so anonymous → 401; the auth gate is also
// load-bearing because the Reddit adapter's preview writes cache rows
// + a cap-counter row keyed on userId. YouTube's preview is keyless +
// uncounted, so the auth gate there is purely for anti-abuse. HONO
// PATH-PRECEDENCE: register BEFORE any parametric POST `/events/:id/...`
// route — keep literals first as a discipline.
eventsRoutes.post(
  "/events/preview-url",
  zValidator("json", previewUrlSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    try {
      const ctx = getAuditContext(c);
      const enriched = await enrichFromUrl(ctx.userId, c.req.valid("json").url, ctx.ipAddress);
      return c.json({
        kind: enriched.kind,
        externalId: enriched.externalId,
        title: enriched.title,
        thumbnailUrl: enriched.thumbnailUrl,
        authorName: enriched.authorName,
        authorUrl: enriched.authorUrl,
        // ISO string when set; null when oEmbed has no published_at.
        occurredAt: enriched.occurredAt ? enriched.occurredAt.toISOString() : null,
      });
    } catch (err) {
      return mapErr(c, err, "POST /api/events/preview-url");
    }
  },
);

// Must register BEFORE GET /events/:id because Hono matches the first
// registration at a given depth. The literal "deleted" segment would
// otherwise be consumed by the parametric `:id`.
eventsRoutes.get("/events/deleted", async (c) => {
  try {
    const rows = await listDeletedEvents(c.var.userId);
    // Batch-load gameIds for the deleted-event list. Soft-deleted events
    // keep their junction rows (only the events.deletedAt column carries
    // the deletion marker; the junction has no deletedAt column by design),
    // so the DTO will surface the gameIds they were attached to at delete
    // time.
    const dtos = await mapEventsToDtos(c.var.userId, rows);
    // Deliberately NOT calling adapter.enrichFeedDtos here.
    // DeletedEventsPanel.svelte renders soft-deleted events with a compact
    // KindIcon + strikethrough-title view — no stats line, no channel chip.
    // Running the enrichment query would be wasted I/O. If a future redesign
    // of DeletedEventsPanel adds the stats/channel chips back, add the same
    // `for-of allAdapters` loop the GET /api/events handler uses (above).
    return c.json({ rows: dtos });
  } catch (err) {
    return mapErr(c, err, "GET /api/events/deleted");
  }
});

// Phase 3.4 design-v2-ux — bulk operations (D-12 + D-13 + D-14 + D-21).
//
// Hono path-precedence: /bulk MUST register BEFORE /:id, otherwise the
// parametric `:id` matches `"bulk"` as the id param and these handlers
// never fire. Mirrors the /events/deleted precedence pattern documented
// at the top of this file.
//
// Cross-tenant ids are silently filtered at the service layer (D-13) — the
// bulk endpoints NEVER return 404 for "id you don't own"; they return 200
// with affected_count reflecting the owned-subset that committed. That
// diverges from the per-id endpoints (which DO 404 cross-tenant) and is
// the documented bulk contract — see services/events.ts header for the
// rationale.
eventsRoutes.patch(
  "/events/bulk",
  zValidator("json", bulkEditSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    const body = c.req.valid("json");
    try {
      const dtos = await bulkEdit(
        ctx.userId,
        body.ids,
        body.gameStates,
        body.offTopicState,
        ctx.ipAddress,
        ctx.userAgent ?? undefined,
      );
      return c.json({ events: dtos, affected_count: dtos.length });
    } catch (err) {
      return mapErr(c, err, "PATCH /api/events/bulk");
    }
  },
);

// DELETE /api/events/bulk — soft-delete or hard-delete-from-trash depending
// on `?force=true`. The query string is the disambiguator; both paths share
// the same body schema (D-21 — "Delete forever" surfaces only in the trash
// view, but the same Hono route handles both via the force flag).
eventsRoutes.delete(
  "/events/bulk",
  zValidator("json", bulkDeleteSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    const body = c.req.valid("json");
    const force = c.req.query("force") === "true";
    try {
      const result = force
        ? await bulkDeleteForever(ctx.userId, body.ids, ctx.ipAddress, ctx.userAgent ?? undefined)
        : await bulkDelete(ctx.userId, body.ids, ctx.ipAddress, ctx.userAgent ?? undefined);
      return c.json(result);
    } catch (err) {
      return mapErr(c, err, "DELETE /api/events/bulk");
    }
  },
);

eventsRoutes.get("/events/:id", async (c) => {
  try {
    const ev = await getEventById(c.var.userId, c.req.param("id"));
    // Single-event detail loads its gameIds via the single-event helper.
    const gameIds = await loadGameIdsForEvent(c.var.userId, ev.id);
    return c.json(toEventDto(ev, gameIds));
  } catch (err) {
    return mapErr(c, err, "GET /api/events/:id");
  }
});

eventsRoutes.patch(
  "/events/:id",
  zValidator("json", updateEventSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    try {
      const ev = await updateEvent(
        ctx.userId,
        c.req.param("id"),
        c.req.valid("json"),
        ctx.ipAddress,
        ctx.userAgent ?? undefined,
      );
      // Load junction rows AFTER the patch. updateEvent may have called
      // attachEventToGames internally (when the body included gameIds),
      // so the post-patch junction state is the correct source of truth.
      const gameIds = await loadGameIdsForEvent(ctx.userId, ev.id);
      return c.json(toEventDto(ev, gameIds));
    } catch (err) {
      return mapErr(c, err, "PATCH /api/events/:id");
    }
  },
);

eventsRoutes.delete("/events/:id", async (c) => {
  const ctx = getAuditContext(c);
  try {
    await softDeleteEvent(ctx.userId, c.req.param("id"), ctx.ipAddress, ctx.userAgent ?? undefined);
    return c.body(null, 204);
  } catch (err) {
    return mapErr(c, err, "DELETE /api/events/:id");
  }
});

eventsRoutes.patch(
  "/events/:id/attach",
  zValidator("json", attachSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    // The schema's union+transform guarantees `body.gameIds` is a string[]
    // regardless of whether the caller sent {gameIds: [...]} or the
    // deprecated {gameId: X | null} alias.
    const body = c.req.valid("json");
    try {
      const ev = await attachEventToGames(
        ctx.userId,
        c.req.param("id"),
        body.gameIds,
        ctx.ipAddress,
        ctx.userAgent ?? undefined,
      );
      // Response carries the post-attach junction state.
      const gameIds = await loadGameIdsForEvent(ctx.userId, ev.id);
      return c.json(toEventDto(ev, gameIds));
    } catch (err) {
      return mapErr(c, err, "PATCH /api/events/:id/attach");
    }
  },
);

eventsRoutes.patch("/events/:id/dismiss-inbox", async (c) => {
  const ctx = getAuditContext(c);
  try {
    const ev = await dismissFromInbox(
      ctx.userId,
      c.req.param("id"),
      ctx.ipAddress,
      ctx.userAgent ?? undefined,
    );
    const gameIds = await loadGameIdsForEvent(ctx.userId, ev.id);
    return c.json(toEventDto(ev, gameIds));
  } catch (err) {
    return mapErr(c, err, "PATCH /api/events/:id/dismiss-inbox");
  }
});

// Restore a soft-deleted event. Cross-tenant / never-deleted /
// past-retention all return 404 by construction (the service throws
// NotFoundError for all three cases; mapErr translates to
// {error: "not_found"} status 404, never 403).
eventsRoutes.patch("/events/:id/restore", async (c) => {
  const ctx = getAuditContext(c);
  try {
    const ev = await restoreEvent(
      ctx.userId,
      c.req.param("id"),
      ctx.ipAddress,
      ctx.userAgent ?? undefined,
    );
    const gameIds = await loadGameIdsForEvent(ctx.userId, ev.id);
    return c.json(toEventDto(ev, gameIds));
  } catch (err) {
    return mapErr(c, err, "PATCH /api/events/:id/restore");
  }
});

// POST /api/events/:id/refresh-poll. User-side "refresh this event's
// stats right now". The service enforces a 5-minute cooldown via
// events.metadata.last_user_refresh_at, gates non-pollable kinds +
// missing external_id + per-user cap, then asks the adapter to enqueue
// (YouTube -> adapter_refresh_queue youtube_channel/user_video lane, Reddit ->
// adapter_refresh_queue reddit_account/user_post lane).
//
// Error mapping (via mapErr — service throws typed errors):
//   - NotFoundError                     → 404 {error: "not_found"}
//   - AppError "too_many_refreshes"     → 429 + Retry-After header from
//                                          err.metadata.retryAfterSeconds
//                                          (client reads Retry-After to drive
//                                          the cooldown countdown affordance)
//   - AppError "event_not_pollable"     → 422
//   - AppError "event_no_external_id"   → 422
//
// On 200 the body is `{enqueued: true, queue: <adapter-specific>, eventId,
// jobId?}`. RefreshNowButton consumes the success: it disables the button
// for 5 minutes; after a 429 it reads Retry-After to drive the same
// countdown without round-tripping the metadata payload. The `queue` /
// `jobId` fields are operator/diagnostic-facing (the UI ignores them).
eventsRoutes.post("/events/:id/refresh-poll", async (c) => {
  const ctx = getAuditContext(c);
  try {
    const result = await requestRefreshPoll(
      ctx.userId,
      c.req.param("id"),
      ctx.ipAddress,
      ctx.userAgent ?? undefined,
    );
    return c.json(result);
  } catch (err) {
    // Set Retry-After header for 429 from metadata.retryAfterSeconds before
    // deferring to the shared error mapper. mapErr's metadata-forwarding path
    // covers the JSON body shape; the header is a separate UI contract.
    if (err instanceof AppError && err.code === "too_many_refreshes") {
      const retryAfterSeconds = err.metadata.retryAfterSeconds;
      if (typeof retryAfterSeconds === "number") {
        c.header("Retry-After", String(retryAfterSeconds));
      }
    }
    return mapErr(c, err, "POST /api/events/:id/refresh-poll");
  }
});
