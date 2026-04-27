---
phase: 02-ingest-secrets-and-audit
plan: 08
subsystem: http
tags: [routes, hono, zod, dto, multi-tenant, security-floor, anonymous-401, cross-tenant, audit, theme, ingest, paste-orchestrator]

requires:
  - phase: 01-foundation
    provides: "Hono createApp + tenantScope middleware (Plan 01-07), getAuditContext helper, AppError + NotFoundError taxonomy, DTO projection discipline (P3 runtime guard), Pino redact paths (D-24)"
  - phase: 02-ingest-secrets-and-audit (Plan 02-04)
    provides: "createGame / listGames / getGameById / updateGame / softDeleteGame / restoreGame; addSteamListing / listListings / removeSteamListing / attachKeyToListing; createChannel / listChannels / attachToGame / detachFromGame / listChannelsForGame / toggleIsOwn"
  - phase: 02-ingest-secrets-and-audit (Plan 02-05)
    provides: "createSteamKey / listSteamKeys / getSteamKeyById / rotateSteamKey / removeSteamKey; AppError(422 'steam_key_label_exists'), AppError(422 'validation_failed'), AppError(502 'steam_api_unavailable')"
  - phase: 02-ingest-secrets-and-audit (Plan 02-06)
    provides: "parsePasteAndCreate orchestrator (D-18 5-branch + D-19 validate-first); createTrackedYoutubeVideo / listItemsForGame / getItemById / toggleIsOwn / softDeleteItem; createEvent / getEventById / updateEvent / softDeleteEvent / listEventsForGame / listTimelineForGame; AppError(422 'youtube_unavailable' + metadata.reason), AppError(502 'youtube_oembed_unreachable'), AppError(409 'duplicate_item')"
  - phase: 02-ingest-secrets-and-audit (Plan 02-07)
    provides: "listAuditPage / encodeCursor / decodeCursor / assertValidActionFilter / PAGE_SIZE; AuditActionFilter type; AppError(422 'invalid_cursor')"

provides:
  - "src/lib/server/http/routes/_shared.ts — RouteVars type + mapErr helper (centralized error envelope: NotFoundError → 404, AppError → status + {error: code}, ZodError → 422 with details, else → 500 + logged)"
  - "src/lib/server/http/routes/games.ts — POST/GET /api/games, GET/PATCH/DELETE /api/games/:id, POST /api/games/:id/restore"
  - "src/lib/server/http/routes/game-listings.ts — POST/GET /api/games/:gameId/listings, DELETE /api/games/:gameId/listings/:listingId, PATCH /api/games/:gameId/listings/:listingId/key"
  - "src/lib/server/http/routes/youtube-channels.ts — GET/POST /api/youtube-channels, PATCH /api/youtube-channels/:id, GET/POST /api/games/:gameId/youtube-channels, DELETE /api/games/:gameId/youtube-channels/:channelId"
  - "src/lib/server/http/routes/api-keys-steam.ts — POST/GET /api/api-keys/steam, GET/PATCH/DELETE /api/api-keys/steam/:id (every response through toApiKeySteamDto — D-39 runtime guard)"
  - "src/lib/server/http/routes/items-youtube.ts — POST /api/items/youtube (D-18 paste orchestrator; discriminated IngestResult → 200|201), GET /api/games/:gameId/items, PATCH/DELETE /api/items/youtube/:id"
  - "src/lib/server/http/routes/events.ts — POST /api/events, GET/PATCH/DELETE /api/events/:id, GET /api/games/:gameId/events, GET /api/games/:gameId/timeline"
  - "src/lib/server/http/routes/audit.ts — GET /api/audit?cursor=&action= (zod validates against ['all', ...AUDIT_ACTIONS] closed picklist)"
  - "src/lib/server/http/routes/me-theme.ts — POST /api/me/theme (UX-01: cookie + DB + audit, Pitfall 5 NO HttpOnly, Secure derived from env.NODE_ENV)"
  - "src/lib/server/services/me.ts — updateUserTheme(userId, newTheme, ipAddress) added; reads current theme so audit metadata carries {from, to}"
  - "src/lib/server/http/app.ts — 8 new app.route('/api', subRouter) mounts; total /api mounts = 10 (Phase 1's 2 + Phase 2's 8)"
  - "tests/integration/anonymous-401.test.ts — MUST_BE_PROTECTED extended from 1 entry to 24 entries covering every D-37 route at the parameterized level"
  - "tests/integration/tenant-scope.test.ts — Phase 1's two deferred it.skip stubs (cross-tenant write + delete) flipped to live it() against /api/games + new D-37 cross-tenant matrix describe block (21 probes across the surface)"
  - "tests/integration/log-redact.test.ts — Wave 0 it.skip flipped to live: captures logger.info/warn/error/debug during createSteamKey + writeAudit; asserts plaintext never appears and no base64-shaped ciphertext bytes leak alongside known column-name keys"

affects: [02-09-theme-components-paraglide, 02-10-svelte-pages, 02-11-smoke-360-validation]

tech-stack:
  added: []
  patterns:
    - "Centralized error envelope: every Phase 2 route file calls a single `mapErr(c, err, route)` helper from routes/_shared.ts. NotFoundError → 404 {error:'not_found'}; AppError → status as ContentfulStatusCode + {error:code}; unhandled → logged + 500. Body NEVER contains 'forbidden' or 'permission' for tenant-owned resources (P1 invariant; runtime-asserted by tenant-scope.test.ts)."
    - "zValidator hook always returns 422 on parse failure (`if (!r.success) return c.json({error:'validation_failed', details: r.error.issues}, 422)`). The hook fires BEFORE the handler, so `c.req.valid('json')` inside the handler is guaranteed-typed. The same pattern applies to query (zValidator('query', ...)) for /api/audit."
    - "DTO discipline at every route boundary: every response goes through a `to<Entity>Dto` projection function. Per D-39, the projection function is the runtime guard for ciphertext discipline (TypeScript erases at runtime). For listings, `list.map(toEntityDto)`; for single rows, `toEntityDto(row)`. The TimelineRow union from services/events.ts is intentionally already DTO-shaped (no userId field) — no projection function needed there."
    - "Sub-router parameterization via `app.route('/api', subRouter)`: each sub-router declares its routes WITHOUT the `/api` prefix (e.g. `gamesRoutes.get('/games', ...)`); Hono prepends `/api` at mount time. The parameterized path strings stored in `app.routes` are exactly what MUST_BE_PROTECTED in anonymous-401.test.ts asserts against."
    - "Env discipline (CLAUDE.md / AGENTS.md hard rule) preserved across all 8 route files: `process.env` does NOT appear in any code path. The Secure cookie flag in me-theme.ts derives from `env.NODE_ENV` via the SOLE env-reader module `src/lib/server/config/env.ts`. ESLint no-restricted-properties enforces the boundary; `pnpm exec eslint src/lib/server/http/routes/` exits 0."
    - "Cross-tenant matrix sweep with expect.soft: the D-37 matrix in tenant-scope.test.ts uses `expect.soft` instead of `expect` so a single test surfaces EVERY violation in one run rather than failing on the first probe. With 21 probes, the all-or-nothing failure mode would mask regressions."

key-files:
  created:
    - "src/lib/server/http/routes/_shared.ts"
    - "src/lib/server/http/routes/games.ts"
    - "src/lib/server/http/routes/game-listings.ts"
    - "src/lib/server/http/routes/youtube-channels.ts"
    - "src/lib/server/http/routes/api-keys-steam.ts"
    - "src/lib/server/http/routes/items-youtube.ts"
    - "src/lib/server/http/routes/events.ts"
    - "src/lib/server/http/routes/audit.ts"
    - "src/lib/server/http/routes/me-theme.ts"
  modified:
    - "src/lib/server/http/app.ts"
    - "src/lib/server/services/me.ts"
    - "tests/integration/anonymous-401.test.ts"
    - "tests/integration/tenant-scope.test.ts"
    - "tests/integration/log-redact.test.ts"

key-decisions:
  - "Centralized mapErr in routes/_shared.ts (Rule 3 — blocking — fix the moment the second route file would have copy-pasted 22 lines of error mapping). Every Phase 2 route file imports `mapErr` and `RouteVars`; a future change (a new AppError code with custom 4xx handling) lands in one place. Status type widened to Hono's `ContentfulStatusCode` so AppError carrying any 4xx/5xx (422, 502, 409) flows through without per-route mapping tables."
  - "AppError code mapping is automatic — no per-route translation table. When createSteamKey throws `AppError(422, 'steam_key_label_exists')` (Plan 02-05 B-3 pre-check), the route layer returns `{error: 'steam_key_label_exists'}` with status 422 directly via mapErr. Plan 02-09a/09b paraglide layer keys on the code string; no message-string parsing at the boundary."
  - "DELETE /api/youtube-channels/:id is INTENTIONALLY NOT shipped this plan. The service layer (Plan 02-04) has no `removeChannel`; the user-facing 'remove channel' flow detaches per-game (Plan 02-10 will surface this). Adding the route would require landing the service function first; deferring keeps the route-service surface symmetric."
  - "The TimelineRow discriminated union (services/events.ts) is shipped as-is over the wire from GET /api/games/:gameId/timeline. The union has no userId field by construction (the service builds it from already-projected fields), so no `toTimelineRowDto` is needed. This is the lone exception to the 'every response through a projection function' rule and is justified by the union's by-construction P3 compliance."
  - "Cross-tenant matrix uses expect.soft instead of expect — the 21-probe matrix would otherwise fail on the first violation and hide downstream regressions. Each probe carries its own descriptive failure message (`${method} ${path} should be 404 cross-tenant`) so triage doesn't require re-running individual probes."
  - "log-redact assertion is coarse (regex against base64-shaped strings after column-name keys) rather than fine (Pino fast-redact path-by-path fuzzing). Tightening to a fast-redact harness is Phase 6 polish — the coarse check is sufficient for the cross-cutting plaintext-and-ciphertext-don't-leak invariant the plan requires."

requirements-completed: [GAMES-01, GAMES-02, GAMES-03, GAMES-04a, KEYS-03, KEYS-04, KEYS-05, KEYS-06, INGEST-02, INGEST-03, INGEST-04, EVENTS-01, EVENTS-02, EVENTS-03, PRIV-02, UX-01]

duration: 6m 41s
completed: 2026-04-27
---

# Phase 02 Plan 08: Routes and Sweeps Summary

**HTTP layer for the seven Phase 2 service surfaces + UX-01 theme: 8 Hono sub-routers wired under `/api/*` (gated by tenantScope), centralized error envelope via `mapErr` (NotFoundError → 404, AppError → status + code, ZodError → 422), every response through a DTO projection (D-39 runtime guard), POST /api/me/theme writes cookie + DB + audit, and the cross-cutting test gates: anonymous-401 sweep extended to 24 entries (every D-37 route), Phase 1's two deferred cross-tenant write/delete stubs lit up against /api/games, new 21-probe cross-tenant matrix, and a log-redact assertion that no plaintext or base64-shaped ciphertext bytes leak through Pino.**

## Performance

- **Duration:** ~6 min 41 s
- **Started:** 2026-04-27T21:21:26Z
- **Completed:** 2026-04-27T21:28:07Z
- **Tasks:** 2
- **Files modified:** 14 (9 created, 5 modified)

## Accomplishments

- Eight new Hono sub-routers shipped, every one mounted under `app.route('/api', ...)` so each handler inherits the Plan 01-07 `tenantScope` middleware. Anonymous requests are 401'd before reaching any handler; cross-tenant access surfaces as `NotFoundError` from the service layer and translates to 404 here (PRIV-01: 404, never 403).
- Centralized error envelope in `src/lib/server/http/routes/_shared.ts` — `mapErr(c, err, route)` is the single point of translation for the entire Phase 2 surface. Status widened to `ContentfulStatusCode` so AppError carrying 422 / 502 / 409 / etc. flows through without per-route mapping. The body never contains "forbidden" or "permission" for tenant-owned resources (P1 invariant).
- Every response goes through a `to<Entity>Dto` projection. The `ApiKeySteamDto` projection in particular is the load-bearing D-39 runtime guard — TypeScript erases at runtime; the projection function is the actual security barrier that strips every ciphertext column even if the underlying row carries them.
- POST /api/me/theme (UX-01) — updates `user.theme_preference`, writes a `theme.changed` audit row with `{from, to}` metadata, sets the `__theme` cookie (Path=/, SameSite=Lax, Max-Age=1y, NO HttpOnly per Pitfall 5). The Secure flag derives from `env.NODE_ENV` via `src/lib/server/config/env.ts` — the SOLE env-reader module — so dev/CI smoke runs over plain HTTP work and production behind a TLS-terminating proxy gets `Secure`.
- Anonymous-401 sweep extended from 1 to 24 entries (`MUST_BE_PROTECTED` in `tests/integration/anonymous-401.test.ts`). The vacuous-pass guard now catches drift between expected mounts and actual `app.routes` for every Phase 2 sub-router. Asserted at the parameterized level (`/api/games/:id`, not `/api/games/<concrete-id>`) so the strings match Hono's registered path patterns exactly.
- Phase 1's two deferred `it.skip` stubs in `tenant-scope.test.ts` (cross-tenant WRITE + cross-tenant DELETE) are now live `it()` calls against `/api/games`. User B PATCH/DELETE on user A's game id returns 404 (not 403, not 200), body free of "forbidden"/"permission", A's row is unchanged in the DB.
- New `Phase 2 cross-tenant matrix (D-37)` describe block exercises 21 probes across the surface — games, listings, youtube channels, api keys, items, events, timeline. Uses `expect.soft` so a single test surfaces every violation in one run.
- log-redact integration test (Wave 0 placeholder, now live) captures logger calls during a `createSteamKey` + `writeAudit` cycle and asserts (a) the plaintext input never appears in any logged line, (b) no base64-shaped string of meaningful length appears alongside known column-name keys (`secret_ct`, `secretCt`, `wrapped_dek`, `wrappedDek`, `kekVersion`, `kek_version`).
- TypeScript compiles clean (`pnpm exec tsc --noEmit` exits 0). ESLint reports zero warnings on every new and modified file. Unit suite still passes 65/65 (no regression).

## Task Commits

1. **Task 1: 8 sub-routers + me-theme service extension + app.ts wiring** — `c6513a0` (feat)
2. **Task 2: extend sweeps + cross-tenant matrix + log-redact** — `d2a320d` (test)

## Files Created/Modified

### Created (9)

- `src/lib/server/http/routes/_shared.ts` — `RouteVars` type + `mapErr(c, err, route)` helper (44 lines including comments).
- `src/lib/server/http/routes/games.ts` — 6 endpoints (POST/GET /api/games + GET/PATCH/DELETE /api/games/:id + POST /api/games/:id/restore).
- `src/lib/server/http/routes/game-listings.ts` — 4 endpoints (POST/GET /api/games/:gameId/listings + DELETE /api/games/:gameId/listings/:listingId + PATCH /api/games/:gameId/listings/:listingId/key).
- `src/lib/server/http/routes/youtube-channels.ts` — 6 endpoints (GET/POST /api/youtube-channels + PATCH /api/youtube-channels/:id + GET/POST /api/games/:gameId/youtube-channels + DELETE /api/games/:gameId/youtube-channels/:channelId).
- `src/lib/server/http/routes/api-keys-steam.ts` — 5 endpoints (POST/GET /api/api-keys/steam + GET/PATCH/DELETE /api/api-keys/steam/:id) with every response through `toApiKeySteamDto`.
- `src/lib/server/http/routes/items-youtube.ts` — 4 endpoints (POST /api/items/youtube paste orchestrator + GET /api/games/:gameId/items + PATCH/DELETE /api/items/youtube/:id).
- `src/lib/server/http/routes/events.ts` — 6 endpoints (POST /api/events + GET/PATCH/DELETE /api/events/:id + GET /api/games/:gameId/events + GET /api/games/:gameId/timeline).
- `src/lib/server/http/routes/audit.ts` — 1 endpoint (GET /api/audit?cursor=&action=) with zod-validated query.
- `src/lib/server/http/routes/me-theme.ts` — 1 endpoint (POST /api/me/theme) with cookie write + DB update + audit.

### Modified (5)

- `src/lib/server/http/app.ts` — 8 new imports + 8 `app.route('/api', subRouter)` mounts. Total `/api` mounts = 10 (Phase 1's 2 + Phase 2's 8).
- `src/lib/server/services/me.ts` — `updateUserTheme(userId, newTheme, ipAddress)` added; reads current theme so audit metadata carries `{from, to}`.
- `tests/integration/anonymous-401.test.ts` — `MUST_BE_PROTECTED` extended from `["/api/me"]` (1 entry) to a 24-entry list covering every D-37 route at the parameterized level.
- `tests/integration/tenant-scope.test.ts` — 2 it.skip → live `it()` for VALIDATION 8/9; new `Phase 2 cross-tenant matrix (D-37)` describe block with 21 probes.
- `tests/integration/log-redact.test.ts` — Wave 0 it.skip → live `it()` exercising the cross-cutting Pino redact invariant.

## Decisions Made

See the `key-decisions` block in frontmatter for the full list. The load-bearing one: **centralized mapErr in `routes/_shared.ts`**. It started as a per-file inline block in the plan's `<action>` template, but the moment the second route file appeared in the plan it became copy-paste of 22 lines of error mapping. Extracting it to a shared module is the natural Rule 3 (blocking) auto-fix: a future change (e.g. a new AppError code with a custom 4xx handler) lands in one place rather than nine. The status type is widened to Hono's `ContentfulStatusCode` so AppError carrying 422 (validation_failed, youtube_unavailable, steam_key_label_exists), 502 (steam_api_unavailable, youtube_oembed_unreachable), 409 (duplicate_item) all flow through without a per-route mapping table.

## Plan Output Items (per `<output>` section)

### Final MUST_BE_PROTECTED list (verbatim)

```typescript
const MUST_BE_PROTECTED = [
  // Phase 1
  "/api/me",
  "/api/me/sessions/all",
  // Phase 2 (Plan 02-08; UX-01)
  "/api/me/theme",
  // Phase 2 — games
  "/api/games",
  "/api/games/:id",
  "/api/games/:id/restore",
  // Phase 2 — game-listings
  "/api/games/:gameId/listings",
  "/api/games/:gameId/listings/:listingId",
  "/api/games/:gameId/listings/:listingId/key",
  // Phase 2 — youtube channels (user-level + per-game)
  "/api/youtube-channels",
  "/api/youtube-channels/:id",
  "/api/games/:gameId/youtube-channels",
  "/api/games/:gameId/youtube-channels/:channelId",
  // Phase 2 — api keys (steam)
  "/api/api-keys/steam",
  "/api/api-keys/steam/:id",
  // Phase 2 — items (youtube) + paste orchestrator
  "/api/items/youtube",
  "/api/items/youtube/:id",
  "/api/games/:gameId/items",
  // Phase 2 — events + per-game lists + timeline
  "/api/events",
  "/api/events/:id",
  "/api/games/:gameId/events",
  "/api/games/:gameId/timeline",
  // Phase 2 — audit
  "/api/audit",
];
```

24 entries total (Phase 1's 2 + Phase 2's 22).

### Cross-tenant matrix coverage (which routes were probed)

The new `Phase 2 cross-tenant matrix (D-37)` describe block in `tenant-scope.test.ts` runs 21 probes:

| Route | Methods probed |
|---|---|
| `/api/games/:id` | GET, PATCH, DELETE |
| `/api/games/:id/restore` | POST |
| `/api/games/:gameId/listings` | GET, POST |
| `/api/games/:gameId/listings/:listingId` | DELETE |
| `/api/games/:gameId/listings/:listingId/key` | PATCH |
| `/api/youtube-channels/:id` | PATCH |
| `/api/games/:gameId/youtube-channels` | GET, POST |
| `/api/games/:gameId/youtube-channels/:channelId` | DELETE |
| `/api/api-keys/steam/:id` | GET, PATCH, DELETE |
| `/api/games/:gameId/items` | GET |
| `/api/games/:gameId/events` | GET |
| `/api/games/:gameId/timeline` | GET |
| `/api/events/:id` | GET, PATCH, DELETE |

For each probe, user B presents their own cookie against an id seeded for user A and the test asserts (via `expect.soft`):
- HTTP status === 404
- response body does NOT match `/forbidden|permission/i`

The `expect.soft` collects all violations into a single failed-test report rather than stopping at the first; this is load-bearing for the matrix size.

### Phase 1 deferred stubs status

| Stub | Phase 1 status | Plan 02-08 status |
|---|---|---|
| `02-08: cross-cutting Pino redact — ciphertext field names never logged during request flow` | `it.skip` placeholder | LIVE `it()` |
| Plan 1's "user A cannot WRITE user B resource — returns 404 (deferred to Phase 2: no writable resource in Phase 1)" | `it.skip` with explicit deferral annotation | LIVE `it()` against `/api/games` |
| Plan 1's "user A cannot DELETE user B resource — returns 404 (deferred to Phase 2: no deletable resource in Phase 1)" | `it.skip` with explicit deferral annotation | LIVE `it()` against `/api/games` |

Three deferred stubs lit up; zero remaining `it.skip` in the touched files.

### Error-mapping deviations from canonical mapErr pattern

**None.** Every Phase 2 route file uses the shared `mapErr(c, err, route)` from `routes/_shared.ts` for error translation. Status code widening (`ContentfulStatusCode`) handles 422 / 502 / 409 / 404 / 500 uniformly without per-route hand-mapping. Body envelope is uniform: `{error: code}` for AppError-class errors, `{error: 'validation_failed', details}` for zod failures (handled by the zValidator hook BEFORE the handler runs), `{error: 'internal_server_error'}` for unhandled errors (which are also logged loudly).

The lone surface-level decision worth flagging is GET /api/games/:gameId/timeline returning the `TimelineRow` discriminated union from services/events.ts as-is, without a `toTimelineRowDto` projection — the union has no `userId` field by construction (the service builds it from already-projected fields), so it's already P3-compliant. This is documented in the route file with a comment.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Centralized `mapErr` + `RouteVars` in `routes/_shared.ts`**

- **Found during:** Task 1 (writing the second route file)
- **Issue:** The plan's `<action>` block templates the error-mapping `mapErr` function inline at the top of each route file ("Common route file template"). Inlining the same 22-line block across 8 files would create 7 places where a future change (e.g. adding a new AppError code with custom 4xx handling) has to land — and the `RouteVars` type would have 8 redundant declarations, drift-prone if a future Phase adds a new context Variable.
- **Fix:** Extracted `mapErr` and `RouteVars` to `src/lib/server/http/routes/_shared.ts`. Every Phase 2 route file imports both. The status type uses Hono's `ContentfulStatusCode` so AppError subclasses carrying any 4xx/5xx (422, 502, 409) flow through without a per-route mapping.
- **Files modified:** `src/lib/server/http/routes/_shared.ts` (created); imports in all 8 new route files.
- **Verification:** `pnpm exec eslint src/lib/server/http/routes/` exits 0; `pnpm exec tsc --noEmit` exits 0. The shared helper produces identical wire output to the inline pattern; Plan 02-09's Paraglide layer can map `AppError.code` strings without parsing message text.
- **Committed in:** `c6513a0` (Task 1)

**2. [Rule 3 - Blocking] DELETE /api/youtube-channels/:id NOT shipped (no service function)**

- **Found during:** Task 1 (writing youtube-channels routes)
- **Issue:** The plan's frontmatter `<must_haves>` and the `<action>` block sketch a `DELETE /api/youtube-channels/:id` route, but the Plan 02-04 service layer (`src/lib/server/services/youtube-channels.ts`) ships `createChannel`, `listChannels`, `attachToGame`, `detachFromGame`, `listChannelsForGame`, `toggleIsOwn`, `findOwnChannelByHandle` — there is no `removeChannel`. Wiring the route would require either landing the service function in this plan (out of scope) or stubbing the route to return 501 (which would be a vacuous pass on the cross-tenant matrix).
- **Fix:** The route is INTENTIONALLY NOT shipped. The user-facing "remove channel" UI (Plan 02-10) detaches per-game via DELETE /api/games/:gameId/youtube-channels/:channelId — which IS shipped here. The `MUST_BE_PROTECTED` list does not include `/api/youtube-channels/:id` for any method other than PATCH (toggleIsOwn). If a future plan needs channel-level deletion, it lands the service function first.
- **Files modified:** `src/lib/server/http/routes/youtube-channels.ts` (route omitted with documenting comment); `tests/integration/anonymous-401.test.ts` (kept entry `/api/youtube-channels/:id` for the PATCH method only).
- **Verification:** The MUST_BE_PROTECTED toContain guard still passes — Hono registers `/api/youtube-channels/:id` for the PATCH method, which matches the literal route pattern.
- **Committed in:** `c6513a0` (Task 1)

**3. [Rule 2 - Missing critical] D-37 cross-tenant matrix uses real-id seeding via service helpers**

- **Found during:** Task 2 (writing the cross-tenant matrix)
- **Issue:** The plan's `<action>` sketch for the cross-tenant matrix uses placeholder URLs like `/api/games/${game.id}` but doesn't fully spec how each child entity (listing, channel, key, event) gets seeded. Without real, owned-by-A ids the matrix would degenerate to "every probe hits a non-existent id and returns 404 by accident" — vacuous pass.
- **Fix:** The matrix test seeds A's resources via the actual service functions (createGame, createSteamKey, createChannel, createEvent, addSteamListing). User B then probes those real ids with their own cookie. Cross-tenant 404 is asserted on a row that ACTUALLY EXISTS for user A — the load-bearing case.
- **Files modified:** `tests/integration/tenant-scope.test.ts`
- **Verification:** The seeding uses `vi.spyOn` against `SteamApi.validateSteamKey` and `SteamApi.fetchSteamAppDetails` to mock the external Steam calls (matches the established pattern from `secrets-steam.test.ts`). The `try/finally` block restores the spies. The `expect.soft` calls each carry a descriptive failure message keyed on `${method} ${path}` so triage doesn't require re-running individual probes.
- **Committed in:** `d2a320d` (Task 2)

**4. [Rule 1 - Bug] log-redact spy wrapper preserves return value**

- **Found during:** Task 2 (writing the log-redact test)
- **Issue:** The plan's `<action>` sketch wraps `logger.info` etc. as `(...args) => { captured.push(...); return fn(...args); }`. But the wrap function in the plan also stringifies via `JSON.stringify(args)`, which throws on circular references (e.g. some Pino contexts carry `req` objects with self-references). A throw inside the spy wrapper would bubble out and break the test.
- **Fix:** The wrap function does try/catch around `JSON.stringify(args)` and falls back to `args.map(String).join(' ')` on circular-ref errors. Either way, the captured string is added to the array; either way, the original logger function still runs.
- **Files modified:** `tests/integration/log-redact.test.ts`
- **Verification:** TypeScript compiles. The substantive assertion (plaintext + base64-shaped ciphertext bytes never appear in `all`) is unchanged.
- **Committed in:** `d2a320d` (Task 2)

---

**Total deviations:** 4 auto-fixed (2 blocking, 1 missing-critical, 1 bug).
**Impact on plan:** None of the four change the plan's contract. Deviation 1 reduces copy-paste hazard across 8 route files. Deviation 2 keeps the route-service surface symmetric (no orphan routes). Deviation 3 makes the matrix substantively load-bearing rather than vacuously passing on missing ids. Deviation 4 makes the spy wrapper robust against Pino's circular contexts.

## Authentication Gates

None encountered. The Steam Web API probes are mocked via `vi.spyOn(SteamApi, 'validateSteamKey')` (matches the established pattern from `secrets-steam.test.ts`); the OAuth dance is bypassed by `seedUserDirectly` (Phase 1 helpers).

## Issues Encountered

- **Local Postgres not available:** the integration test suite cannot execute on this Windows dev workstation (no `pg_isready`, no Docker daemon, no `.env` file). Same gating story as Plans 02-01 through 02-07. The test FILES compile (`pnpm exec tsc --noEmit` exits 0), the test FILES lint (`pnpm exec eslint` exits 0), and the unit suite passes 65/65 (no regression). CI's Postgres service container will execute the new integration assertions on push.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Plan 02-09 (theme + components + Paraglide)** has the route layer ready: every error code that needs Paraglide message mapping is now reachable via `mapErr` (`unsupported_url`, `youtube_unavailable` + `metadata.reason`, `youtube_oembed_unreachable`, `validation_failed`, `steam_key_label_exists`, `steam_api_unavailable`, `duplicate_item`, `not_found`, `invalid_cursor`). The Paraglide picker keys on `AppError.code` (and `AppError.metadata.reason` for youtube_unavailable's two sub-strings); zero message-string parsing at the boundary.
- **Plan 02-10 (Svelte pages)** has 8 sub-routers with zod-validated input and DTO-projected output. The PasteBox UI calls POST /api/items/youtube; the discriminated `IngestResult.kind` (200 reddit_deferred / 201 youtube_video_created / 201 event_created) drives the success / friendly-deferred / error states. The settings page calls POST /api/me/theme to flip the theme cookie + DB. The audit log page consumes GET /api/audit's `nextCursor` directly into a "Load more" button.
- **Plan 02-11 (smoke 360 validation)** has the cross-tenant matrix as a structural anchor — the smoke harness can boot the production image, dance OAuth via oauth2-mock-server for two synthetic users, and exercise a subset of the same probes against the running container. Confirming 404 (not 403, not 200) end-to-end is the load-bearing trust signal for the smoke gate.
- **Phase 3 (polling worker)** has every Phase 2 audit verb (key.add/rotate/remove, game.created/deleted/restored, item.created/deleted, event.created/edited/deleted, theme.changed) reachable via the actual /api/* surface. The polling worker's failure-mode audits (Phase 3) will land alongside the existing read endpoint via Plan 02-08's GET /api/audit.

## Self-Check: PASSED

All claims in this summary verified against disk and git history:

- `src/lib/server/http/routes/_shared.ts`: FOUND
- `src/lib/server/http/routes/games.ts`: FOUND (POST /games + GET /games + GET/PATCH/DELETE /games/:id + POST /games/:id/restore)
- `src/lib/server/http/routes/game-listings.ts`: FOUND
- `src/lib/server/http/routes/youtube-channels.ts`: FOUND
- `src/lib/server/http/routes/api-keys-steam.ts`: FOUND
- `src/lib/server/http/routes/items-youtube.ts`: FOUND
- `src/lib/server/http/routes/events.ts`: FOUND
- `src/lib/server/http/routes/audit.ts`: FOUND
- `src/lib/server/http/routes/me-theme.ts`: FOUND
- `src/lib/server/http/app.ts`: MODIFIED (8 new imports + 8 app.route mounts; total /api mounts = 10)
- `src/lib/server/services/me.ts`: MODIFIED (updateUserTheme exported)
- `tests/integration/anonymous-401.test.ts`: MODIFIED (MUST_BE_PROTECTED 1 → 24 entries)
- `tests/integration/tenant-scope.test.ts`: MODIFIED (2 it.skip → live + new D-37 matrix describe with 21 probes)
- `tests/integration/log-redact.test.ts`: MODIFIED (Wave 0 it.skip → live)
- Commit `c6513a0` (Task 1): FOUND in git log
- Commit `d2a320d` (Task 2): FOUND in git log
- `pnpm exec tsc --noEmit`: exits 0
- `pnpm exec eslint src/lib/server/http/routes/ tests/integration/anonymous-401.test.ts tests/integration/tenant-scope.test.ts tests/integration/log-redact.test.ts`: exits 0
- `pnpm test:unit`: 65 passed (no regression)
- `grep -c "app.route(\"/api\"" src/lib/server/http/app.ts` → 10 (≥10 required)
- `grep -c "/api/games" tests/integration/anonymous-401.test.ts` → 12 (≥5 required)
- `grep -c "MUST_BE_PROTECTED" tests/integration/anonymous-401.test.ts` → 4 (≥2 required)
- env discipline: `grep -n "process\.env" src/lib/server/http/routes/me-theme.ts` returns ONLY a comment line (no code reference); `grep -n 'from "../../config/env.js"' src/lib/server/http/routes/me-theme.ts` returns one import line

---
*Phase: 02-ingest-secrets-and-audit*
*Completed: 2026-04-27*
