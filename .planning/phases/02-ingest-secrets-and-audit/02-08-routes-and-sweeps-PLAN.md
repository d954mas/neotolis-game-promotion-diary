---
phase: 02-ingest-secrets-and-audit
plan: 08
type: execute
wave: 2
depends_on: [02-04-games-services, 02-05-api-keys-steam-service, 02-06-ingest-and-events-services, 02-07-audit-read-service]
files_modified:
  - src/lib/server/http/routes/games.ts
  - src/lib/server/http/routes/game-listings.ts
  - src/lib/server/http/routes/youtube-channels.ts
  - src/lib/server/http/routes/api-keys-steam.ts
  - src/lib/server/http/routes/items-youtube.ts
  - src/lib/server/http/routes/events.ts
  - src/lib/server/http/routes/audit.ts
  - src/lib/server/http/routes/me-theme.ts
  - src/lib/server/http/app.ts
  - src/lib/server/services/me.ts
  - tests/integration/anonymous-401.test.ts
  - tests/integration/tenant-scope.test.ts
  - tests/integration/log-redact.test.ts
autonomous: true
requirements: [GAMES-01, GAMES-02, GAMES-03, GAMES-04a, KEYS-03, KEYS-04, KEYS-05, KEYS-06, INGEST-02, INGEST-03, INGEST-04, EVENTS-01, EVENTS-02, EVENTS-03, PRIV-02, UX-01]
requirements_addressed: [GAMES-01, GAMES-02, GAMES-03, GAMES-04a, KEYS-03, KEYS-04, KEYS-05, KEYS-06, INGEST-02, INGEST-03, INGEST-04, EVENTS-01, EVENTS-02, EVENTS-03, PRIV-02, UX-01]
must_haves:
  truths:
    - "Every Phase 2 service is reachable via a Hono sub-router mounted under /api/* (gated by tenantScope)"
    - "Every new /api/* route is added to MUST_BE_PROTECTED and the cross-tenant 404 matrix"
    - "POST /api/me/theme updates cookie + DB + audits theme.changed (UX-01)"
    - "Error handling: AppError → status + {error: code}; NotFoundError → 404 {error:'not_found'}; ZodError → 422 {error:'validation_failed', details}"
    - "Pino redact never emits ciphertext field names during request flow (cross-cutting log-redact test)"
    - "Cross-tenant test extends to all 14 D-37 routes and asserts 404 (never 403)"
    - "Phase 1's deferred VALIDATION 8/9 (cross-tenant write/delete) it.skip stubs are now LIVE it() against /api/games"
  artifacts:
    - path: "src/lib/server/http/routes/games.ts"
      provides: "POST /api/games, GET /api/games, GET /api/games/:id, PATCH /api/games/:id, DELETE /api/games/:id, POST /api/games/:id/restore"
      contains: "createGame"
      min_lines: 80
    - path: "src/lib/server/http/routes/api-keys-steam.ts"
      provides: "POST /api/api-keys/steam, GET /api/api-keys/steam, GET /api/api-keys/steam/:id, PATCH /api/api-keys/steam/:id, DELETE /api/api-keys/steam/:id"
      contains: "createSteamKey"
      min_lines: 60
    - path: "src/lib/server/http/routes/items-youtube.ts"
      provides: "POST /api/items/youtube (paste-orchestrator), GET /api/games/:gameId/items, PATCH /api/items/youtube/:id, DELETE /api/items/youtube/:id"
      contains: "parsePasteAndCreate"
      min_lines: 60
    - path: "src/lib/server/http/routes/events.ts"
      provides: "POST /api/events, GET /api/games/:gameId/events, PATCH /api/events/:id, DELETE /api/events/:id, GET /api/games/:gameId/timeline"
      contains: "listTimelineForGame"
      min_lines: 60
    - path: "src/lib/server/http/routes/audit.ts"
      provides: "GET /api/audit?cursor=&action="
      contains: "listAuditPage"
      min_lines: 30
    - path: "src/lib/server/http/routes/me-theme.ts"
      provides: "POST /api/me/theme — UX-01 cookie + DB + audit"
      contains: "theme.changed"
      min_lines: 40
  key_links:
    - from: "src/lib/server/http/app.ts"
      to: "src/lib/server/http/routes/{games,game-listings,youtube-channels,api-keys-steam,items-youtube,events,audit,me-theme}.ts"
      via: "app.route('/api', <subRouter>) for each new sub-router"
      pattern: "app\\.route\\(\"/api\""
    - from: "tests/integration/anonymous-401.test.ts"
      to: "src/lib/server/http/app.ts"
      via: "MUST_BE_PROTECTED extended with the 14 new /api/* routes (D-37)"
      pattern: "MUST_BE_PROTECTED"
    - from: "tests/integration/tenant-scope.test.ts"
      to: "every Phase 2 service"
      via: "Cross-tenant 404 matrix sweep (read + write + delete) per D-37"
      pattern: "cross-tenant"
---

<objective>
Land all HTTP routes (Hono sub-routers) for the seven Phase 2 service surfaces + `POST /api/me/theme` (UX-01 server side). Wire every new route under `app.route('/api', ...)` so it inherits the existing `tenantScope` middleware. Extend the anonymous-401 sweep allowlist + cross-tenant 404 matrix per D-37. Replace Phase 1's two deferred `it.skip` stubs in `tests/integration/tenant-scope.test.ts` (cross-tenant write + delete) with live tests against `/api/games`. Cross-cutting log-redact test asserts no ciphertext field names appear in stdout during a typical request flow.

Purpose: Translate the Wave 1 service layer into HTTP. The route layer is mostly mechanical — zod-validated body / params, service call, DTO projection, error mapping. The load-bearing cross-cutting work in this plan is the sweep extension (anonymous-401 vacuous-pass guard) and the tenant-scope matrix (every new route gets a live cross-tenant 404 assertion). Get those right; downstream UI (Plan 09 / 10) builds on a known-correct API.

Output: 8 new route files (7 entity routers + me-theme), `app.ts` mounts, `services/me.ts` extension for theme-update, sweep-test extensions, log-redact integration test.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/lib/server/http/app.ts
@src/lib/server/http/routes/me.ts
@src/lib/server/http/routes/sessions.ts
@src/lib/server/http/middleware/tenant.ts
@src/lib/server/http/middleware/audit-ip.ts
@src/lib/server/services/games.ts
@src/lib/server/services/api-keys-steam.ts
@src/lib/server/services/items-youtube.ts
@src/lib/server/services/events.ts
@src/lib/server/services/ingest.ts
@src/lib/server/services/audit-read.ts
@src/lib/server/services/me.ts
@src/lib/server/dto.ts
@src/lib/server/services/errors.ts
@src/lib/server/audit/actions.ts
@.planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md
@.planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md
@.planning/phases/02-ingest-secrets-and-audit/02-04-SUMMARY.md
@.planning/phases/02-ingest-secrets-and-audit/02-05-SUMMARY.md
@.planning/phases/02-ingest-secrets-and-audit/02-06-SUMMARY.md
@.planning/phases/02-ingest-secrets-and-audit/02-07-SUMMARY.md

<interfaces>
<!-- Hono route convention (Phase 1 src/lib/server/http/routes/me.ts):

export const xRoutes = new Hono<{ Variables: { userId: string; sessionId: string; clientIp: string } }>();
xRoutes.post("/path", zValidator("json", schema), async (c) => {
  const userId = c.var.userId;
  try { ... return c.json(dto, 201); }
  catch (err) {
    if (err instanceof NotFoundError) return c.json({error:'not_found'}, 404);
    if (err instanceof AppError) return c.json({error: err.code}, err.status as 400|401|404|422|500);
    logger.error({err, userId}, "x route unhandled error");
    return c.json({error:'internal_server_error'}, 500);
  }
});

In app.ts: app.route('/api', xRoutes);
-->

<!-- D-37 — full route matrix for cross-tenant + anonymous-401 sweeps:
  /api/games (GET, POST)
  /api/games/:id (GET, PATCH, DELETE)
  /api/games/:id/restore (POST)
  /api/games/:gameId/listings (GET, POST)
  /api/games/:gameId/listings/:listingId (DELETE, PATCH for attach key)
  /api/youtube-channels (GET, POST)
  /api/youtube-channels/:id (PATCH, DELETE)
  /api/games/:gameId/youtube-channels (GET, POST attach, DELETE detach)
  /api/api-keys/steam (GET, POST)
  /api/api-keys/steam/:id (GET, PATCH, DELETE)
  /api/items/youtube (POST — paste orchestrator)
  /api/items/youtube/:id (PATCH, DELETE)
  /api/games/:gameId/items (GET)
  /api/events (POST)
  /api/events/:id (GET, PATCH, DELETE)
  /api/games/:gameId/events (GET)
  /api/games/:gameId/timeline (GET)
  /api/audit (GET)
  /api/me/theme (POST)
-->

<!-- Phase 1 anonymous-401 sweep (tests/integration/anonymous-401.test.ts):
const MUST_BE_PROTECTED = ["/api/me"];
Vacuous-pass guard: every required route MUST appear in `protectedPaths` extracted from `app.routes`.
Plan 02-08 extends MUST_BE_PROTECTED to include every new /api/* path AT THE PARAMETERIZED LEVEL
(so /api/games/:id → list contains "/api/games/:id"). Use the literal route patterns Hono registered.
-->
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Create 8 route files + extend me-service for theme-update + wire all into app.ts</name>
  <files>src/lib/server/http/routes/games.ts, src/lib/server/http/routes/game-listings.ts, src/lib/server/http/routes/youtube-channels.ts, src/lib/server/http/routes/api-keys-steam.ts, src/lib/server/http/routes/items-youtube.ts, src/lib/server/http/routes/events.ts, src/lib/server/http/routes/audit.ts, src/lib/server/http/routes/me-theme.ts, src/lib/server/http/app.ts, src/lib/server/services/me.ts</files>
  <read_first>
    - src/lib/server/http/routes/me.ts (Phase 1 — error-translation pattern; Hono Variables shape; meRoutes mount)
    - src/lib/server/http/routes/sessions.ts (Phase 1 — second sub-router example, simpler; verifies the multi-router pattern)
    - src/lib/server/http/app.ts (current mounts: meRoutes + sessionRoutes; this plan adds 8 more route()-calls)
    - src/lib/server/http/middleware/audit-ip.ts (getAuditContext helper for clientIp + userAgent on audit writes from route handlers)
    - src/lib/server/services/me.ts (Phase 1 — `getMe(userId)`; this plan adds `updateUserTheme(userId, theme, ipAddress)` here)
    - All Wave 1 service files (Plans 04–07) — function signatures already defined; this plan only WIRES them
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"Hono Zod validation pattern" lines 827–862 (zValidator usage + 422 error envelope)
    - .planning/phases/02-ingest-secrets-and-audit/02-UI-SPEC.md §"<PasteBox> interaction contract" (UI-side validation order; the route MUST mirror it)
  </read_first>
  <action>
    All routes follow the same template — error-mapping block, zod schema, service call, DTO projection. Below are the route signatures and the canonical implementation.

    **Common route file template:**
    ```typescript
    import { Hono } from "hono";
    import { zValidator } from "@hono/zod-validator";
    import { z } from "zod";
    import { NotFoundError, AppError } from "../../services/errors.js";
    import { getAuditContext } from "../middleware/audit-ip.js";
    import { logger } from "../../logger.js";
    // ... import services + DTOs + schema as needed

    type Vars = { Variables: { userId: string; sessionId: string; clientIp: string; clientProto: "http"|"https" } };

    function mapErr(c: any, err: unknown, route: string) {
      if (err instanceof NotFoundError) return c.json({ error: "not_found" }, 404);
      if (err instanceof AppError) {
        return c.json({ error: err.code }, err.status as 400|401|403|404|409|422|500|502);
      }
      logger.error({ err, route }, "unhandled error");
      return c.json({ error: "internal_server_error" }, 500);
    }

    export const xRoutes = new Hono<Vars>();
    // ... declarations
    ```

    **A. `src/lib/server/http/routes/games.ts`**:

    ```typescript
    // POST /api/games — create
    // GET /api/games — list (?includeSoftDeleted=true|false)
    // GET /api/games/:id — read one
    // PATCH /api/games/:id — partial update
    // DELETE /api/games/:id — soft-delete
    // POST /api/games/:id/restore — restore

    const createGameSchema = z.object({
      title: z.string().min(1).max(200),
      notes: z.string().max(5000).optional(),
    });
    const updateGameSchema = z.object({
      title: z.string().min(1).max(200).optional(),
      notes: z.string().max(5000).optional(),
      tags: z.array(z.string().max(50)).max(50).optional(),
      releaseTba: z.boolean().optional(),
      releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      coverUrl: z.string().url().nullable().optional(),
    });

    gamesRoutes.post("/games", zValidator("json", createGameSchema, (r, c) => {
      if (!r.success) return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }), async (c) => {
      const ctx = getAuditContext(c);
      try {
        const game = await createGame(ctx.userId, c.req.valid("json"), ctx.ipAddress);
        return c.json(toGameDto(game), 201);
      } catch (err) { return mapErr(c, err, "/api/games"); }
    });

    gamesRoutes.get("/games", async (c) => {
      const includeSoftDeleted = c.req.query("includeSoftDeleted") === "true";
      try {
        const list = await listGames(c.var.userId, { includeSoftDeleted });
        return c.json(list.map(toGameDto));
      } catch (err) { return mapErr(c, err, "GET /api/games"); }
    });

    gamesRoutes.get("/games/:id", async (c) => {
      try {
        const g = await getGameById(c.var.userId, c.req.param("id"));
        return c.json(toGameDto(g));
      } catch (err) { return mapErr(c, err, "/api/games/:id"); }
    });

    gamesRoutes.patch("/games/:id", zValidator("json", updateGameSchema, ...), async (c) => {
      try {
        const g = await updateGame(c.var.userId, c.req.param("id"), c.req.valid("json"));
        return c.json(toGameDto(g));
      } catch (err) { return mapErr(c, err, "PATCH /api/games/:id"); }
    });

    gamesRoutes.delete("/games/:id", async (c) => {
      const ctx = getAuditContext(c);
      try {
        await softDeleteGame(c.var.userId, c.req.param("id"), ctx.ipAddress);
        return c.body(null, 204);
      } catch (err) { return mapErr(c, err, "DELETE /api/games/:id"); }
    });

    gamesRoutes.post("/games/:id/restore", async (c) => {
      const ctx = getAuditContext(c);
      try {
        await restoreGame(c.var.userId, c.req.param("id"), ctx.ipAddress);
        return c.body(null, 204);
      } catch (err) { return mapErr(c, err, "POST /api/games/:id/restore"); }
    });
    ```

    **B. `src/lib/server/http/routes/game-listings.ts`**: routes for `POST /api/games/:gameId/listings` (zod: `{appId: number, label?: string}`), `GET /api/games/:gameId/listings`, `DELETE /api/games/:gameId/listings/:listingId`, `PATCH /api/games/:gameId/listings/:listingId/key` body `{apiKeyId: string|null}`. Service calls: addSteamListing, listListings, removeSteamListing, attachKeyToListing. DTO: toGameSteamListingDto.

    **C. `src/lib/server/http/routes/youtube-channels.ts`**: routes for `GET /api/youtube-channels`, `POST /api/youtube-channels` (zod: `{handleUrl: z.string().url(), isOwn: z.boolean().optional(), displayName: z.string().optional()}`), `PATCH /api/youtube-channels/:id` body `{isOwn: boolean}`, `DELETE /api/youtube-channels/:id`, `POST /api/games/:gameId/youtube-channels` body `{channelId: string}` (attach), `DELETE /api/games/:gameId/youtube-channels/:channelId` (detach), `GET /api/games/:gameId/youtube-channels`. DTO: toYoutubeChannelDto.

    **D. `src/lib/server/http/routes/api-keys-steam.ts`**:
    ```typescript
    const createKeySchema = z.object({ label: z.string().min(1).max(100), plaintext: z.string().min(1).max(2000) });
    const rotateKeySchema = z.object({ plaintext: z.string().min(1).max(2000) });

    // POST /api/api-keys/steam → 201 + ApiKeySteamDto
    // GET /api/api-keys/steam → list (DTO array, never ciphertext)
    // GET /api/api-keys/steam/:id
    // PATCH /api/api-keys/steam/:id → rotate
    // DELETE /api/api-keys/steam/:id
    ```
    Every response uses `toApiKeySteamDto`. PATCH calls `rotateSteamKey` not a generic update — D-14 multi-key Replace flow maps PATCH on `/api/api-keys/steam/:id` to a per-row rotate (the user picks WHICH row to replace). POST is the only path that creates new rows.

    **B-3 / D-13 cardinality contract:** the `mapErr` block above already maps `AppError.code` to the response body, so when `createSteamKey` throws `new AppError(..., 'steam_key_label_exists', 422)` (per Plan 02-05 B-3 pre-check), the route layer returns `{error: "steam_key_label_exists"}` with status 422 automatically — no per-route mapping table needed. The Plan 02-09a/09b paraglide layer surfaces this as a Plan 02-10 `<InlineError>` keyed on `m.keys_steam_error_label_exists()` (added to messages/en.json by Plan 02-09a).

    **E. `src/lib/server/http/routes/items-youtube.ts`**:
    ```typescript
    const pasteSchema = z.object({ gameId: z.string().min(1), urlInput: z.string().min(1).max(2000) });
    const toggleOwnSchema = z.object({ isOwn: z.boolean() });

    // POST /api/items/youtube — orchestrator (D-18 paste-box server endpoint)
    itemsYoutubeRoutes.post("/items/youtube", zValidator("json", pasteSchema, ...), async (c) => {
      const ctx = getAuditContext(c);
      const { gameId, urlInput } = c.req.valid("json");
      try {
        const result = await parsePasteAndCreate(ctx.userId, gameId, urlInput, ctx.ipAddress);
        if (result.kind === "reddit_deferred") return c.json({ kind: "reddit_deferred" }, 200);
        if (result.kind === "youtube_video_created") {
          const item = await getItemById(ctx.userId, result.itemId);
          return c.json({ kind: "youtube_video_created", item: toYoutubeVideoDto(item) }, 201);
        }
        if (result.kind === "event_created") {
          const ev = await getEventById(ctx.userId, result.eventId);
          return c.json({ kind: "event_created", event: toEventDto(ev) }, 201);
        }
      } catch (err) { return mapErr(c, err, "POST /api/items/youtube"); }
    });

    // GET /api/games/:gameId/items
    // PATCH /api/items/youtube/:id (toggle is_own)
    // DELETE /api/items/youtube/:id
    ```

    **F. `src/lib/server/http/routes/events.ts`**:
    ```typescript
    const createEventSchema = z.object({
      gameId: z.string().min(1),
      kind: z.enum(["conference", "talk", "twitter_post", "telegram_post", "discord_drop", "press", "other"]),
      occurredAt: z.string().datetime(),
      title: z.string().min(1).max(500),
      url: z.string().url().nullable().optional(),
      notes: z.string().max(5000).nullable().optional(),
    });
    const updateEventSchema = createEventSchema.partial().omit({ gameId: true });

    // POST /api/events
    // GET /api/events/:id
    // PATCH /api/events/:id
    // DELETE /api/events/:id
    // GET /api/games/:gameId/events
    // GET /api/games/:gameId/timeline (events + items merged)
    ```

    **G. `src/lib/server/http/routes/audit.ts`** (verbatim from RESEARCH.md §"8. Audit list endpoint" lines 1340–1354 with one validation step added):
    ```typescript
    const ACTION_FILTER_VALUES = ["all", ...AUDIT_ACTIONS] as const;
    const auditQuerySchema = z.object({
      cursor: z.string().optional(),
      action: z.enum(ACTION_FILTER_VALUES).optional(),
    });

    auditRoutes.get("/audit", zValidator("query", auditQuerySchema, (r, c) => {
      if (!r.success) return c.json({ error: "validation_failed", details: r.error.issues }, 422);
    }), async (c) => {
      const userId = c.var.userId;
      const { cursor, action } = c.req.valid("query");
      try {
        const page = await listAuditPage(userId, cursor ?? null, action ?? "all");
        return c.json({ rows: page.rows.map(toAuditEntryDto), nextCursor: page.nextCursor });
      } catch (err) { return mapErr(c, err, "GET /api/audit"); }
    });
    ```

    **H. `src/lib/server/http/routes/me-theme.ts`** (UX-01 server side):

    CRITICAL — env discipline (CLAUDE.md / AGENTS.md hard rule): `process.env` MUST NOT be
    referenced from any route file. The `Secure` flag derivation reads `env.NODE_ENV` from
    `src/lib/server/config/env.ts` (the SOLE reader of `process.env`; see Phase 1 plan 01-01).
    `NODE_ENV` is already exported by `env.ts` (zod schema line: `NODE_ENV: z.enum(["development","production","test"]).default("development")`); no env-schema change is required for this plan.

    ```typescript
    import { env } from "$lib/server/config/env";   // REQUIRED — do NOT read process.env directly.

    const themeSchema = z.object({ theme: z.enum(["light", "dark", "system"]) });

    meThemeRoutes.post("/me/theme", zValidator("json", themeSchema, ...), async (c) => {
      const ctx = getAuditContext(c);
      const { theme } = c.req.valid("json");
      try {
        const result = await updateUserTheme(ctx.userId, theme, ctx.ipAddress);
        // Set cookie — Path=/; SameSite=Lax; Max-Age=1y; NO HttpOnly (UI-SPEC + Pitfall 5).
        // Secure flag is derived from env.NODE_ENV (the canonical alias is "$lib/server/config/env";
        // verify the alias exists in svelte.config.js / tsconfig before pushing — Phase 1 uses
        // "$lib/server/config/env"; if a different alias is canonical in this repo, swap to that).
        const secureFlag = env.NODE_ENV === "production" ? "; Secure" : "";
        c.header("set-cookie", `__theme=${theme}; Path=/; SameSite=Lax; Max-Age=31536000${secureFlag}`);
        return c.json({ theme: result.theme, from: result.from }, 200);
      } catch (err) { return mapErr(c, err, "POST /api/me/theme"); }
    });
    ```

    Acceptance (lint hard-gate):
    - `grep -n "process\.env" src/lib/server/http/routes/me-theme.ts` returns NO matches.
    - `grep -nE 'from "\$lib/server/config/env"' src/lib/server/http/routes/me-theme.ts` returns exactly ONE import line.
    - `pnpm exec eslint src/lib/server/http/routes/me-theme.ts` exits 0 (the existing `no-restricted-properties` rule on `process.env` does NOT fire).

    Belt + suspenders: any other inline route snippet in this plan that references `process.env.*` is a
    pre-merge defect — search the plan body and replace with `env.*` from `$lib/server/config/env`. The
    only legitimate `process.env` reads in the entire codebase remain those inside `src/lib/server/config/env.ts`.

    **I. EXTEND `src/lib/server/services/me.ts`** — add `updateUserTheme`:
    ```typescript
    export async function updateUserTheme(
      userId: string,
      newTheme: "light" | "dark" | "system",
      ipAddress: string,
    ): Promise<{ theme: string; from: string }> {
      // Read current theme to capture `from` for audit metadata.
      const [row] = await db.select({ themePreference: user.themePreference }).from(user).where(eq(user.id, userId)).limit(1);
      if (!row) throw new NotFoundError();
      const fromTheme = row.themePreference;
      await db.update(user).set({ themePreference: newTheme, updatedAt: new Date() }).where(eq(user.id, userId));
      await writeAudit({ userId, action: "theme.changed", ipAddress, metadata: { from: fromTheme, to: newTheme } });
      return { theme: newTheme, from: fromTheme };
    }
    ```

    Note: `user` is a Better Auth allowlisted table — the ESLint tenant-scope rule does NOT fire on it, but the WHERE clause MUST still scope by `userId` (this is the actual session user, not arbitrary).

    **J. AMEND `src/lib/server/http/app.ts`** — mount the 8 new routers. Add imports + after the existing `app.route("/api", sessionRoutes);` line:

    ```typescript
    app.route("/api", gamesRoutes);
    app.route("/api", gameListingsRoutes);
    app.route("/api", youtubeChannelsRoutes);
    app.route("/api", apiKeysSteamRoutes);
    app.route("/api", itemsYoutubeRoutes);
    app.route("/api", eventsRoutes);
    app.route("/api", auditRoutes);
    app.route("/api", meThemeRoutes);
    ```

    Order matters minimally: the more-specific game-listings / game-youtube-channels paths go AFTER bare `gamesRoutes` so Hono's path-matching doesn't shadow.
  </action>
  <verify>
    <automated>pnpm exec tsc --noEmit 2>&1 | tail -10 && pnpm exec eslint src/lib/server/http/routes/ 2>&1 | tail -10</automated>
  </verify>
  <done>
    8 new route files compile and lint clean. app.ts imports + mounts them all. `services/me.ts` exports `updateUserTheme`. Every route handler uses `mapErr` for unified error translation. Every request body / query is zod-validated; every response goes through a `to<Entity>Dto` projection.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Extend anonymous-401 + tenant-scope sweeps; live cross-tenant write/delete tests; cross-cutting log-redact integration test</name>
  <files>tests/integration/anonymous-401.test.ts, tests/integration/tenant-scope.test.ts, tests/integration/log-redact.test.ts</files>
  <read_first>
    - tests/integration/anonymous-401.test.ts (Phase 1 — `MUST_BE_PROTECTED` + vacuous-pass guards; extend by adding the 14 D-37 routes to the array)
    - tests/integration/tenant-scope.test.ts (Phase 1 — has 2 it.skip stubs flagged "deferred to Phase 2: no writable/deletable resource in Phase 1"; this plan flips them to live tests against /api/games)
    - tests/integration/log-redact.test.ts (placeholder file from Plan 02-01 — has 1 it.skip stub `02-08: ...ciphertext field names never logged...`)
    - src/lib/server/logger.ts (Pino redact paths from Phase 1; Phase 2 introduces no new field names but we verify the existing redaction holds when ciphertext is logged accidentally)
    - tests/integration/helpers.ts (seedUserDirectly + signedSessionCookieValue)
    - .planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md `<decisions>` D-37 (the route matrix)
  </read_first>
  <action>
    **A. EXTEND `tests/integration/anonymous-401.test.ts`** — replace the `MUST_BE_PROTECTED` array contents:

    ```typescript
    const MUST_BE_PROTECTED = [
      "/api/me",                                // Phase 1
      "/api/me/sessions/all",                    // Phase 1
      "/api/me/theme",                            // Phase 2 (Plan 08; UX-01)
      "/api/games",                                // Phase 2
      "/api/games/:id",
      "/api/games/:id/restore",
      "/api/games/:gameId/listings",
      "/api/games/:gameId/listings/:listingId",
      "/api/games/:gameId/listings/:listingId/key",
      "/api/games/:gameId/youtube-channels",
      "/api/games/:gameId/youtube-channels/:channelId",
      "/api/youtube-channels",
      "/api/youtube-channels/:id",
      "/api/api-keys/steam",
      "/api/api-keys/steam/:id",
      "/api/items/youtube",
      "/api/items/youtube/:id",
      "/api/games/:gameId/items",
      "/api/events",
      "/api/events/:id",
      "/api/games/:gameId/events",
      "/api/games/:gameId/timeline",
      "/api/audit",
    ];
    ```

    The existing sweep loop already iterates and asserts 401 on each. The vacuous-pass guard (`expect(protectedPaths).toContain(required)`) ensures the exact route patterns the Hono app registered match this list — drift between this list and the actual mounts trips the test.

    **B. EXTEND `tests/integration/tenant-scope.test.ts`** — flip the two Phase 1 deferred stubs to live tests + add a matrix sweep:

    Replace the two `it.skip(...)` stubs from Phase 1 lines 53–60:

    ```typescript
    it("user A cannot WRITE user B resource — returns 404 (Phase 2 GAMES-01 turns this on)", async () => {
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const app = createApp();
      const userA = await seedUserDirectly({ email: "wA@test.local" });
      const userB = await seedUserDirectly({ email: "wB@test.local" });
      const created = await createGame(userA.id, { title: "A's Game" }, "127.0.0.1");
      // user B PATCHes user A's game id — must be 404, not 403, and not a successful write.
      const res = await app.request(`/api/games/${created.id}`, {
        method: "PATCH",
        headers: {
          cookie: `neotolis.session_token=${userB.signedSessionCookieValue}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "B HACKED" }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ error: "not_found" });
      // Verify A's game is unchanged
      const after = await getGameById(userA.id, created.id);
      expect(after.title).toBe("A's Game");
    });

    it("user A cannot DELETE user B resource — returns 404", async () => {
      const { createApp } = await import("../../src/lib/server/http/app.js");
      const app = createApp();
      const userA = await seedUserDirectly({ email: "dA@test.local" });
      const userB = await seedUserDirectly({ email: "dB@test.local" });
      const created = await createGame(userA.id, { title: "A's Game" }, "127.0.0.1");
      const res = await app.request(`/api/games/${created.id}`, {
        method: "DELETE",
        headers: { cookie: `neotolis.session_token=${userB.signedSessionCookieValue}` },
      });
      expect(res.status).toBe(404);
      // Verify A's game is NOT soft-deleted
      const after = await getGameById(userA.id, created.id);
      expect(after.deletedAt).toBeNull();
    });
    ```

    Add a NEW describe block `Phase 2 cross-tenant matrix (D-37)` that loops the 14 routes:

    ```typescript
    describe("Phase 2 cross-tenant matrix (D-37)", () => {
      const READ_ROUTES = [
        // Format: { path, method, expectedStatus, prepFn? }
        // Each test seeds A, then B requests with a SENTINEL ID (`fixture-id`) and expects 404.
        // (For routes that depend on a real id, we use a row that exists for A and probe by A's id.)
      ];
      it("user B GET on user A's resource returns 404 (not 403, not 200)", async () => {
        const { createApp } = await import("../../src/lib/server/http/app.js");
        const app = createApp();
        const userA = await seedUserDirectly({ email: "mA@test.local" });
        const userB = await seedUserDirectly({ email: "mB@test.local" });
        const game = await createGame(userA.id, { title: "A" }, "127.0.0.1");
        // Seeds: A has game G; A has key K; A has channel C; A has event E; A has audit row R.
        // B requests each by id → 404.
        const probes = [
          { method: "GET", path: `/api/games/${game.id}` },
          { method: "PATCH", path: `/api/games/${game.id}`, body: { title: "X" } },
          { method: "DELETE", path: `/api/games/${game.id}` },
          { method: "POST", path: `/api/games/${game.id}/restore` },
          // Add the rest of the route matrix; planner picks how to seed each child entity.
        ];
        for (const p of probes) {
          const init: RequestInit = {
            method: p.method,
            headers: {
              cookie: `neotolis.session_token=${userB.signedSessionCookieValue}`,
              "content-type": "application/json",
            },
          };
          if (p.body) (init as any).body = JSON.stringify(p.body);
          const res = await app.request(p.path, init);
          expect.soft(res.status, `${p.method} ${p.path} should be 404 cross-tenant`).toBe(404);
          const txt = await res.text();
          expect.soft(txt, `${p.method} ${p.path} body must not contain 'forbidden' or 'permission'`).not.toMatch(/forbidden|permission/i);
        }
      });
    });
    ```

    The planner / executor extends the `probes` array to cover every D-37 route. The `expect.soft` allows the test to surface ALL violations in one run rather than failing on the first.

    **C. `tests/integration/log-redact.test.ts`** — flip the 1 it.skip stub:

    ```typescript
    import { describe, it, expect, vi } from "vitest";
    import { writeAudit } from "../../src/lib/server/audit.js";
    import { logger } from "../../src/lib/server/logger.js";
    import { createSteamKey } from "../../src/lib/server/services/api-keys-steam.js";
    import * as SteamApi from "../../src/lib/server/integrations/steam-api.js";
    import { seedUserDirectly } from "./helpers.js";

    describe("cross-cutting Pino redact (P3 + D-24)", () => {
      it("02-08: cross-cutting Pino redact — ciphertext field names never logged during request flow", async () => {
        // Capture logger output by spying on stdout.write or by attaching a stream — Phase 1
        // logger uses pino with a stream output. The simplest mock: spy on logger.info / .warn / .error / .debug.
        const captured: string[] = [];
        const originalInfo = logger.info.bind(logger);
        const originalWarn = logger.warn.bind(logger);
        const originalError = logger.error.bind(logger);
        const originalDebug = logger.debug.bind(logger);
        const wrap = (fn: typeof logger.info) => (...args: unknown[]) => { captured.push(JSON.stringify(args)); return (fn as any)(...args); };
        logger.info = wrap(originalInfo) as any;
        logger.warn = wrap(originalWarn) as any;
        logger.error = wrap(originalError) as any;
        logger.debug = wrap(originalDebug) as any;
        try {
          vi.spyOn(SteamApi, "validateSteamKey").mockResolvedValue(true);
          const u = await seedUserDirectly({ email: "lr@test.local" });
          const PLAIN = "STEAM-LOG-REDACT-TEST-XYZW";
          await createSteamKey(u.id, { label: "L", plaintext: PLAIN }, "127.0.0.1");
          // The audit writer also runs.
          await writeAudit({ userId: u.id, action: "session.signin", ipAddress: "127.0.0.1" });

          const all = captured.join("\n");
          // Plaintext MUST NOT appear in any logged line.
          expect(all).not.toContain(PLAIN);
          // Ciphertext field names that ARE in Pino redact paths should appear as [Redacted] or be absent entirely.
          const ciphertextNames = ["secret_ct", "secretCt", "wrapped_dek", "wrappedDek", "kekVersion", "kek_version"];
          for (const name of ciphertextNames) {
            // It's OK for the name to appear (e.g. in a "redacted" placeholder); the IMPORTANT thing is that the ASSOCIATED VALUE doesn't appear.
            // We assert no Buffer-shaped base64 strings are in the log (proxy for ciphertext bytes leaking).
            // This is a coarse check; tightening is Phase 6 polish.
            expect(all.match(new RegExp(`"${name}":"[A-Za-z0-9+/=]+"`, "g"))?.length ?? 0).toBe(0);
          }
        } finally {
          logger.info = originalInfo;
          logger.warn = originalWarn;
          logger.error = originalError;
          logger.debug = originalDebug;
        }
      });
    });
    ```
  </action>
  <verify>
    <automated>pnpm test:integration tests/integration/anonymous-401.test.ts tests/integration/tenant-scope.test.ts tests/integration/log-redact.test.ts --reporter=verbose 2>&1 | tail -40</automated>
  </verify>
  <done>
    - `MUST_BE_PROTECTED` extends to all 14 D-37 routes; the vacuous-pass guard asserts every required path appears in the swept set.
    - Phase 1's two deferred `it.skip` stubs (cross-tenant write + delete) are now live `it(...)` against `/api/games` and pass.
    - The new cross-tenant matrix `describe` exercises every D-37 route and asserts 404 + body free of "forbidden"/"permission".
    - `tests/integration/log-redact.test.ts` runs and verifies neither the steam-key plaintext nor base64-shaped ciphertext bytes appear in any captured logger line.
  </done>
</task>

</tasks>

<verification>
- `pnpm test:integration tests/integration/anonymous-401.test.ts tests/integration/tenant-scope.test.ts tests/integration/log-redact.test.ts` is green.
- `pnpm test:integration` (full integration suite) is green — every Wave 1 placeholder test (Plans 04..07) still passes after routes mount.
- `grep -c "/api/games" tests/integration/anonymous-401.test.ts` >= 5 (the route patterns).
- `grep -c "MUST_BE_PROTECTED" tests/integration/anonymous-401.test.ts` >= 2 (definition + assertion).
- `grep -c "app.route(\"/api\"" src/lib/server/http/app.ts` >= 10 (Phase 1's 2 + Phase 2's 8).
</verification>

<success_criteria>
- 8 new sub-routers mounted under `/api/*`; every route inherits tenantScope.
- Every Phase 2 service is reachable via at least one HTTP route; every response goes through a DTO projection.
- POST /api/me/theme returns the new theme + sets `__theme` cookie WITHOUT HttpOnly (Pitfall 5) + writes audit.
- Anonymous-401 sweep covers all 14 D-37 routes; vacuous-pass guard asserts the required-routes list matches what's mounted.
- Cross-tenant matrix exercises every route (read + write + delete) with user B's cookie on user A's id and asserts 404 + body free of "forbidden"/"permission".
- Phase 1's deferred VALIDATION 8/9 stubs are live and green.
- log-redact integration test verifies no plaintext / base64-shaped ciphertext bytes leak through Pino.
- Error mapping is uniform: NotFoundError → 404, AppError → status, ZodError → 422, unhandled → 500.
</success_criteria>

<output>
After completion, create `.planning/phases/02-ingest-secrets-and-audit/02-08-SUMMARY.md`. Highlight: the final MUST_BE_PROTECTED list (verbatim), the cross-tenant matrix coverage (which routes were probed in the sweep), confirmation that Phase 1's two deferred stubs are now live, and any error-mapping deviations from the canonical mapErr pattern.
</output>
