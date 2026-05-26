// Data Sources HTTP routes.
//
// Unified per-tenant data_source registry over kinds youtube_channel /
// reddit_account / twitter_account / telegram_channel / discord_server.
// Only youtube_channel is wired; non-functional kinds reject at the service
// boundary with AppError 'kind_not_yet_functional' (422) which flows
// through `mapErr` automatically.
//
// Routes:
//   POST   /api/sources                - createSource
//   GET    /api/sources                - listSources (?includeDeleted=true)
//   GET    /api/sources/:id            - getSourceById
//   PATCH  /api/sources/:id            - updateSource
//   DELETE /api/sources/:id            - softDeleteSource (returns soft-deleted row)
//   DELETE /api/sources/:id?force=true - hardDeleteSource (permanent remove of already-soft-deleted)
//   POST   /api/sources/:id/restore    - restoreSource (422 retention_expired beyond RETENTION_DAYS)
//
// Every handler runs after the `/api/*` tenantScope middleware (anonymous -> 401)
// and after the proxy-trust middleware (clientIp + userAgent for audit).
// Cross-tenant access surfaces as NotFoundError -> 404 (never 403).

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  createSource,
  listSources,
  getSourceById,
  updateSource,
  softDeleteSource,
  hardDeleteSource,
  restoreSource,
  enforceRefreshContentCooldown,
  enforceRefreshContentIntentRateLimit,
  enforceSourceActionQuota,
} from "../../services/data-sources.js";
import { toDataSourceDto } from "../../dto.js";
import { getAuditContext } from "../middleware/audit-ip.js";
import { mapErr, type RouteVars } from "./_shared.js";
import { writeAuditStrict } from "../../audit.js";
import { AppError, NotFoundError } from "../../services/errors.js";
import { getAdapter } from "$lib/sources/registry.js";

// `"reddit"` is a synthetic, request-only kind. The UI picker on
// /sources/new sends it when the user wants the platform to choose between
// reddit_account and reddit_subreddit by URL shape. We resolve it here
// before handing off to createSource; the DB column never stores "reddit".
// Existing programmatic callers (tests, integrations) can still send the
// concrete reddit_account / reddit_subreddit values directly - both
// surfaces remain accepted.
const sourceKindEnum = z.enum([
  "youtube_channel",
  "reddit",
  "reddit_account",
  "reddit_subreddit",
  "twitter_account",
  "telegram_channel",
  "discord_server",
]);

// Initial-backfill window field. Defaults applied at the service layer
// (createSource picks '30d' when undefined), not here: keeping the field
// truly optional at the HTTP boundary mirrors the BackfillPicker's UI gate
// (the field is only POSTed when the picker is rendered, which happens
// iff kind=youtube_channel + autoImport).
const backfillWindowEnum = z.enum(["1d", "7d", "30d", "90d", "1y", "everything"]);

// channelId is intentionally NOT in the HTTP schema. The service-level
// CreateSourceInput accepts it for internal callers (tests, future
// server-side flows) but the public HTTP boundary must derive it from
// handleUrl. Otherwise an external client could POST
// {kind:'youtube_channel', handleUrl:'https://evil.com/x',
// channelId:'UCfaked...'} and createSource's
// `if (kind === 'youtube_channel' && resolvedChannelId === null)` gate
// would skip parseYoutubeChannelUrl/canonicalization because the
// supplied channelId was non-null - landing a row with a non-YouTube
// URL under kind=youtube_channel. The duplicate gate and polling
// adapters trust the kind/URL pairing; a forged channel_id breaks both.
// The UI never sends this field, so dropping it from the schema is
// non-breaking.
const createSourceSchema = z.object({
  kind: sourceKindEnum,
  handleUrl: z.string().url(),
  displayName: z.string().min(1).max(120).nullable().optional(),
  isOwnedByMe: z.boolean().optional(),
  autoImport: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  backfillWindow: backfillWindowEnum.optional(),
  // Optional absolute cutoff. When set, takes precedence over
  // backfillWindow — the UI uses this for the custom-date picker
  // alongside the preset row. Must be in the past — `.refine()` evaluates
  // at request time (unlike `.max(new Date())` which freezes at module load).
  backfillTargetSince: z.coerce
    .date()
    .optional()
    .refine((d) => d === undefined || d <= new Date(), {
      message: "backfillTargetSince must be in the past",
    }),
});

const updateSourceSchema = z
  .object({
    displayName: z.string().min(1).max(120).nullable().optional(),
    autoImport: z.boolean().optional(),
    isOwnedByMe: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    // Free-form per-user remark. 500-char ceiling — long enough for a
    // sentence-fragment annotation ("press contact for indie horror"),
    // short enough that the column doesn't become a free-text dumping
    // ground. Nullable to let the UI clear an existing note; the route
    // layer normalizes empty-string saves to null below so the field has
    // exactly two states: present (truthy non-empty) or unset.
    note: z.string().max(500).nullable().optional(),
    // Earliest-event boundary user wants pulled. Accept ISO date string
    // from UI (date picker / preset button). Coerced to Date and validated
    // server-side in updateSource:
    //   - must be in past (future dates -> 422 'date_must_be_past')
    //   - must NOT narrow window (<= current -> 422 'cannot_narrow_window')
    //
    // Lower bound: 1970-01-01 (the "all history" sentinel - preset button
    // "All" on detail page submits this value). UI date picker enforces a
    // tighter min (2005-01-01) for fat-finger protection on custom-date
    // input; the route schema's looser bound accepts the sentinel from the
    // preset path.
    backfillTargetSince: z.coerce
      .date()
      .min(new Date("1970-01-01T00:00:00Z"), "date too old")
      .optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "at least one field must be supplied",
  });

const listQuerySchema = z.object({
  includeDeleted: z.enum(["true", "false"]).optional(),
});

export const sourcesRoutes = new Hono<RouteVars>();

sourcesRoutes.post(
  "/sources",
  zValidator("json", createSourceSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    const body = c.req.valid("json");
    try {
      const resolved = resolveSyntheticRedditKind(body);
      const row = await createSource(
        ctx.userId,
        resolved,
        ctx.ipAddress,
        ctx.userAgent ?? undefined,
      );
      return c.json(toDataSourceDto(row), 201);
    } catch (err) {
      return mapErr(c, err, "POST /api/sources");
    }
  },
);

/** Resolve the synthetic UI kind "reddit" into the concrete reddit_account
 *  or reddit_subreddit by parsing the URL with redditParseSourceUrl. Any
 *  other kind passes through unchanged. Throws AppError 422 when the URL
 *  cannot be classified - the UI surfaces this as
 *  `sources_error_not_a_reddit_url`. */
function resolveSyntheticRedditKind(body: z.infer<typeof createSourceSchema>): z.infer<
  typeof createSourceSchema
> & {
  kind: Exclude<z.infer<typeof sourceKindEnum>, "reddit">;
} {
  if (body.kind !== "reddit") {
    return body as z.infer<typeof createSourceSchema> & {
      kind: Exclude<z.infer<typeof sourceKindEnum>, "reddit">;
    };
  }
  // parseSourceUrl is a SourceAdapter capability; reading it through the
  // registry keeps the cross-source route from importing per-adapter
  // internals. Reddit is the only adapter that declares it today.
  const parsed = getAdapter("reddit_account").parseSourceUrl?.(body.handleUrl) ?? null;
  if (parsed === null) {
    throw new AppError(
      "URL does not look like a Reddit subreddit or user profile",
      "invalid_reddit_url",
      422,
      { handleUrl: body.handleUrl },
    );
  }
  const metadataKey = parsed.kind === "reddit_account" ? "username" : "subreddit";
  return {
    ...body,
    kind: parsed.kind,
    handleUrl: parsed.externalUrl,
    metadata: { ...(body.metadata ?? {}), [metadataKey]: parsed.handle },
    displayName: body.displayName ?? parsed.handle,
  };
}

sourcesRoutes.get(
  "/sources",
  zValidator("query", listQuerySchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const includeDeleted = c.req.valid("query").includeDeleted === "true";
    try {
      const rows = await listSources(c.var.userId, { includeDeleted });
      return c.json(rows.map(toDataSourceDto));
    } catch (err) {
      return mapErr(c, err, "GET /api/sources");
    }
  },
);

sourcesRoutes.get("/sources/:id", async (c) => {
  try {
    const row = await getSourceById(c.var.userId, c.req.param("id"));
    return c.json(toDataSourceDto(row));
  } catch (err) {
    return mapErr(c, err, "GET /api/sources/:id");
  }
});

sourcesRoutes.patch(
  "/sources/:id",
  zValidator("json", updateSourceSchema, (r, c) => {
    if (!r.success) {
      return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }
  }),
  async (c) => {
    const ctx = getAuditContext(c);
    try {
      const body = c.req.valid("json");
      // Normalize empty-string note to null at the boundary. A truly
      // empty note has no UI representation distinct from "no note set",
      // so the column has exactly two states: NULL (no note) or non-empty
      // text. The UI's "Clear" path sends "" or null indifferently.
      const patch =
        body.note !== undefined && typeof body.note === "string" && body.note.trim().length === 0
          ? { ...body, note: null }
          : body;
      const row = await updateSource(
        ctx.userId,
        c.req.param("id"),
        patch,
        ctx.ipAddress,
        ctx.userAgent ?? undefined,
      );
      return c.json(toDataSourceDto(row));
    } catch (err) {
      return mapErr(c, err, "PATCH /api/sources/:id");
    }
  },
);

sourcesRoutes.delete("/sources/:id", async (c) => {
  const ctx = getAuditContext(c);
  const force = c.req.query("force") === "true";
  try {
    if (force) {
      await hardDeleteSource(ctx.userId, c.req.param("id"), ctx.ipAddress, ctx.userAgent ?? undefined);
      return c.body(null, 204);
    }
    const row = await softDeleteSource(
      ctx.userId,
      c.req.param("id"),
      ctx.ipAddress,
      ctx.userAgent ?? undefined,
    );
    return c.json(toDataSourceDto(row));
  } catch (err) {
    return mapErr(c, err, "DELETE /api/sources/:id");
  }
});

sourcesRoutes.post("/sources/:id/restore", async (c) => {
  const ctx = getAuditContext(c);
  try {
    const row = await restoreSource(
      ctx.userId,
      c.req.param("id"),
      ctx.ipAddress,
      ctx.userAgent ?? undefined,
    );
    return c.json(toDataSourceDto(row));
  } catch (err) {
    return mapErr(c, err, "POST /api/sources/:id/restore");
  }
});

// POST /api/sources/:id/refresh-content.
//
// The "Pull new content" button on /sources/[id] fires this endpoint, which
// dispatches via the registry to the per-kind adapter's backfillSource.
// For YouTube the adapter enqueues a youtube.backfill.channel job
// (singletonKey-deduped). Adding refresh for a new source kind requires
// zero edits here - only that adapter's backfillSource implementation.
//
// Invariants:
//   1. Tenant scoping - getSourceById(userId, params.id) is the entry point;
//      no unfiltered query.
//   2. Cross-tenant 404 not 403 - getSourceById throws NotFoundError on miss
//      OR cross-tenant; mapErr translates to {error:'not_found'} status 404.
//      Body never contains "forbidden" / "permission".
//   3. Anonymous-401 sweep - extended in tests/integration/anonymous-401.test.ts
//      MUST_BE_PROTECTED with this route's path pattern.
//   4. Audit INSERT-only - writeAuditStrict fires BEFORE the enqueue with
//      action "source.refresh_content_requested". STRICT variant: a failed
//      audit surfaces as 5xx before any adapter side effect occurs. This is
//      load-bearing for SQL-backed adapters (Reddit) whose queue rows also
//      serve as quota counters and are not pg-boss singletonKey-deduped.
//
// 422 path: getAdapter throws on unregistered kinds. We re-throw as
// AppError('kind_not_yet_functional', 422) so mapErr emits a clean wire
// format the UI can localize via Paraglide. createSource gates
// non-functional kinds out at write time, so in practice the only way a
// row's kind is unregistered here is during the per-phase rollout window
// (e.g. /sources page rendered a row created via direct schema insert).
sourcesRoutes.post("/sources/:id/refresh-content", async (c) => {
  const ctx = getAuditContext(c);
  try {
    // Tenant-scoped lookup FIRST, then rate-limit gate.
    //
    // If the rate-limit gate ran before getSourceById, a user hitting the
    // rate limit on an arbitrary (foreign or non-existent) sourceId would
    // receive 429 instead of the canonical 404. Cross-tenant resource
    // access returns 404 - period. Tenant lookup first eliminates the
    // ownership-disclosure gap a probe of the rate-limit error shape
    // would otherwise create.
    //
    // Cost: extra getSourceById round-trip for users actively spamming
    // the button. At indie scale that's a few queries / day at worst -
    // acceptable trade for invariant correctness.
    const source = await getSourceById(ctx.userId, c.req.param("id"));
    if (source.deletedAt !== null) {
      throw new NotFoundError();
    }

    await enforceRefreshContentIntentRateLimit(ctx.userId);
    await enforceRefreshContentCooldown(ctx.userId, source.id);

    let adapter;
    try {
      adapter = getAdapter(source.kind);
    } catch {
      throw new AppError(
        `kind '${source.kind}' is not yet functional`,
        "kind_not_yet_functional",
        422,
        { kind: source.kind },
      );
    }

    // Adapter-owned hard gate for source backfill.
    // Observability-only adapter signals must not become generic write-path policy.
    const adapterSource = {
      id: source.id,
      userId: source.userId,
      // Thread channelId + backfillTargetSince into metadata so
      // backfillSource can construct the channel-scoped job payload.
      metadata: {
        ...((source.metadata ?? {}) as Record<string, unknown>),
        channelId: source.channelId,
        backfillTargetSince: source.backfillTargetSince?.toISOString(),
      },
    };

    const backfillGuard = await adapter.canBackfillSource?.({
      source: adapterSource,
      userId: ctx.userId,
      origin: "user",
      now: new Date(),
    });
    if (backfillGuard?.action === "skip") {
      throw new AppError(
        `platform quota exhausted: ${source.kind}: ${backfillGuard.reason}`,
        "platform_quota_exhausted",
        429,
        {
          platform: source.kind,
          reason: backfillGuard.reason,
          retry_after_seconds:
            backfillGuard.retryAfterMs === undefined
              ? undefined
              : Math.ceil(backfillGuard.retryAfterMs / 1000),
        },
      );
    }

    await enforceSourceActionQuota(ctx.userId, adapter, ctx.ipAddress, source.kind);

    // STRICT INTENT AUDIT BEFORE ENQUEUE.
    //
    // The audit row is the rate-limit counter and the forensics record for
    // "user X clicked refresh on source Y". It must exist before the adapter
    // mutates its queue. This matters for Reddit: adapter_refresh_queue rows
    // are also sliding-window quota counters and are not singletonKey-deduped.
    // If we enqueued first and audit failed, a retry would be poisoned by the
    // prior queue row (429 instead of a clean retry) and the first side effect
    // would have no audit row. Auditing first makes the failure direction sane:
    // failed audit -> no side effect; failed enqueue -> audited intent.
    //
    // Worker completion writes a SECOND row with full usage metadata
    // (events_inserted, requests_used, flow). Cap query (services/quota.ts)
    // filters by metadata->>'flow' so it counts ONLY worker rows, not this
    // intent row.
    await writeAuditStrict({
      userId: ctx.userId,
      action: "source.refresh_content_requested",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent ?? undefined,
      metadata: {
        source_id: source.id,
        kind: source.kind,
        // `platform` for cap-query consistency. Intent rows are NOT
        // counted by the cap query (no `flow` field - see worker
        // completion audit), but we set `platform` anyway so any future
        // query that aggregates intent + completion stays consistent.
        platform: source.kind,
      },
    });

    // No eager state reset. The three-branch since-derivation in
    // backfill-channel.ts decides at walk-time whether the click is
    // steady-state (exhausted), incremental, or deep. Eagerly resetting
    // here would re-open the walk for ALL subscribers whenever one user
    // clicked refresh - a multi-tenant fairness violation.
    const result = await adapter.backfillSource(adapterSource, {
      userId: ctx.userId,
      origin: "user",
    });

    return c.json({ enqueued: true, queue: result.queue, jobId: result.jobId }, 202);
  } catch (err) {
    if (err instanceof AppError && err.code === "too_many_refreshes") {
      const retryAfterSeconds = err.metadata.retryAfterSeconds;
      if (typeof retryAfterSeconds === "number") {
        c.header("Retry-After", String(retryAfterSeconds));
      }
    }
    return mapErr(c, err, "POST /api/sources/:id/refresh-content");
  }
});
