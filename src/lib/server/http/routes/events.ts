// Events HTTP routes (Plan 02-08, extended in Plan 02.1-06; Plan 02.1-14
// gap closure adds restore; Plan 02.1-17 adds preview-url + url-required-for-
// youtube superRefine + authorIsMe in create/update schemas).
//
// Routes (Phase 2.1 unified-events shape):
//   POST   /api/events                         — createEvent (free-form; D-09 /events/new)
//   POST   /api/events/preview-url             — enrichFromUrl (Plan 02.1-17; no DB write)
//   GET    /api/events                         — listFeedPage (FEED-01 chronological pool)
//   GET    /api/events/deleted                 — listDeletedEvents (Plan 02.1-14 gap closure)
//   GET    /api/events/:id                     — getEventById
//   PATCH  /api/events/:id                     — updateEvent
//   DELETE /api/events/:id                     — softDeleteEvent
//   PATCH  /api/events/:id/attach              — attachToGame (GAMES-04a)
//   PATCH  /api/events/:id/dismiss-inbox       — dismissFromInbox (INBOX-01)
//   PATCH  /api/events/:id/restore             — restoreEvent (Plan 02.1-14 gap closure)
//
// Plan 02.1-17 deferral: enrichment does NOT auto-fill `occurredAt` in 2.1.
// YouTube oEmbed has no `published_at`; HTML scraping is fragile; YouTube
// Data API requires KEYS-01 (Phase 3). Client (Plan 02.1-18 /events/new)
// shows occurredAt = today (existing default) and lets the user override.
//
// Hono path-precedence note: GET /events/deleted is registered BEFORE
// GET /events/:id because Hono matches the first declaration at a given depth.
// Without this ordering, the parametric `:id` route would consume the literal
// `deleted` segment and the deleted-events list endpoint would never fire.
//
// `/api/games/:gameId/events` and `/api/games/:gameId/timeline` retired here:
//   - The per-game curated view now lives on /api/games/:gameId/events in
//     `routes/games.ts` calling `listEventsForGame` (replaces the Phase 2
//     timeline merge — events table is unified per Plan 02.1-01/05).
//   - `/api/games/:gameId/timeline` is REMOVED (Phase 2 D-37 timeline merge
//     retired with `listTimelineForGame`).
//
// `kind` mirrors the unified-events pgEnum (eventKindEnum from
// src/lib/server/db/schema/events.ts) — `youtube_video` / `reddit_post` are
// added (formerly tracked_youtube_videos rows). Service-layer
// `assertValidKind` is the second layer (defense-in-depth).
//
// AppError code mapping is automatic via `mapErr`:
//   - createEvent / updateEvent kind mismatch → AppError 'validation_failed' 422
//   - createEvent gameId cross-tenant → NotFoundError 404 (Pitfall 4)
//   - dismissFromInbox on attached event → AppError 'not_in_inbox' 422
//   - attachToGame cross-tenant gameId → NotFoundError 404
//   - cross-tenant /:id access → NotFoundError 404 (PRIV-01)
//
// Plan 02.1-19 contract change: GET /api/events query-string switches from
// ?attached=true|false&game=A&game=B to ?show=any|inbox|specific&game=A&game=B.
// The ?attached parameter is no longer recognized. Pre-launch destructive
// change (CONTEXT D-04: zero self-host deployments). UI consumers updated
// in lockstep — see /feed/+page.server.ts and FiltersSheet.svelte.

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
  attachToGame,
  dismissFromInbox,
  listDeletedEvents,
  restoreEvent,
  VALID_EVENT_KINDS,
  type ShowFilter,
} from "../../services/events.js";
import { parseIngestUrl } from "../../services/url-parser.js";
import type { EventKind } from "../../integrations/data-source-adapter.js";
import { toEventDto } from "../../dto.js";
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
 * Plan 02.1-17 — kind=youtube_video MUST carry a parseable YouTube url.
 * Other kinds accept null/undefined url (free-form events; conferences,
 * posts, etc.). Service-layer createEvent is the second layer of defense
 * (opportunistic external_id derivation); this superRefine is the
 * load-bearing validator.
 *
 * Shared between createEventSchema and updateEventSchema so a kind-change
 * PATCH that drops the url tripwires here too (plan-checker round-2 P0).
 */
function youtubeUrlRequired(
  obj: { kind?: string | undefined; url?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if (obj.kind !== "youtube_video") return;
  if (!obj.url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: "url is required for kind=youtube_video",
    });
    return;
  }
  const parsed = parseIngestUrl(obj.url);
  if (parsed.kind !== "youtube_video") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: "url must be a recognized YouTube video URL",
    });
  }
}

const createEventSchema = z
  .object({
    gameId: z.string().min(1).nullable().optional(),
    kind: eventKindEnum,
    occurredAt: z.string().datetime(),
    title: z.string().min(1).max(500),
    url: z.string().url().nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    // Plan 02.1-17 — authorIsMe round-trips through the schema so the
    // /events/new client can flip "Author: me / not me" at create time.
    // Service defaults to false when omitted (preserves existing semantics).
    authorIsMe: z.boolean().optional(),
  })
  .superRefine(youtubeUrlRequired);

const updateEventSchema = z
  .object({
    kind: eventKindEnum.optional(),
    occurredAt: z.string().datetime().optional(),
    title: z.string().min(1).max(500).optional(),
    url: z.string().url().nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    // Plan 02.1-17 — authorIsMe is also editable; the /events/[id]/edit form
    // (Plan 02.1-18) needs to flip the discriminator without re-creating the
    // event.
    authorIsMe: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "at least one field must be supplied",
  })
  .superRefine(youtubeUrlRequired);

// Feed query schema (RESEARCH §3.2 + Plan 02.1-15 multi-select). Multi-value
// axes (source / kind / game) are NOT validated here because Hono's
// `c.req.queries(name)` returns string[] for repeated params and the zod
// validator only sees the FIRST value of a repeated key. The multi-value
// axes are read separately via `c.req.queries(...)` below; the schema only
// enforces the single-value back-compat surface (one ?source=, one ?kind=,
// one ?game=). Defense-in-depth on the kind values lives in-handler against
// VALID_EVENT_KINDS.
//
// Booleans arrive as the strings "true"|"false" because URL query params are
// stringly-typed; we coerce to real booleans before calling listFeedPage.
const feedQuerySchema = z.object({
  cursor: z.string().optional(),
  // Plan 02.1-19: ?show replaces ?attached. ?attached is no longer recognized
  // (pre-launch destructive contract change — CONTEXT D-04).
  show: z.enum(["any", "inbox", "specific"]).optional(),
  authorIsMe: z.enum(["true", "false"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  all: z.enum(["1", "0"]).optional(),
});

const attachSchema = z.object({
  gameId: z.string().min(1).nullable(),
});

// Plan 02.1-17 — read-only enrichment endpoint. Pure URL parse + oEmbed fetch,
// no DB write. The /events/new client (Plan 02.1-18) calls this before the
// user submits the form so they see auto-filled title + thumbnail + external_id
// without committing the row.
const previewUrlSchema = z.object({
  url: z.string().url(),
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
      return c.json(toEventDto(ev), 201);
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
    // Plan 02.1-15: multi-value axes via Hono's c.req.queries() — repeated
    // ?source=A&source=B query params produce string[]. Single-param /
    // back-compat callers receive a one-element array which the service-layer
    // pushAxis helper collapses to eq() (zero query-plan regression).
    const sourceList = c.req.queries("source") ?? undefined;
    const kindList = c.req.queries("kind") as EventKind[] | undefined;
    const gameList = c.req.queries("game") ?? [];
    // Defense-in-depth (Pitfall 6): validate each kind value against the
    // closed enum BEFORE the service. Service-level assertValidKind is the
    // second layer; the route-layer 422 here keeps the failure mode crisp
    // for malformed multi-value URLs.
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
    // Plan 02.1-19: discriminated show axis replaces attached + game pair.
    // A bare ?game= without ?show=specific is ignored — the UI never produces
    // that combo.
    const showParam = q.show ?? "any";
    const showFilter: ShowFilter =
      showParam === "inbox"
        ? { kind: "inbox" }
        : showParam === "specific"
          ? { kind: "specific", gameIds: gameList }
          : { kind: "any" };
    try {
      const page = await listFeedPage(
        c.var.userId,
        {
          source: sourceList && sourceList.length > 0 ? sourceList : undefined,
          kind: kindList && kindList.length > 0 ? kindList : undefined,
          show: showFilter,
          authorIsMe:
            q.authorIsMe === "true"
              ? true
              : q.authorIsMe === "false"
                ? false
                : undefined,
          // Date-only (YYYY-MM-DD) is inclusive on both ends — see /feed/+page.server.ts.
          from: q.from ? new Date(`${q.from}T00:00:00.000Z`) : undefined,
          to: q.to ? new Date(`${q.to}T23:59:59.999Z`) : undefined,
        },
        q.cursor ?? null,
      );
      return c.json({
        rows: page.rows.map(toEventDto),
        nextCursor: page.nextCursor,
      });
    } catch (err) {
      return mapErr(c, err, "GET /api/events");
    }
  },
);

// Plan 02.1-17 — POST /api/events/preview-url. Read-only enrichment; no DB
// write. Tenant-scoped (mounted under tenantScope) so anonymous → 401, but
// no tenant-owned data is read (the URL is the only input). HONO PATH-
// PRECEDENCE: register BEFORE any parametric POST `/events/:id/...` route
// (none currently exist for POST, but Plan 02.1-14 precedent applies — keep
// literals first as a discipline).
eventsRoutes.post(
  "/events/preview-url",
  zValidator("json", previewUrlSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    try {
      const enriched = await enrichFromUrl(
        c.var.userId,
        c.req.valid("json").url,
      );
      return c.json({
        kind: enriched.kind,
        externalId: enriched.externalId,
        title: enriched.title,
        thumbnailUrl: enriched.thumbnailUrl,
        // ISO string when set; null in 2.1 (Phase 3 fills via YouTube Data API key).
        occurredAt: enriched.occurredAt
          ? enriched.occurredAt.toISOString()
          : null,
      });
    } catch (err) {
      return mapErr(c, err, "POST /api/events/preview-url");
    }
  },
);

// Plan 02.1-14: must register BEFORE GET /events/:id because Hono matches
// the first registration at a given depth. The literal "deleted" segment
// would otherwise be consumed by the parametric `:id`.
eventsRoutes.get("/events/deleted", async (c) => {
  try {
    const rows = await listDeletedEvents(c.var.userId);
    return c.json({ rows: rows.map(toEventDto) });
  } catch (err) {
    return mapErr(c, err, "GET /api/events/deleted");
  }
});

eventsRoutes.get("/events/:id", async (c) => {
  try {
    const ev = await getEventById(c.var.userId, c.req.param("id"));
    return c.json(toEventDto(ev));
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
      return c.json(toEventDto(ev));
    } catch (err) {
      return mapErr(c, err, "PATCH /api/events/:id");
    }
  },
);

eventsRoutes.delete("/events/:id", async (c) => {
  const ctx = getAuditContext(c);
  try {
    await softDeleteEvent(
      ctx.userId,
      c.req.param("id"),
      ctx.ipAddress,
      ctx.userAgent ?? undefined,
    );
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
    const body = c.req.valid("json");
    try {
      const ev = await attachToGame(
        ctx.userId,
        c.req.param("id"),
        body.gameId,
        ctx.ipAddress,
        ctx.userAgent ?? undefined,
      );
      return c.json(toEventDto(ev));
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
    return c.json(toEventDto(ev));
  } catch (err) {
    return mapErr(c, err, "PATCH /api/events/:id/dismiss-inbox");
  }
});

// Plan 02.1-14 (gap closure) — restore a soft-deleted event. Cross-tenant /
// never-deleted / past-retention all return 404 by construction (the service
// throws NotFoundError for all three cases; mapErr translates to
// {error: "not_found"} status 404, never 403 — PRIV-01 / CLAUDE.md rule 2).
eventsRoutes.patch("/events/:id/restore", async (c) => {
  const ctx = getAuditContext(c);
  try {
    const ev = await restoreEvent(
      ctx.userId,
      c.req.param("id"),
      ctx.ipAddress,
      ctx.userAgent ?? undefined,
    );
    return c.json(toEventDto(ev));
  } catch (err) {
    return mapErr(c, err, "PATCH /api/events/:id/restore");
  }
});
