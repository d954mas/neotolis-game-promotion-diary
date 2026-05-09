// Data Sources HTTP routes (Plan 02.1-06 — Wave 2).
//
// Replaces the Phase 2 per-platform channel route group with a unified
// per-tenant data_source registry over kinds youtube_channel /
// reddit_account / twitter_account / telegram_channel / discord_server.
// In Phase 2.1 only youtube_channel is wired; non-functional kinds reject at
// the service boundary with AppError 'kind_not_yet_functional' (422) which
// flows through `mapErr` automatically.
//
// Routes:
//   POST   /api/sources                — createSource
//   GET    /api/sources                — listSources (?includeDeleted=true)
//   GET    /api/sources/:id            — getSourceById
//   PATCH  /api/sources/:id            — updateSource
//   DELETE /api/sources/:id            — softDeleteSource (returns soft-deleted row)
//   POST   /api/sources/:id/restore    — restoreSource (422 retention_expired beyond RETENTION_DAYS)
//
// Every handler runs after the `/api/*` tenantScope middleware (anonymous → 401)
// and after Plan 06's proxy-trust middleware (clientIp + userAgent for audit).
// Cross-tenant access surfaces as NotFoundError → 404 (PRIV-01: never 403).

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, count, eq, gte, sql } from "drizzle-orm";
import {
  createSource,
  listSources,
  getSourceById,
  updateSource,
  softDeleteSource,
  restoreSource,
  resetSourceBackfillComplete,
} from "../../services/data-sources.js";
import { getUserQuotaUsedToday, nextPacificMidnight } from "../../services/quota.js";
import { toDataSourceDto } from "../../dto.js";
import { db } from "../../db/client.js";
import { auditLog } from "../../db/schema/audit-log.js";
import { getAuditContext } from "../middleware/audit-ip.js";
import { mapErr, type RouteVars } from "./_shared.js";
import { writeAuditStrict } from "../../audit.js";
import { AppError, NotFoundError } from "../../services/errors.js";
import { getAdapter } from "$lib/sources/registry.js";

// Phase 03.0.1 architecture cleanup — refresh-content rate limit. Cap on
// per-user POST /api/sources/:id/refresh-content calls in any rolling 1-min
// window. Bounds quota burn from a user mashing the "Pull new content"
// button across N registered sources: singletonKey already dedupes per
// source (~5min), but a user with many sources can still queue 1 backfill
// per source per 5min — the per-user cap pins overall throughput.
//
// Counter source: audit_log itself. Every successful refresh-content writes
// `source.refresh_content_requested` with a server timestamp. A `SELECT
// COUNT(*) WHERE userId AND action AND created_at > NOW() - 60s` is the
// natural rate-counter — no new table, no in-memory store (which would
// suffer the same multi-replica drift as the chargedFetch reservoir).
//
// Limit chosen at 10/min (one click every 6s) — generous for the "many
// sources after a workday" UX without creating a backfill stampede if a
// user had every source actively churning. Tunable via env if abuse
// signal demands tightening.
const REFRESH_CONTENT_RATE_LIMIT_PER_MINUTE = 10;
const REFRESH_CONTENT_RATE_WINDOW_MS = 60_000;

const sourceKindEnum = z.enum([
  "youtube_channel",
  "reddit_account",
  "twitter_account",
  "telegram_channel",
  "discord_server",
]);

// Phase 03.0-12 (D-09) — initial-backfill window field. Defaults applied
// at the service layer (createSource picks '30d' when undefined), not here:
// keeping the field truly optional at the HTTP boundary mirrors the
// BackfillPicker's UI gate (the field is only POSTed when the picker is
// rendered, which happens iff kind=youtube_channel + autoImport).
const backfillWindowEnum = z.enum(["1d", "7d", "30d", "90d", "1y", "everything"]);

// channelId is intentionally NOT in the HTTP schema (post-build review
// 2026-05-08, 8th pass). The service-level CreateSourceInput accepts it
// for internal callers (tests, future server-side flows) but the public
// HTTP boundary must derive it from handleUrl. Pre-fix, an external
// client could POST {kind:'youtube_channel', handleUrl:'https://evil.com/x',
// channelId:'UCfaked...'} and createSource's
// `if (kind === 'youtube_channel' && resolvedChannelId === null)` gate
// would skip parseYoutubeChannelUrl/canonicalization because the
// supplied channelId was non-null — landing a row with a non-YouTube
// URL under kind=youtube_channel. The duplicate gate and polling
// adapters trust the kind/URL pairing; a forged channel_id breaks both.
// The UI never sends this field (sources/new/+page.svelte uses only
// handleUrl), so dropping it from the schema is non-breaking.
const createSourceSchema = z.object({
  kind: sourceKindEnum,
  handleUrl: z.string().url(),
  displayName: z.string().min(1).max(120).nullable().optional(),
  isOwnedByMe: z.boolean().optional(),
  autoImport: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  backfillWindow: backfillWindowEnum.optional(),
});

const updateSourceSchema = z
  .object({
    displayName: z.string().min(1).max(120).nullable().optional(),
    autoImport: z.boolean().optional(),
    isOwnedByMe: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    // Phase 03.0.1 — earliest-event boundary user wants pulled.
    // Accept ISO date string from UI (date picker). Coerced to Date and
    // validated server-side in updateSource: must be in past; future dates
    // → 422 'date_must_be_past'.
    //
    // Lower bound: 2005-01-01 (YouTube launch) — defensive validation.
    // Anything older is either a fat-finger user input or the legacy migration
    // 0024 sentinel '1970-01-01' (mapped from `metadata.backfillWindow:
    // "everything"` preset for existing rows). The sentinel survives in
    // legacy rows but new PATCHes can't introduce it. Rejecting < 2005 forces
    // user input through a sane date range without exposing the sentinel as
    // a user-pickable value.
    backfillTargetSince: z.coerce
      .date()
      .min(new Date("2005-01-01T00:00:00Z"), "date too old (earliest: 2005-01-01)")
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
      const row = await createSource(ctx.userId, body, ctx.ipAddress, ctx.userAgent ?? undefined);
      return c.json(toDataSourceDto(row), 201);
    } catch (err) {
      return mapErr(c, err, "POST /api/sources");
    }
  },
);

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
      const row = await updateSource(
        ctx.userId,
        c.req.param("id"),
        c.req.valid("json"),
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
  try {
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

// Phase 03.0.1 Plan 10 — POST /api/sources/:id/refresh-content (D-NEW).
//
// User-facing payoff of the Wave 0-8 refactor: the "Pull new content" button
// on /sources/[id] fires this endpoint, which dispatches via the registry to
// the per-kind adapter's backfillSource. For YouTube the adapter enqueues a
// youtube.backfill.user job (singletonKey-deduped to ~5min). Adding refresh
// for Reddit (Phase 03.1) requires zero edits here — only the Reddit
// adapter's backfillSource implementation.
//
// AGENTS.md invariants:
//   1. Tenant scoping — getSourceById(userId, params.id) is the entry point;
//      no unfiltered query.
//   2. Cross-tenant 404 not 403 — getSourceById throws NotFoundError on miss
//      OR cross-tenant; mapErr translates to {error:'not_found'} status 404.
//      Body never contains "forbidden" / "permission" (tenant-scope test
//      pins the wire format).
//   3. Anonymous-401 sweep — extended in tests/integration/anonymous-401.test.ts
//      MUST_BE_PROTECTED with this route's path pattern.
//   4. Audit INSERT-only — writeAuditStrict fires after the enqueue with
//      action "source.refresh_content_requested" (forward-only migration
//      0023 added the enum value). STRICT variant: a failed audit surfaces
//      as 5xx so the caller retries; the queue's singletonKey dedupes the
//      re-enqueue (no-op) and the second writeAuditStrict succeeds. This
//      preserves the audit-row-per-action contract without a transactional
//      enqueue (which would require pushing pg-boss IDatabase plumbing
//      through the adapter contract).
//
// 422 path: getAdapter throws on unregistered kinds. We re-throw as
// AppError('kind_not_yet_functional', 422) so mapErr emits a clean wire
// format the UI can localize via Paraglide. Phase 2.1's createSource gates
// non-functional kinds out at write time, so in practice the only way a
// row's kind is unregistered here is during the per-phase rollout window
// (e.g. /sources page rendered a reddit_account row created via direct
// schema insert in tests).
sourcesRoutes.post("/sources/:id/refresh-content", async (c) => {
  const ctx = getAuditContext(c);
  try {
    // Phase 03.0.1 — per-user rolling rate limit (see REFRESH_CONTENT_RATE_LIMIT_PER_MINUTE
    // header comment for the audit_log-backed counter rationale). Runs FIRST
    // so a user spamming the button can't even pay the getSourceById round
    // trip cost. Anonymous → 401 already fired in tenantScope middleware,
    // so ctx.userId is guaranteed here.
    const since = new Date(Date.now() - REFRESH_CONTENT_RATE_WINDOW_MS);
    // Phase 03.0.1 (post-review) — count INTENT rows only.
    // `source.refresh_content_requested` is written twice per click:
    //   1. INTENT — endpoint pre-enqueue (no `flow`, no `events_inserted`)
    //   2. COMPLETION — worker post-pollContent (sets `flow` + `events_inserted`)
    // Pre-fix the rate-limit query counted both, halving the effective window
    // (~5 clicks/min instead of declared 10). Filtering on `flow IS NULL`
    // matches only intent rows — exactly one per user click.
    const [recent] = await db
      .select({ c: count() })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.userId, ctx.userId),
          eq(auditLog.action, "source.refresh_content_requested"),
          gte(auditLog.createdAt, since),
          sql`${auditLog.metadata}->>'flow' IS NULL`,
        ),
      );
    if (Number(recent?.c ?? 0) >= REFRESH_CONTENT_RATE_LIMIT_PER_MINUTE) {
      throw new AppError(
        `refresh-content rate limit exceeded: ${REFRESH_CONTENT_RATE_LIMIT_PER_MINUTE}/min per user`,
        "rate_limited",
        429,
        {
          limit: REFRESH_CONTENT_RATE_LIMIT_PER_MINUTE,
          window_seconds: REFRESH_CONTENT_RATE_WINDOW_MS / 1000,
        },
      );
    }

    const source = await getSourceById(ctx.userId, c.req.param("id"));
    if (source.deletedAt !== null) {
      // Soft-deleted source — surface as 404 (matches GET /sources/:id /
      // PATCH /sources/:id pattern: tombstone is invisible to the
      // non-restore mutations).
      throw new NotFoundError();
    }

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

    // Phase 03.0.1 — L1 throttle check (operator-side reservoir).
    // When operator's YouTube quota approaches 95%, ALL users get 429 — это
    // system-wide signal, не per-user. Banner UI на /sources показывает
    // отдельный indicator для этого state.
    const stats = await adapter.observability.quota.getDailyStats(new Date());
    if (stats.throttleState === "ninetyfive") {
      throw new AppError(
        `platform quota exhausted: ${source.kind} at ${stats.pctOfDaily}% (system-wide)`,
        "platform_quota_exhausted",
        429,
        {
          platform: source.kind,
          pct_of_daily: stats.pctOfDaily,
        },
      );
    }

    // Phase 03.0.1 — L2 per-user fair-share cap. When adapter declares
    // userQuotaCap, check audit-log SUM против cap. Per-axis denial:
    // requests_quota_exhausted vs events_quota_exhausted (banner UI shows
    // distinct toast).
    const cap = adapter.observability.userQuotaCap;
    if (cap?.requestsPerDay !== undefined || cap?.eventsPerDay !== undefined) {
      const used = await getUserQuotaUsedToday(ctx.userId, source.kind);
      const resetAt = nextPacificMidnight();
      const resetInSeconds = Math.max(0, Math.floor((resetAt.getTime() - Date.now()) / 1000));
      if (cap.requestsPerDay !== undefined && used.requests >= cap.requestsPerDay) {
        throw new AppError(
          `daily request quota exhausted: ${used.requests}/${cap.requestsPerDay}`,
          "requests_quota_exhausted",
          429,
          {
            cap: cap.requestsPerDay,
            used: used.requests,
            reset_in_seconds: resetInSeconds,
          },
        );
      }
      if (cap.eventsPerDay !== undefined && used.events >= cap.eventsPerDay) {
        throw new AppError(
          `daily events quota exhausted: ${used.events}/${cap.eventsPerDay}`,
          "events_quota_exhausted",
          429,
          {
            cap: cap.eventsPerDay,
            used: used.events,
            reset_in_seconds: resetInSeconds,
          },
        );
      }
    }

    // Phase 03.0.1 — trust-but-verify. Reset backfill_complete BEFORE worker
    // enqueue so the catch-up worker re-checks completeness. If канал ничего
    // нового не имеет, worker re-устанавливает true. Если был silent error,
    // user refresh даёт chance recover.
    await resetSourceBackfillComplete(ctx.userId, source.id);

    const result = await adapter.backfillSource(
      {
        id: source.id,
        userId: source.userId,
        metadata: (source.metadata ?? {}) as Record<string, unknown>,
      },
      { userId: ctx.userId, origin: "user" },
    );

    // STRICT — failed audit returns 5xx; user retry hits singletonKey dedup
    // on the queue (no-op enqueue) and the audit INSERT retries. AGENTS.md
    // invariant 4 honored without a transactional enqueue plumbing.
    //
    // This is the INTENT row — written pre-completion for immediate forensics
    // ("user X clicked refresh on source Y at time T"). Worker writes a
    // SECOND row at completion with full metadata (events_inserted,
    // requests_used, flow). Cap query (services/quota.ts) filters by
    // metadata->>'flow' so it counts ONLY worker rows, not intent rows.
    await writeAuditStrict({
      userId: ctx.userId,
      action: "source.refresh_content_requested",
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent ?? undefined,
      metadata: {
        source_id: source.id,
        kind: source.kind,
        // Phase 03.0.1 (post-review) — `platform` for cap-query consistency.
        // Intent rows are NOT counted by the cap query (no `flow` field — see
        // worker completion audit), but we set `platform` anyway so any
        // future query that aggregates intent + completion stays consistent.
        platform: source.kind,
        queue: result.queue,
        job_id: result.jobId,
      },
    });

    return c.json({ enqueued: true, queue: result.queue, jobId: result.jobId }, 202);
  } catch (err) {
    return mapErr(c, err, "POST /api/sources/:id/refresh-content");
  }
});
