---
phase: 02-ingest-secrets-and-audit
plan: 04
type: execute
wave: 1
depends_on: [02-03-schema-and-migration]
files_modified:
  - src/lib/server/services/games.ts
  - src/lib/server/services/game-steam-listings.ts
  - src/lib/server/services/youtube-channels.ts
  - src/lib/server/integrations/steam-api.ts
  - src/lib/server/dto.ts
  - tests/integration/games.test.ts
  - tests/integration/game-listings.test.ts
autonomous: true
requirements: [GAMES-01, GAMES-02, GAMES-03, GAMES-04a]
requirements_addressed: [GAMES-01, GAMES-02, GAMES-03, GAMES-04a]
must_haves:
  truths:
    - "createGame inserts a row scoped to userId; missing title rejects before INSERT"
    - "softDeleteGame cascades deleted_at to game_steam_listings, game_youtube_channels, tracked_youtube_videos, events in one tx (D-23)"
    - "restoreGame reverses ONLY rows whose deleted_at === parent.deleted_at (rows soft-deleted earlier stay deleted)"
    - "createGameSteamListing fetches Steam appdetails on insert and stores cover_url/release_date/genres/categories/raw_appdetails"
    - "createYoutubeChannel and attachYoutubeChannelToGame produce the M:N pair via gameYoutubeChannels link"
    - "Every service function takes userId: string as first arg and filters every query by eq(<table>.userId, userId)"
    - "ESLint tenant-scope rule (Plan 02) reports zero violations on these files"
    - "writeAudit fires for game.created / game.deleted / game.restored / item.created (channel attach)"
  artifacts:
    - path: "src/lib/server/services/games.ts"
      provides: "createGame, listGames, getGameById, updateGame, softDeleteGame, restoreGame, listSoftDeletedGames"
      contains: "softDeleteGame"
      min_lines: 100
    - path: "src/lib/server/services/game-steam-listings.ts"
      provides: "addSteamListing, listListings, removeSteamListing, attachKeyToListing"
      contains: "fetchSteamAppDetails"
      min_lines: 60
    - path: "src/lib/server/services/youtube-channels.ts"
      provides: "createChannel, listChannels, attachToGame, detachFromGame, listChannelsForGame, toggleIsOwn"
      contains: "gameYoutubeChannels"
      min_lines: 60
    - path: "src/lib/server/integrations/steam-api.ts"
      provides: "fetchSteamAppDetails (no key) + validateSteamKey (Plan 05 also touches this file)"
      contains: "store.steampowered.com/api/appdetails"
      min_lines: 40
    - path: "src/lib/server/dto.ts"
      provides: "toGameDto, toGameSteamListingDto, toYoutubeChannelDto + GameDto/ListingDto/ChannelDto interfaces"
      contains: "toGameDto"
  key_links:
    - from: "src/lib/server/services/games.ts"
      to: "src/lib/server/audit.ts"
      via: "writeAudit calls for game.created / game.deleted / game.restored"
      pattern: "writeAudit\\(.*game\\."
    - from: "src/lib/server/services/games.ts"
      to: "src/lib/server/db/schema/games.ts (and 4 children)"
      via: "Soft-cascade tx updates parent + 4 children with same deleted_at value"
      pattern: "transaction\\("
    - from: "src/lib/server/services/game-steam-listings.ts"
      to: "src/lib/server/integrations/steam-api.ts"
      via: "fetchSteamAppDetails(appId) called once at insert; result stored in raw_appdetails jsonb"
      pattern: "fetchSteamAppDetails"
---

<objective>
Land the service layer for games + game_steam_listings + youtube_channels (the M:N attach to games via game_youtube_channels). Cover GAMES-01..04. Add corresponding DTO projections (D-39). Flip the games and game-listings placeholder it.skip stubs to live integration tests against the migrated schema.

Purpose: This is the first plan that exercises the ESLint tenant-scope rule (Plan 02), the Phase 1 envelope encryption / audit / NotFoundError primitives, and the Phase 2 schema (Plan 03) all together. The soft-cascade transactional restore pattern lands here as a reference implementation for any future entity that needs the same shape.

Output: 3 new service files, 1 new integrations file (Steam appdetails — Plan 05 extends with `validateSteamKey`), DTO additions for the 3 entities, integration test bodies for `tests/integration/games.test.ts` and `tests/integration/game-listings.test.ts`.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/lib/server/db/schema/games.ts
@src/lib/server/db/schema/game-steam-listings.ts
@src/lib/server/db/schema/youtube-channels.ts
@src/lib/server/db/schema/game-youtube-channels.ts
@src/lib/server/db/schema/tracked-youtube-videos.ts
@src/lib/server/db/schema/events.ts
@src/lib/server/audit.ts
@src/lib/server/services/errors.ts
@src/lib/server/dto.ts
@src/lib/server/db/client.ts
@src/lib/server/services/me.ts
@.planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md
@.planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md
@.planning/phases/02-ingest-secrets-and-audit/02-01-SUMMARY.md
@.planning/phases/02-ingest-secrets-and-audit/02-03-SUMMARY.md

<interfaces>
<!-- Phase 1 service convention (verified in src/lib/server/services/me.ts):

```typescript
export async function getMe(userId: string): Promise<UserDto> {
  const rows = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (rows.length === 0) throw new NotFoundError();
  return toUserDto(rows[0]!);
}
```

writeAudit signature (src/lib/server/audit.ts):
```typescript
writeAudit({ userId: string, action: AuditAction, ipAddress: string, userAgent?: string|null, metadata?: Record<string, unknown> })
```

NotFoundError throws produce HTTP 404 + `{error: 'not_found'}` (translated at the route boundary in Plan 08).

ESLint tenant-scope rule (Plan 02) requires every db.select/.update/.delete on tenant tables to have `userId` literally in the .where(...). Use destructured `userId` (not aliased) so the regex matches.
-->

<!-- Steam appdetails contract (RESEARCH.md §"7. Steam appdetails fetch" lines 1276–1316):
GET https://store.steampowered.com/api/appdetails?appids=<appId>&l=en
Response shape:
  { "<appId>": { "success": true, "data": { name, header_image, release_date: { date, coming_soon }, genres: [{description}], categories: [{description}], ... } } }
On invalid appId: { "<appId>": { "success": false } }
Rate limit: ~200 req/5min (community wisdom — Phase 6 caches; Phase 2 fetches once per insert)
-->
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Implement games + listings + channels services and steam-api integration; light up DTO projections</name>
  <files>src/lib/server/services/games.ts, src/lib/server/services/game-steam-listings.ts, src/lib/server/services/youtube-channels.ts, src/lib/server/integrations/steam-api.ts, src/lib/server/dto.ts</files>
  <read_first>
    - src/lib/server/services/me.ts (Phase 1 service convention — Hono variable shape, NotFoundError throw, single-row .limit(1) projection)
    - src/lib/server/audit.ts (writeAudit signature; never-throws contract)
    - src/lib/server/dto.ts (Phase 1 DTO template — projection function returns explicit object literal, never spread)
    - src/lib/server/db/schema/games.ts + game-steam-listings.ts + youtube-channels.ts + game-youtube-channels.ts + tracked-youtube-videos.ts + events.ts (the schema files Plan 03 created — use exported names: games, gameSteamListings, youtubeChannels, gameYoutubeChannels, trackedYoutubeVideos, events)
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"Soft-cascade transactional restore pattern" lines 469–581 (full softDeleteGame + restoreGame implementation; copy verbatim) and §"7. Steam appdetails fetch" lines 1276–1316 (fetchSteamAppDetails verbatim)
    - .planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md `<decisions>` D-22 / D-23 / D-24 (retention + soft-cascade + which tables NOT to cascade)
  </read_first>
  <action>
    **A. Create `src/lib/server/integrations/steam-api.ts`** — fetchSteamAppDetails (verbatim from RESEARCH.md §7 lines 1276–1316). Plan 05 extends this file with `validateSteamKey`. Keep the `fetchSteamAppDetails` export so Plan 05 doesn't have to re-author it.

    Implementation outline (full code from RESEARCH.md):
    ```typescript
    // SteamAppDetails interface + fetchSteamAppDetails(appId): Promise<SteamAppDetails | null>
    // 5s AbortController timeout; logs warn on non-2xx; returns null on success:false.
    // Phase 6 deferred optimization: shared appdetails cache.
    ```

    **B. Create `src/lib/server/services/games.ts`** with these exported functions. Each function takes `userId: string` as the FIRST arg and filters every query by `eq(games.userId, userId)` (or the equivalent on the relevant table).

    Export shape:
    ```typescript
    export interface CreateGameInput { title: string; notes?: string; }
    export async function createGame(userId: string, input: CreateGameInput, ipAddress: string): Promise<GameRow>
    export async function listGames(userId: string, opts?: { includeSoftDeleted?: boolean }): Promise<GameRow[]>
    export async function getGameById(userId: string, gameId: string): Promise<GameRow>     // throws NotFoundError on miss/cross-tenant
    export interface UpdateGameInput { title?: string; notes?: string; tags?: string[]; releaseTba?: boolean; releaseDate?: string|null; coverUrl?: string|null; }
    export async function updateGame(userId: string, gameId: string, input: UpdateGameInput): Promise<GameRow>
    export async function softDeleteGame(userId: string, gameId: string, ipAddress: string): Promise<void>
    export async function restoreGame(userId: string, gameId: string, ipAddress: string): Promise<void>
    export async function listSoftDeletedGames(userId: string): Promise<GameRow[]>
    ```

    Implementation rules (CRITICAL):
    1. `createGame`: validate `input.title.length >= 1 && input.title.length <= 200` (zod or manual; planner picks). On failure throw an `AppError` with code `'validation_failed'` and status 422 (do NOT INSERT). On success, INSERT row with `userId`, `title`, `notes ?? ""`, return the inserted row, then `await writeAudit({userId, action: 'game.created', ipAddress, metadata: {gameId: row.id}})`. writeAudit is fire-and-forget but `await`-ed (it never throws).
    2. `listGames` with `includeSoftDeleted: false` (default): `WHERE userId = $1 AND deleted_at IS NULL ORDER BY created_at DESC`. With `includeSoftDeleted: true`: include all.
    3. `getGameById`: SELECT scoped by `userId AND id`. Returns the row or throws `NotFoundError` (no result OR row.deleted_at !== null when includeSoftDeleted defaults false). For Plan 08's restore route, expose a separate `getGameByIdIncludingDeleted` that skips the `IS NULL` check.
    4. `softDeleteGame`: implement EXACTLY the pattern from RESEARCH.md §"Soft-cascade transactional restore pattern" — capture `const deletedAt = new Date();` once; `db.transaction(async (tx) => { ... })`; UPDATE `games`; if 0 rows then `throw new NotFoundError()`; UPDATE `gameSteamListings`, `gameYoutubeChannels`, `trackedYoutubeVideos`, `events` with the same `deletedAt` value scoped by `userId AND gameId`. NOT cascaded: `youtubeChannels`, `apiKeysSteam` (D-24). After tx, `writeAudit({action: 'game.deleted', metadata: {gameId, retentionDays: env.RETENTION_DAYS}})`.
    5. `restoreGame`: SELECT parent's `deleted_at` (`markerTs`); UPDATE `games SET deleted_at = NULL WHERE userId = $1 AND id = $2`; UPDATE each child WHERE `userId = $1 AND gameId = $2 AND deleted_at = $markerTs`. Audit `game.restored`.

    Cross-cutting: every Drizzle query in this file MUST include `userId` literally in `.where(...)` so the ESLint rule from Plan 02 is satisfied. Disable comments are not allowed.

    **C. Create `src/lib/server/services/game-steam-listings.ts`**:

    Export shape:
    ```typescript
    export interface AddSteamListingInput { gameId: string; appId: number; label?: string; }
    export async function addSteamListing(userId: string, input: AddSteamListingInput, ipAddress: string): Promise<SteamListingRow>
    export async function listListings(userId: string, gameId: string): Promise<SteamListingRow[]>
    export async function removeSteamListing(userId: string, listingId: string, ipAddress: string): Promise<void>   // soft-delete only
    export async function attachKeyToListing(userId: string, listingId: string, keyId: string | null): Promise<SteamListingRow>
    ```

    Implementation rules:
    1. `addSteamListing`: First, assert the game exists (call `getGameById(userId, input.gameId)` so it throws NotFoundError on cross-tenant — defense in depth). Then call `await fetchSteamAppDetails(input.appId)`. If null, save the listing with cover_url/release_date NULL and `coming_soon='unavailable'`. If success, populate from response. Then INSERT into gameSteamListings — `UNIQUE (game_id, app_id)` and `UNIQUE(user_id, app_id)` constraints reject dupes via Postgres error → translate to AppError 409 in route handler (Plan 08); service throws raw db error here.
    2. `attachKeyToListing`: UPDATE `gameSteamListings SET api_key_id = $1 WHERE userId = $1 AND id = $2`. Returning the row. NotFoundError on miss.
    3. NO audit log entries from listings (per D-32: only `game.*`, `key.*`, `item.*`, `event.*`, `theme.*`, session.*; no `listing.*`). Listings are creation/destruction events, not security events.
    4. `removeSteamListing` is soft-delete: `UPDATE gameSteamListings SET deleted_at = now() WHERE userId AND id`. No audit.

    **D. Create `src/lib/server/services/youtube-channels.ts`**:

    Export shape:
    ```typescript
    export interface CreateChannelInput { handleUrl: string; channelId?: string|null; displayName?: string|null; isOwn?: boolean; }
    export async function createChannel(userId: string, input: CreateChannelInput): Promise<YoutubeChannelRow>
    export async function listChannels(userId: string): Promise<YoutubeChannelRow[]>
    export async function attachToGame(userId: string, gameId: string, channelId: string): Promise<void>
    export async function detachFromGame(userId: string, gameId: string, channelId: string): Promise<void>
    export async function listChannelsForGame(userId: string, gameId: string): Promise<YoutubeChannelRow[]>
    export async function toggleIsOwn(userId: string, channelId: string, isOwn: boolean): Promise<YoutubeChannelRow>
    export async function findOwnChannelByHandle(userId: string, handleUrl: string): Promise<YoutubeChannelRow | null>   // INGEST-03 lookup; consumed by Plan 06
    ```

    Implementation rules:
    1. `createChannel`: validate `handleUrl` parses to `{youtube.com|www.youtube.com}/@<handle>` OR `{youtube.com|www.youtube.com}/channel/UC<id>`. UNIQUE(user_id, handle_url) constraint prevents dupes. NO audit event.
    2. `attachToGame`: assert game exists (call `getGameById`); assert channel exists (SELECT); INSERT `gameYoutubeChannels(userId, gameId, channelId)`. UNIQUE(game_id, channel_id) prevents dupes — translate to 409 at route boundary. NO audit event (low forensic value).
    3. `findOwnChannelByHandle(userId, handleUrl)`: this is the **INGEST-03 own/blogger resolver** (D-21 + Pitfall 3 Option C). SELECT `*` FROM youtubeChannels WHERE userId = $1 AND handle_url = $2 AND is_own = true LIMIT 1. Return the row OR null. This function is called from `services/items-youtube.ts` (Plan 06).
    4. `toggleIsOwn`: UPDATE `youtubeChannels SET is_own = $1 WHERE userId AND id`. NO audit (UI-only flag toggle).

    **E. AMEND `src/lib/server/dto.ts`** — append the new projection functions and interfaces. Each function takes `Row` ($inferSelect of the table) and returns the DTO object EXPLICITLY (no spread).

    Add:
    ```typescript
    // Phase 2 entity DTOs — D-39 projection discipline.
    import type { games, gameSteamListings, youtubeChannels } from "./db/schema/index.js";

    type GameRow = typeof games.$inferSelect;
    type SteamListingRow = typeof gameSteamListings.$inferSelect;
    type YoutubeChannelRow = typeof youtubeChannels.$inferSelect;

    export interface GameDto {
      id: string;
      title: string;
      coverUrl: string | null;
      releaseDate: string | null;
      releaseTba: boolean;
      tags: string[];
      notes: string;
      createdAt: Date;
      updatedAt: Date;
      deletedAt: Date | null;
    }
    export function toGameDto(r: GameRow): GameDto { /* explicit fields */ }

    export interface GameSteamListingDto {
      id: string;
      gameId: string;
      appId: number;
      label: string;
      coverUrl: string | null;
      releaseDate: string | null;
      comingSoon: string | null;
      steamGenres: string[];
      steamCategories: string[];
      apiKeyId: string | null;
      createdAt: Date;
      updatedAt: Date;
      deletedAt: Date | null;
    }
    export function toGameSteamListingDto(r: SteamListingRow): GameSteamListingDto { /* explicit; do NOT include rawAppdetails — it's forensics, not UI */ }

    export interface YoutubeChannelDto {
      id: string;
      handleUrl: string;
      channelId: string | null;
      displayName: string | null;
      isOwn: boolean;
      createdAt: Date;
      updatedAt: Date;
    }
    export function toYoutubeChannelDto(r: YoutubeChannelRow): YoutubeChannelDto { /* explicit */ }
    ```

    `toGameSteamListingDto` MUST NOT include `rawAppdetails` (it's the full Steam payload — too large + contains URLs / asset references the UI doesn't need; future-proofs against accidental exposure).

    `toGameDto` does NOT include `userId` — the caller already knows their own id; the DTO never carries the tenant identifier (P3 discipline; Phase 1 toUserDto template).
  </action>
  <verify>
    <automated>pnpm exec tsc --noEmit 2>&1 | tail -10 && pnpm exec eslint src/lib/server/services/games.ts src/lib/server/services/game-steam-listings.ts src/lib/server/services/youtube-channels.ts 2>&1 | tail -10</automated>
  </verify>
  <done>
    - 3 service files compile clean; ESLint reports zero violations of `tenant-scope/no-unfiltered-tenant-query`.
    - Every exported function takes `userId: string` as first arg.
    - `softDeleteGame` and `restoreGame` use the captured-timestamp tx pattern from RESEARCH.md.
    - `findOwnChannelByHandle` exists and is consumable by Plan 06's items-youtube service.
    - DTO projections in `src/lib/server/dto.ts` cover GameDto, GameSteamListingDto (without rawAppdetails), YoutubeChannelDto.
    - `fetchSteamAppDetails` is exported from `src/lib/server/integrations/steam-api.ts`.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Flip placeholder it.skip stubs to live tests for games + game-listings (4 + 2 = 6 tests)</name>
  <files>tests/integration/games.test.ts, tests/integration/game-listings.test.ts</files>
  <read_first>
    - tests/integration/games.test.ts (placeholder file from Plan 02-01 — has 4 it.skip stubs with EXACT plan-NN annotations)
    - tests/integration/game-listings.test.ts (placeholder file from Plan 02-01 — has 2 it.skip stubs)
    - tests/integration/helpers.ts (seedUserDirectly for cookie-bearing test users)
    - tests/integration/tenant-scope.test.ts lines 22–47 (cross-tenant test pattern — use the same shape for the cross-tenant block in games.test.ts: seed user A + user B, perform tenant A operation, fetch as B, expect NotFoundError)
    - src/lib/server/services/games.ts (Task 1 output — the functions under test)
    - src/lib/server/services/game-steam-listings.ts and youtube-channels.ts (also under test in game-listings.test.ts)
  </read_first>
  <behavior>
    Replace each `it.skip(...)` from Plan 02-01 with a live `it(...)`. Tests call the service functions directly (NOT the HTTP route — Plan 08 lands the routes). The integration test runs against the migrated test DB.

    Test list (replace `it.skip` with `it`):

    **games.test.ts:**
    1. `02-04: GAMES-01 create game returns 201 + DTO` — call `createGame(userA.id, {title: 'My Test Game'}, '127.0.0.1')`; expect returned row has uuidv7 id, title='My Test Game', userId=userA.id; expect a `game.created` audit row with metadata.gameId === row.id.
    2. `02-04: GAMES-01 422 on missing title` — call `createGame(userA.id, {title: ''}, '127.0.0.1')`; expect rejects with AppError code='validation_failed' status=422; expect ZERO games rows in DB for userA.
    3. `02-04: GAMES-02 soft cascade delete` — seed for userA: 1 game `g1` + 1 `gameSteamListings` row + 1 `youtubeChannels` row `chA` (user-level) + 1 `gameYoutubeChannels` link row joining `chA` to `g1` + 1 `trackedYoutubeVideos` row + 1 `events` row. Call `softDeleteGame(userA.id, g1.id, '127.0.0.1')`. Assertions:
       - Parent `games` row's `deletedAt` is non-null.
       - All FOUR cascaded children share an identical `deletedAt` value (microsecond-equal): the `gameSteamListings` row, the `gameYoutubeChannels` link row, the `trackedYoutubeVideos` row, and the `events` row. (B-4 fix: `gameYoutubeChannels` MUST be exercised — it's the M:N example for the cascade pattern.)
       - The underlying `youtubeChannels` row's `deletedAt` is still NULL (NOT cascaded — D-24 — channels live at user level and are reused across games).
       - The user's `apiKeysSteam` rows are NOT touched (D-24).
       - A `game.deleted` audit row exists.

       Concrete acceptance criterion (greppable): `tests/integration/games.test.ts` MUST contain BOTH the literal string `gameYoutubeChannels` AND the literal string `expect(youtubeChannel.deletedAt).toBeNull()` (the D-24 negative assertion that the user-level channel was NOT cascaded). Verifying: `grep -c "gameYoutubeChannels" tests/integration/games.test.ts` >= 1; `grep -c "youtubeChannel.deletedAt).toBeNull" tests/integration/games.test.ts` >= 1.
    4. `02-04: GAMES-02 transactional restore` — seed a game; soft-delete a child item BEFORE soft-deleting the parent (so the child's deletedAt < parent's deletedAt); soft-delete the parent; restore the parent; expect the child stays deleted (its deletedAt < parent.deletedAt); expect a `game.restored` audit row.

    **game-listings.test.ts:**
    1. `02-04: GAMES-04a attach youtube channel` — seed game for userA; createChannel; attachToGame; listChannelsForGame returns one row.
    2. `02-04: GAMES-04a multiple channels per game (M:N)` — same game; createChannel × 2; attach both; listChannelsForGame returns two rows; attempting a third attach with the same channelId fails with a UNIQUE constraint error.

    Cross-tenant smoke (one extra test per file): user B trying any of the above against user A's resources gets `NotFoundError` (404).
  </behavior>
  <action>
    Open each placeholder file. For every `it.skip(...)` whose annotation begins with `02-04:`, replace `it.skip` with `it` and fill in the body per the Behavior block. Do NOT add any new `it()` calls — if a behavior is missing from the placeholder list, the gap belongs in Plan 02-01.

    Sketch for games.test.ts test 1:

    ```typescript
    import { describe, it, expect } from "vitest";
    import { eq } from "drizzle-orm";
    import { createGame, softDeleteGame, restoreGame, getGameById } from "../../src/lib/server/services/games.js";
    import { db } from "../../src/lib/server/db/client.js";
    import { games } from "../../src/lib/server/db/schema/games.js";
    import { auditLog } from "../../src/lib/server/db/schema/audit-log.js";
    import { seedUserDirectly } from "./helpers.js";
    import { AppError, NotFoundError } from "../../src/lib/server/services/errors.js";

    describe("games CRUD (GAMES-01, GAMES-02)", () => {
      it("02-04: GAMES-01 create game returns 201 + DTO", async () => {
        const userA = await seedUserDirectly({ email: "g1-a@test.local" });
        const game = await createGame(userA.id, { title: "My Test Game" }, "127.0.0.1");
        expect(game.title).toBe("My Test Game");
        expect(game.userId).toBe(userA.id);
        expect(game.id).toMatch(/^[0-9a-f-]{36}$/);

        const audits = await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.userId, userA.id));
        expect(audits.some((a) => a.action === "game.created" && (a.metadata as any)?.gameId === game.id)).toBe(true);
      });
      // ... fill in tests 2, 3, 4 + cross-tenant test
    });
    ```

    For game-listings.test.ts test 2 (M:N multiplicity):
    ```typescript
    it("02-04: GAMES-04a multiple channels per game (M:N)", async () => {
      const userA = await seedUserDirectly({ email: "ch-a@test.local" });
      const game = await createGame(userA.id, { title: "G1" }, "127.0.0.1");
      const c1 = await createChannel(userA.id, { handleUrl: "https://www.youtube.com/@A" });
      const c2 = await createChannel(userA.id, { handleUrl: "https://www.youtube.com/@B" });
      await attachToGame(userA.id, game.id, c1.id);
      await attachToGame(userA.id, game.id, c2.id);
      const all = await listChannelsForGame(userA.id, game.id);
      expect(all.map((c) => c.id).sort()).toEqual([c1.id, c2.id].sort());

      // Third attach with same channel — UNIQUE(game_id, channel_id) rejects.
      await expect(attachToGame(userA.id, game.id, c1.id)).rejects.toThrow(/unique|duplicate/i);
    });
    ```

    Cross-tenant test (add to games.test.ts):
    ```typescript
    it("02-04: cross-tenant getGameById returns NotFoundError (404, not 403)", async () => {
      const userA = await seedUserDirectly({ email: "ct-a@test.local" });
      const userB = await seedUserDirectly({ email: "ct-b@test.local" });
      const aGame = await createGame(userA.id, { title: "A's Game" }, "127.0.0.1");
      await expect(getGameById(userB.id, aGame.id)).rejects.toBeInstanceOf(NotFoundError);
    });
    ```
  </action>
  <verify>
    <automated>pnpm test:integration tests/integration/games.test.ts tests/integration/game-listings.test.ts --reporter=verbose 2>&1 | tail -30</automated>
  </verify>
  <done>
    All 6 placeholder tests (4 in games.test.ts + 2 in game-listings.test.ts) plus 2 cross-tenant additions are now `it(...)` (no skipped count for these files). `pnpm test:integration tests/integration/games.test.ts tests/integration/game-listings.test.ts` reports green; total assertions ≥ 8.
  </done>
</task>

</tasks>

<verification>
- `pnpm exec eslint src/lib/server/services/` exits 0 — the tenant-scope rule does not fire.
- `pnpm test:integration tests/integration/games.test.ts tests/integration/game-listings.test.ts` is green.
- `grep -c "writeAudit" src/lib/server/services/games.ts` >= 3 (one per game.created / game.deleted / game.restored).
- `grep -c "transaction" src/lib/server/services/games.ts` >= 2 (softDelete + restore both use db.transaction).
- `grep -c "fetchSteamAppDetails" src/lib/server/services/game-steam-listings.ts` >= 1.
</verification>

<success_criteria>
- 3 new service files cover GAMES-01..04: createGame, listGames, getGameById, updateGame, softDeleteGame (with cascade), restoreGame, listSoftDeletedGames; addSteamListing (with appdetails fetch), listListings, removeSteamListing, attachKeyToListing; createChannel, listChannels, attachToGame, detachFromGame, listChannelsForGame, toggleIsOwn, findOwnChannelByHandle.
- Soft-cascade tx captures one `deletedAt = new Date()` and applies it to parent + 4 children (game_steam_listings, game_youtube_channels, tracked_youtube_videos, events). Restore reverses ONLY children whose deletedAt === parent.deletedAt.
- youtube_channels and api_keys_steam are NOT cascaded (D-24).
- DTO projections (`toGameDto`, `toGameSteamListingDto` excluding rawAppdetails, `toYoutubeChannelDto`) exist and are tested at type-check time.
- `findOwnChannelByHandle` exists for Plan 06 ingest consumption.
- 6 placeholder tests + 2 cross-tenant tests pass.
- ESLint tenant-scope rule reports zero violations.
</success_criteria>

<output>
After completion, create `.planning/phases/02-ingest-secrets-and-audit/02-04-SUMMARY.md`. Highlight: which placeholder it.skip stubs were flipped to `it`, the audit metadata shapes used, any deviations from the RESEARCH.md soft-cascade pattern (there shouldn't be any).
</output>
