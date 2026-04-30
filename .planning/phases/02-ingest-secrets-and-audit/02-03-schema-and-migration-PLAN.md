---
phase: 02-ingest-secrets-and-audit
plan: 03
type: execute
wave: 0
depends_on: []
files_modified:
  - src/lib/server/db/schema/games.ts
  - src/lib/server/db/schema/game-steam-listings.ts
  - src/lib/server/db/schema/youtube-channels.ts
  - src/lib/server/db/schema/game-youtube-channels.ts
  - src/lib/server/db/schema/api-keys-steam.ts
  - src/lib/server/db/schema/tracked-youtube-videos.ts
  - src/lib/server/db/schema/events.ts
  - src/lib/server/db/schema/audit-log.ts
  - src/lib/server/db/schema/auth.ts
  - src/lib/server/db/schema/index.ts
  - src/lib/server/audit/actions.ts
  - src/lib/server/config/env.ts
  - drizzle/0001_phase02_schema.sql
  - .env.example
  - tests/integration/migrate.test.ts
autonomous: true
requirements: [GAMES-01, GAMES-02, GAMES-03, GAMES-04a, KEYS-03, KEYS-04, KEYS-05, KEYS-06, INGEST-02, INGEST-03, INGEST-04, EVENTS-01, EVENTS-02, EVENTS-03, PRIV-02]
requirements_addressed: [GAMES-01, GAMES-02, GAMES-03, GAMES-04a, KEYS-03, KEYS-04, KEYS-05, KEYS-06, INGEST-02, INGEST-03, INGEST-04, EVENTS-01, EVENTS-02, EVENTS-03, PRIV-02]
must_haves:
  truths:
    - "Seven new Drizzle schema files exist (games, game_steam_listings, youtube_channels, game_youtube_channels, api_keys_steam, tracked_youtube_videos, events) and re-export through the barrel"
    - "audit_log.action is a Postgres pgEnum with the 16 D-32 values; the existing text column is migrated in place via ALTER COLUMN ... USING action::audit_action"
    - "user table gains theme_preference text column with default 'system' (D-40)"
    - "src/lib/server/audit/actions.ts exports a const enum / typed list of audit action values; this is the SINGLE source of truth (D-32)"
    - "src/lib/server/config/env.ts exposes RETENTION_DAYS (default 60); .env.example documents it"
    - "drizzle-kit generate produces a clean diff (no shape drift between schema files and the generated SQL)"
    - "pnpm db:check passes (commutativity)"
    - "Boot-time runMigrations() applies the new migration under the existing advisory lock with no errors"
  artifacts:
    - path: "src/lib/server/db/schema/games.ts"
      provides: "games pgTable + indexes (user_id, user_id+created_at)"
      contains: "export const games = pgTable"
      min_lines: 30
    - path: "src/lib/server/db/schema/game-steam-listings.ts"
      provides: "game_steam_listings pgTable + UNIQUE(game_id, app_id) + UNIQUE(user_id, app_id) + api_key_id FK"
      contains: "export const gameSteamListings"
      min_lines: 30
    - path: "src/lib/server/db/schema/youtube-channels.ts"
      provides: "youtube_channels pgTable + handle_url + channel_id"
      contains: "export const youtubeChannels"
      min_lines: 25
    - path: "src/lib/server/db/schema/game-youtube-channels.ts"
      provides: "game_youtube_channels M:N link table"
      contains: "export const gameYoutubeChannels"
      min_lines: 20
    - path: "src/lib/server/db/schema/api-keys-steam.ts"
      provides: "api_keys_steam pgTable with envelope-encryption columns + UNIQUE(user_id, label) for D-13 multi-key cardinality"
      contains: "api_keys_steam_user_label_unq"
      min_lines: 35
    - path: "src/lib/server/db/schema/tracked-youtube-videos.ts"
      provides: "tracked_youtube_videos pgTable per D-09 verbatim spec"
      contains: "export const trackedYoutubeVideos"
      min_lines: 30
    - path: "src/lib/server/db/schema/events.ts"
      provides: "events pgTable + eventKindEnum (pgEnum closed picklist)"
      contains: "export const eventKindEnum = pgEnum"
      min_lines: 30
    - path: "src/lib/server/audit/actions.ts"
      provides: "auditActionEnum + AuditAction type + AUDIT_ACTIONS const list"
      contains: "export const auditActionEnum"
      min_lines: 25
    - path: "src/lib/server/db/schema/audit-log.ts"
      provides: "audit_log.action column re-typed to auditActionEnum"
      contains: "auditActionEnum"
    - path: "src/lib/server/db/schema/auth.ts"
      provides: "user.theme_preference text column with default 'system'"
      contains: "themePreference"
    - path: "src/lib/server/config/env.ts"
      provides: "RETENTION_DAYS env var, default 60"
      contains: "RETENTION_DAYS"
    - path: "drizzle/0001_phase02_schema.sql"
      provides: "Generated migration with CREATE TABLE × 7, CREATE TYPE × 2, ALTER TABLE audit_log/user × 2, ALTER COLUMN action TYPE audit_action USING action::audit_action"
      contains: "CREATE TYPE.*event_kind"
      min_lines: 80
    - path: ".env.example"
      provides: "RETENTION_DAYS documentation"
      contains: "RETENTION_DAYS=60"
  key_links:
    - from: "src/lib/server/db/schema/index.ts"
      to: "src/lib/server/db/schema/{games,game-steam-listings,youtube-channels,game-youtube-channels,api-keys-steam,tracked-youtube-videos,events}.ts"
      via: "barrel re-export so drizzle({schema}) sees every table"
      pattern: "export \\* from \"./games"
    - from: "src/lib/server/db/schema/audit-log.ts"
      to: "src/lib/server/audit/actions.ts"
      via: "audit_log.action is typed by auditActionEnum which lives in actions.ts and is re-imported by audit-log.ts"
      pattern: "import.*auditActionEnum"
    - from: "src/lib/server/db/schema/game-steam-listings.ts"
      to: "src/lib/server/db/schema/api-keys-steam.ts"
      via: "api_key_id FK reference"
      pattern: "references\\(\\(\\) => apiKeysSteam"
---

<objective>
Land all seven new Phase 2 tables, two table alterations (audit_log.action enum extension; user.theme_preference column), and the auxiliary single-source-of-truth files (`src/lib/server/audit/actions.ts`, RETENTION_DAYS in env.ts, .env.example update). Generate the Drizzle migration as ONE atomic SQL file; verify boot-time runMigrations applies cleanly. Wave 0 because every later plan in waves 1+ depends on these schema files importing through the barrel.

Purpose: This is the foundational wiring. Wave 1 services (games / api-keys-steam / items-youtube / events / audit-read) import these schema files; the ESLint AST rule (Plan 02) is registered against the same TENANT_TABLES set; the cross-tenant test sweep (Plan 08) targets every new `/api/*` route built on top of these tables. Get this right or every later wave inherits the bug.

Output: 11 schema-related files (7 NEW tables, 2 AMENDED tables, 1 NEW const-enum source, 1 AMENDED env), 1 generated migration SQL, 1 .env.example update.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@src/lib/server/db/schema/auth.ts
@src/lib/server/db/schema/audit-log.ts
@src/lib/server/db/schema/index.ts
@src/lib/server/db/migrate.ts
@src/lib/server/db/client.ts
@src/lib/server/config/env.ts
@src/lib/server/ids.ts
@drizzle.config.ts
@.env.example
@.planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md
@.planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md

<interfaces>
<!-- Phase 1 conventions every Phase 2 schema file MUST follow:

1. PRIMARY KEY shape (D-06):
   id: text("id").primaryKey().$defaultFn(() => uuidv7()),

2. user_id FK shape:
   userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),

3. Timestamps:
   createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
   updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
   deletedAt: timestamp("deleted_at", { withTimezone: true }),  // nullable; soft-delete marker

4. Indexes — declared in the second `pgTable` arg `(t) => ({ ... })`:
   userIdx: index("<table>_user_id_idx").on(t.userId),

5. bytea custom type for envelope columns:
   const bytea = customType<{ data: Buffer; default: false }>({ dataType: () => "bytea" });

6. Enum (pgEnum) shape (D-28; verified 2026-04-27 by RESEARCH.md):
   export const eventKindEnum = pgEnum("event_kind", ["conference", ...]);
   kind: eventKindEnum("kind").notNull(),
   IMPORTANT: enum MUST be `export`-ed or drizzle-kit silently drops it (#5174).

7. Existing Phase 1 imports inside a schema file:
   import { user } from "./auth.js";          // for FK references
   import { uuidv7 } from "../../ids.js";     // for $defaultFn
-->

<!-- Schema file dependency graph for the migration:
  user (existing) ← games ← game_steam_listings → api_keys_steam (game listings link to a key)
  user (existing) ← youtube_channels
  user (existing) ← games + youtube_channels ← game_youtube_channels (M:N link)
  user (existing) ← api_keys_steam
  user (existing) ← games ← tracked_youtube_videos
  user (existing) ← games ← events (pgEnum kind)
  user (existing) ← audit_log (action column re-typed to enum)

drizzle-kit will resolve order automatically when given `references()` — but the
ALTER TABLE audit_log ALTER COLUMN action TYPE audit_action USING action::audit_action
needs hand-review (Open Question 2 / 3 from RESEARCH.md).
-->
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Create the 7 new schema files + amend audit-log.ts and auth.ts + barrel + audit/actions.ts + env RETENTION_DAYS</name>
  <files>src/lib/server/db/schema/games.ts, src/lib/server/db/schema/game-steam-listings.ts, src/lib/server/db/schema/youtube-channels.ts, src/lib/server/db/schema/game-youtube-channels.ts, src/lib/server/db/schema/api-keys-steam.ts, src/lib/server/db/schema/tracked-youtube-videos.ts, src/lib/server/db/schema/events.ts, src/lib/server/db/schema/audit-log.ts, src/lib/server/db/schema/auth.ts, src/lib/server/db/schema/index.ts, src/lib/server/audit/actions.ts, src/lib/server/config/env.ts, .env.example</files>
  <read_first>
    - src/lib/server/db/schema/audit-log.ts (existing pattern: file header comments, pgTable shape, index declaration in `(t) => ({ ... })`)
    - src/lib/server/db/schema/auth.ts (existing pattern: 4 Better Auth tables; theme_preference column is added to `user` here)
    - src/lib/server/db/schema/index.ts (current barrel; only re-exports auth + audit-log)
    - src/lib/server/ids.ts (uuidv7 helper used in `$defaultFn`)
    - src/lib/server/config/env.ts (zod schema + KEK loader; RETENTION_DAYS goes into RawSchema near other primitives)
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"Code Examples" lines 1004–1063 (games + api_keys_steam schemas verbatim) and §"Drizzle 0.45 enum vs check-constraint" lines 379–442 (eventKindEnum + auditActionEnum verbatim)
    - .planning/phases/02-ingest-secrets-and-audit/02-CONTEXT.md `<decisions>` D-09 (tracked_youtube_videos verbatim), D-11 (full 7-table list), D-30 (events columns), D-32 (audit action list), D-40 (theme_preference)
    - .env.example (current vars; RETENTION_DAYS appended)
  </read_first>
  <action>
    **A. Create `src/lib/server/db/schema/games.ts`**:

    ```typescript
    // games table — GAMES-01..03, the parent of all per-game children.
    //
    // Pattern 1 (tenant scope): user_id FK + index. Every query in
    // services/games.ts MUST include eq(games.userId, userId).
    //
    // Soft-delete: deleted_at timestamptz nullable; D-22 RETENTION_DAYS
    // governs the purge window (Phase 3 worker). Soft-cascade: when a
    // games row is deleted, all children share the same deleted_at value
    // in one tx (D-23) so the restore can reverse exactly that set.
    //
    // tags is a text[] array column populated from Steam appdetails
    // (genres + categories + steam_tags merged at game-listing-create
    // time; the column on `games` carries the merged user-facing list).

    import { pgTable, text, timestamp, date, boolean, index } from "drizzle-orm/pg-core";
    import { user } from "./auth.js";
    import { uuidv7 } from "../../ids.js";

    export const games = pgTable(
      "games",
      {
        id: text("id").primaryKey().$defaultFn(() => uuidv7()),
        userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
        title: text("title").notNull(),
        coverUrl: text("cover_url"),
        releaseDate: date("release_date"),
        releaseTba: boolean("release_tba").notNull().default(false),
        tags: text("tags").array().notNull().default([] as string[]),
        notes: text("notes").notNull().default(""),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
      },
      (t) => ({
        userIdx: index("games_user_id_idx").on(t.userId),
        userCreatedIdx: index("games_user_id_created_at_idx").on(t.userId, t.createdAt),
        userDeletedIdx: index("games_user_id_deleted_at_idx").on(t.userId, t.deletedAt),
      }),
    );
    ```

    **B. Create `src/lib/server/db/schema/api-keys-steam.ts`** (per D-12 + RESEARCH.md §Code Example 2 lines 1031–1063, verbatim):

    ```typescript
    // api_keys_steam — KEYS-03..06, the typed-per-kind credential example (D-08).
    //
    // Envelope-encrypted at rest (D-12) — columns mirror EncryptedSecret from
    // src/lib/server/crypto/envelope.ts. Plaintext NEVER returns to the
    // client; toApiKeySteamDto in src/lib/server/dto.ts strips ciphertext at
    // projection time even if a service-layer query returns the full row.
    //
    // last4 is INTENTIONALLY in the DB and IN the DTO (D-34) — last4 is a
    // forensics aid for "which key was leaked", not a secret. Pino redact
    // does not match `last4` (verified Phase 1 plan 01-01 redact paths).

    import { pgTable, text, timestamp, smallint, customType, uniqueIndex, index } from "drizzle-orm/pg-core";
    import { sql } from "drizzle-orm";
    import { user } from "./auth.js";
    import { uuidv7 } from "../../ids.js";

    const bytea = customType<{ data: Buffer; default: false }>({ dataType: () => "bytea" });

    export const apiKeysSteam = pgTable(
      "api_keys_steam",
      {
        id: text("id").primaryKey().$defaultFn(() => uuidv7()),
        userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
        label: text("label").notNull(),
        last4: text("last4").notNull(),
        secretCt: bytea("secret_ct").notNull(),
        secretIv: bytea("secret_iv").notNull(),
        secretTag: bytea("secret_tag").notNull(),
        wrappedDek: bytea("wrapped_dek").notNull(),
        dekIv: bytea("dek_iv").notNull(),
        dekTag: bytea("dek_tag").notNull(),
        kekVersion: smallint("kek_version").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
        rotatedAt: timestamp("rotated_at", { withTimezone: true }),
      },
      (t) => ({
        userIdx: index("api_keys_steam_user_id_idx").on(t.userId),
        // D-13 cardinality (per Plan 02-05 multi-key choice): one row per labelled
        // Steamworks account. The partial UNIQUE on (user_id, label) WHERE deleted_at
        // IS NULL allows a soft-delete + re-add cycle to reuse the same label without
        // a hard collision.
        //
        // NOTE: api_keys_steam currently has NO deleted_at column (the schema above
        // hard-deletes via removeSteamKey per D-14 — there is no soft-delete path
        // for keys). Therefore the partial-WHERE clause MUST be omitted; the index
        // is just `UNIQUE(user_id, label)`. If a later phase adds a soft-delete
        // column for keys, change this to a partial index in the same migration.
        userLabelUnique: uniqueIndex("api_keys_steam_user_label_unq").on(t.userId, t.label),
      }),
    );
    ```

    **B-3 cardinality decision (recorded for executor):** Phase 2 implements **Option (a) — multi-key UI**
    per CONTEXT.md D-13 verbatim ("publisher with two Steamworks accounts" — one row per labelled
    Steamworks account, linked per-listing). The schema-level enforcement is the `UNIQUE(user_id, label)`
    index above; the service-layer pre-check lives in Plan 02-05 (`createSteamKey` returns
    `steam_key_label_exists` → 422 when the label is already taken); the UI ships a multi-row list
    view in Plan 02-10. Rationale for Option (a) over (b): D-13 is locked context; downgrading to
    single-key UI would amend CONTEXT.md, which is out of scope for a checker-revision iteration.

    **C. Create `src/lib/server/db/schema/game-steam-listings.ts`** (per D-10 + D-13):

    ```typescript
    // game_steam_listings — typed example for the per-store listing pattern (D-06, D-10).
    //
    // Multi-listing per game: a publisher's "HADES" entry can have a Demo
    // app_id, a Full app_id, a DLC app_id, and a Soundtrack app_id all
    // attached to the same logical games row. UNIQUE(game_id, app_id) and
    // UNIQUE(user_id, app_id) prevent dupes both within a game and across
    // games for the same user.
    //
    // api_key_id FK -> api_keys_steam.id is the "this listing's wishlist is
    // polled by this Steamworks key" link (D-13). Nullable because P2 ships
    // no polling worker — listings can exist before a key is saved; Phase 3
    // backfills the FK when the user adds a key.
    //
    // raw_appdetails jsonb stores the full Steam appdetails response for
    // forensics + future schema extraction (Phase 6 cache).

    import { pgTable, text, timestamp, integer, jsonb, unique, index } from "drizzle-orm/pg-core";
    import { user } from "./auth.js";
    import { games } from "./games.js";
    import { apiKeysSteam } from "./api-keys-steam.js";
    import { uuidv7 } from "../../ids.js";

    export const gameSteamListings = pgTable(
      "game_steam_listings",
      {
        id: text("id").primaryKey().$defaultFn(() => uuidv7()),
        userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
        gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
        appId: integer("app_id").notNull(),
        label: text("label").notNull().default(""),
        coverUrl: text("cover_url"),
        releaseDate: text("release_date"),
        comingSoon: text("coming_soon"),
        steamGenres: text("steam_genres").array().notNull().default([] as string[]),
        steamCategories: text("steam_categories").array().notNull().default([] as string[]),
        rawAppdetails: jsonb("raw_appdetails"),
        apiKeyId: text("api_key_id").references(() => apiKeysSteam.id, { onDelete: "set null" }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
      },
      (t) => ({
        userIdx: index("game_steam_listings_user_id_idx").on(t.userId),
        gameIdx: index("game_steam_listings_game_id_idx").on(t.gameId),
        gameAppIdUnique: unique("game_steam_listings_game_app_id_unq").on(t.gameId, t.appId),
        userAppIdUnique: unique("game_steam_listings_user_app_id_unq").on(t.userId, t.appId),
      }),
    );
    ```

    **D. Create `src/lib/server/db/schema/youtube-channels.ts`** (D-07; per Pitfall 3 — store handle_url, NOT channel_id-only):

    ```typescript
    // youtube_channels — typed example for the per-platform social-handle pattern (D-07).
    //
    // Lives at user level (NOT cascaded by game soft-delete per D-24). Two
    // ways the user can paste a channel: (a) handle URL like
    // https://youtube.com/@RickAstleyYT, (b) canonical channel URL like
    // https://youtube.com/channel/UC.... handle_url is ALWAYS set (the user-
    // pasted form); channel_id is set only if (b) was pasted OR a future
    // resolver fetches the canonical id. INGEST-03 own/blogger lookup
    // matches by handle_url against tracked_youtube_videos.author_url-
    // derived handle (Pitfall 3 / Option C in RESEARCH.md).
    //
    // is_own: true => videos from this channel auto-mark as own; false =>
    // blogger coverage. UI heuristic: first channel a user adds defaults
    // to is_own=true, subsequent default false (UX-SPEC §"/accounts/youtube").

    import { pgTable, text, timestamp, boolean, unique, index } from "drizzle-orm/pg-core";
    import { user } from "./auth.js";
    import { uuidv7 } from "../../ids.js";

    export const youtubeChannels = pgTable(
      "youtube_channels",
      {
        id: text("id").primaryKey().$defaultFn(() => uuidv7()),
        userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
        handleUrl: text("handle_url").notNull(),  // e.g. https://www.youtube.com/@RickAstleyYT
        channelId: text("channel_id"),             // e.g. UC...; nullable if user pasted handle only
        displayName: text("display_name"),
        isOwn: boolean("is_own").notNull().default(false),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
      },
      (t) => ({
        userIdx: index("youtube_channels_user_id_idx").on(t.userId),
        userHandleUnique: unique("youtube_channels_user_handle_unq").on(t.userId, t.handleUrl),
      }),
    );
    ```

    **E. Create `src/lib/server/db/schema/game-youtube-channels.ts`** (M:N link; D-07):

    ```typescript
    // game_youtube_channels — M:N link between games and youtube_channels (D-07).
    //
    // Soft-cascade with games: deleted_at inherits the parent games.deleted_at
    // value in one tx (D-23). The underlying youtube_channels row is NOT
    // cascaded (D-24) — channels live at user level and are reused.

    import { pgTable, text, timestamp, unique, index } from "drizzle-orm/pg-core";
    import { user } from "./auth.js";
    import { games } from "./games.js";
    import { youtubeChannels } from "./youtube-channels.js";
    import { uuidv7 } from "../../ids.js";

    export const gameYoutubeChannels = pgTable(
      "game_youtube_channels",
      {
        id: text("id").primaryKey().$defaultFn(() => uuidv7()),
        userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
        gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
        channelId: text("channel_id").notNull().references(() => youtubeChannels.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
      },
      (t) => ({
        userIdx: index("game_youtube_channels_user_id_idx").on(t.userId),
        gameIdx: index("game_youtube_channels_game_id_idx").on(t.gameId),
        gameChannelUnique: unique("game_youtube_channels_game_channel_unq").on(t.gameId, t.channelId),
      }),
    );
    ```

    **F. Create `src/lib/server/db/schema/tracked-youtube-videos.ts`** (D-09 verbatim spec):

    ```typescript
    // tracked_youtube_videos — typed example for the per-platform tracked-item pattern (D-09).
    //
    // Per D-09: two users registering the same video_id produce two
    // independent rows (different user_id). UNIQUE(user_id, video_id)
    // prevents the same user from registering the same video twice.
    //
    // last_polled_at + last_poll_status are populated by the Phase 3
    // worker; Phase 2 inserts NULL on both. UI surfaces "never polled"
    // for null. last_poll_status enum (Phase 3): 'ok' | 'auth_error' |
    // 'rate_limited' | 'not_found'. Phase 2 ships text-typed; Phase 3
    // tightens to a check or pgEnum.

    import { pgTable, text, timestamp, boolean, unique, index } from "drizzle-orm/pg-core";
    import { user } from "./auth.js";
    import { games } from "./games.js";
    import { uuidv7 } from "../../ids.js";

    export const trackedYoutubeVideos = pgTable(
      "tracked_youtube_videos",
      {
        id: text("id").primaryKey().$defaultFn(() => uuidv7()),
        userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
        gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
        videoId: text("video_id").notNull(),
        url: text("url").notNull(),
        title: text("title"),
        channelId: text("channel_id"),
        authorUrl: text("author_url"),  // e.g. https://www.youtube.com/@handle from oEmbed (Pitfall 3)
        isOwn: boolean("is_own").notNull().default(false),
        addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
        lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
        lastPollStatus: text("last_poll_status"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
      },
      (t) => ({
        userIdx: index("tracked_youtube_videos_user_id_idx").on(t.userId),
        userGameIdx: index("tracked_youtube_videos_user_id_game_id_idx").on(t.userId, t.gameId),
        userVideoIdUnique: unique("tracked_youtube_videos_user_video_id_unq").on(t.userId, t.videoId),
        // Phase 3 scheduler scan optimization — DEFERRED.
        //
        // W-4 DECISION (checker iter 1; Option B): the partial index
        // `idx_tracked_yt_videos_last_polled_at WHERE last_polled_at IS NOT NULL`
        // does NOT land in Phase 2. Rationale:
        //   - Phase 2 ships NO polling worker — `last_polled_at` is `NULL` on every
        //     row inserted in P2 (the field is populated only by the Phase 3
        //     poll.youtube worker). A partial index over an all-NULL column on day 1
        //     adds bloat without query benefit.
        //   - Drizzle 0.45 partial-index DSL support via `.where(sql\`...\`)` is
        //     unverified for our locked version (RESEARCH.md Open Question 2);
        //     deferring sidesteps the speculative DSL question entirely.
        //   - Adding the index in Phase 3 (alongside the worker that uses it) is
        //     the natural ship moment.
        //
        // Phase 3 backlog item (filed in ROADMAP Phase 3 entry by Plan 02-01):
        //   "TODO Phase 3: add partial index `idx_tracked_yt_videos_last_polled_at`
        //    WHERE last_polled_at IS NOT NULL (use raw SQL in a companion
        //    migration if Drizzle 0.45 .where() on index() doesn't emit cleanly)."
      }),
    );
    ```

    **W-4 follow-up for Plan 02-01:** the executor of Plan 02-01 MUST add the line above as a
    `TODO` bullet in ROADMAP.md's Phase 3 entry (under the success criteria, in a new
    `**Phase 3 deferred items:**` sub-bullet). This keeps the partial index visible to the
    Phase 3 planner without polluting Phase 2 schema. If Plan 02-01 has already shipped, file
    this as the FIRST item in Plan 02-03's SUMMARY notes so the ROADMAP edit lands in the
    same Phase 2 PR.

    **G. Create `src/lib/server/db/schema/events.ts`** (D-28, D-30):

    ```typescript
    // events — free-form timeline (D-27 separate from tracked_*_*).
    //
    // kind is a Postgres pgEnum (D-28) — closed picklist enforces invalid
    // values fail at INSERT, not at "we'll fix it Tuesday". Drizzle 0.45 +
    // drizzle-kit 0.31 emit CREATE TYPE + table CREATE in correct order
    // when the enum is `export`-ed (drizzle-team/drizzle-orm#5174).
    //
    // url is optional — used for twitter/telegram URL ingest (D-29);
    // notes is optional. occurred_at is the user-meaningful timestamp
    // (when the talk / post / drop happened); created_at is the row
    // insertion time.

    import { pgTable, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
    import { user } from "./auth.js";
    import { games } from "./games.js";
    import { uuidv7 } from "../../ids.js";

    // EXPORTED — drizzle-kit silently drops non-exported pgEnums (#5174).
    export const eventKindEnum = pgEnum("event_kind", [
      "conference",
      "talk",
      "twitter_post",
      "telegram_post",
      "discord_drop",
      "press",
      "other",
    ]);

    export const events = pgTable(
      "events",
      {
        id: text("id").primaryKey().$defaultFn(() => uuidv7()),
        userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
        gameId: text("game_id").notNull().references(() => games.id, { onDelete: "cascade" }),
        kind: eventKindEnum("kind").notNull(),
        occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
        title: text("title").notNull(),
        url: text("url"),
        notes: text("notes"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
        deletedAt: timestamp("deleted_at", { withTimezone: true }),
      },
      (t) => ({
        userIdx: index("events_user_id_idx").on(t.userId),
        userGameOccurredIdx: index("events_user_id_game_id_occurred_at_idx").on(t.userId, t.gameId, t.occurredAt),
      }),
    );
    ```

    **H. AMEND `src/lib/server/db/schema/audit-log.ts`** — convert action column to pgEnum. Keep all existing comments. The file becomes:

    ```typescript
    // (preserve existing top-of-file comment block from Phase 1)

    import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
    import { user } from "./auth.js";
    import { auditActionEnum } from "../../audit/actions.js";   // NEW: Phase 2 D-32
    import { uuidv7 } from "../../ids.js";

    export const auditLog = pgTable(
      "audit_log",
      {
        id: text("id").primaryKey().$defaultFn(() => uuidv7()),
        userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
        action: auditActionEnum("action").notNull(),    // CHANGED from text() to enum (D-32)
        ipAddress: text("ip_address").notNull(),
        userAgent: text("user_agent"),
        metadata: jsonb("metadata"),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      },
      (t) => ({
        userIdx: index("audit_log_user_id_idx").on(t.userId),
        userCreatedIdx: index("audit_log_user_id_created_at_idx").on(t.userId, t.createdAt),
        // NEW (Phase 2 D-32): action-filter dropdown queries (`WHERE user_id = ? AND action = ?`).
        userActionCreatedIdx: index("audit_log_user_id_action_created_at_idx").on(t.userId, t.action, t.createdAt),
      }),
    );
    ```

    **I. Create `src/lib/server/audit/actions.ts`** — single source of truth (D-32). Note: this file is read by `audit-log.ts` (for the pgEnum), the audit-read service (Plan 07), and the action-filter dropdown UI (Plan 10):

    ```typescript
    // Single source of truth for audit action vocabulary (D-32).
    //
    // The Postgres enum (`auditActionEnum`) is defined here; the schema
    // table file (audit-log.ts) imports it. This keeps the writable list
    // and the UI dropdown labels in lock-step — adding an action requires
    // touching ONE file, not three.
    //
    // Phase 1 contributed: session.signin, session.signout,
    // session.signout_all, user.signup. Phase 2 adds the rest per D-32.
    // Future phases (3 / 6) extend by ALTER TYPE ADD VALUE — Postgres
    // enum value REMOVAL is not first-class, so additions only.

    import { pgEnum } from "drizzle-orm/pg-core";

    export const AUDIT_ACTIONS = [
      // Phase 1
      "session.signin",
      "session.signout",
      "session.signout_all",
      "user.signup",
      // Phase 2 (D-32)
      "key.add",
      "key.rotate",
      "key.remove",
      "game.created",
      "game.deleted",
      "game.restored",
      "item.created",
      "item.deleted",
      "event.created",
      "event.edited",
      "event.deleted",
      "theme.changed",
    ] as const;

    export type AuditAction = (typeof AUDIT_ACTIONS)[number];

    // EXPORTED — drizzle-kit silently drops non-exported pgEnums (#5174).
    export const auditActionEnum = pgEnum("audit_action", AUDIT_ACTIONS);
    ```

    **J. AMEND `src/lib/server/db/schema/auth.ts`** — add `themePreference` column to `user` (D-40):

    Inside the existing `pgTable("user", { ... })` definition, after the `image` line, add:
    ```typescript
        themePreference: text("theme_preference").notNull().default("system"),
    ```

    Do NOT touch session / account / verification.

    **K. AMEND `src/lib/server/db/schema/index.ts`** to re-export the new files. Append (preserving sort order):
    ```typescript
    export * from "./games.js";
    export * from "./game-steam-listings.js";
    export * from "./youtube-channels.js";
    export * from "./game-youtube-channels.js";
    export * from "./api-keys-steam.js";
    export * from "./tracked-youtube-videos.js";
    export * from "./events.js";
    ```

    **L. AMEND `src/lib/server/config/env.ts`** — add `RETENTION_DAYS` (D-22). Inside the `RawSchema = z.object({ ... })`, after `LOG_LEVEL`, add:
    ```typescript
      RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(60),
    ```
    Then add `RETENTION_DAYS: raw.RETENTION_DAYS,` to the exported `env` object (preserve sort order).

    **M. AMEND `.env.example`** — append (after the last existing var):
    ```
    # Phase 2 — soft-delete retention window (days). Default: 60.
    # The Phase 3 purge worker hard-deletes rows where deleted_at < now() - RETENTION_DAYS::interval.
    # Self-host operators may set their own value; SaaS uses the default.
    RETENTION_DAYS=60
    ```
  </action>
  <verify>
    <automated>pnpm exec tsc --noEmit 2>&1 | tail -20 && node -e "const fs=require('fs');const files=['src/lib/server/db/schema/games.ts','src/lib/server/db/schema/game-steam-listings.ts','src/lib/server/db/schema/youtube-channels.ts','src/lib/server/db/schema/game-youtube-channels.ts','src/lib/server/db/schema/api-keys-steam.ts','src/lib/server/db/schema/tracked-youtube-videos.ts','src/lib/server/db/schema/events.ts','src/lib/server/audit/actions.ts'];for(const f of files){if(!fs.existsSync(f))throw 'missing '+f;}const idx=fs.readFileSync('src/lib/server/db/schema/index.ts','utf8');for(const t of ['games','game-steam-listings','youtube-channels','game-youtube-channels','api-keys-steam','tracked-youtube-videos','events']){if(!idx.includes('./'+t+'.js'))throw 'barrel missing '+t;}const env=fs.readFileSync('src/lib/server/config/env.ts','utf8');if(!env.includes('RETENTION_DAYS'))throw 'env.ts missing RETENTION_DAYS';const auth=fs.readFileSync('src/lib/server/db/schema/auth.ts','utf8');if(!auth.includes('themePreference'))throw 'auth.ts missing themePreference';console.log('ok')"</automated>
  </verify>
  <done>
    All 7 new schema files compile; barrel re-exports them; audit-log.ts imports auditActionEnum and types its action column; auth.ts has themePreference; env.ts has RETENTION_DAYS with default 60; .env.example documents it; AUDIT_ACTIONS const list contains exactly the 16 D-32 values in the right order.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Generate the migration SQL, hand-review the audit_log.action ALTER, run migrate, extend integration smoke test</name>
  <files>drizzle/0001_phase02_schema.sql, tests/integration/migrate.test.ts</files>
  <read_first>
    - drizzle.config.ts (Phase 1 drizzle-kit config — out path, schema glob, dialect)
    - drizzle/ directory listing (find the next sequential migration filename — Phase 1 ended at 0000_*.sql)
    - src/lib/server/db/migrate.ts (advisory-locked runMigrations runner; verifies Phase 2 migration applies cleanly under the same lock)
    - tests/integration/migrate.test.ts (existing migration test — extend to assert the 7 new tables exist post-migrate)
    - .planning/phases/02-ingest-secrets-and-audit/02-RESEARCH.md §"Drizzle 0.45 multi-table migrations atomicity" lines 444–466 (recipe + caveats) and §"Open Questions" 2 + 3 (audit_log.action ALTER review)
  </read_first>
  <behavior>
    1. `pnpm db:generate` produces ONE migration file named `drizzle/000X_<auto>.sql` (X is next sequential number — likely 0001 if Phase 1 ended at 0000). Rename it to `drizzle/0001_phase02_schema.sql` if drizzle-kit auto-named it.
    2. The generated SQL contains, in order: `CREATE TYPE event_kind`, `CREATE TYPE audit_action`, `CREATE TABLE games`, `CREATE TABLE api_keys_steam`, `CREATE TABLE game_steam_listings`, `CREATE TABLE youtube_channels`, `CREATE TABLE game_youtube_channels`, `CREATE TABLE tracked_youtube_videos`, `CREATE TABLE events`, `ALTER TABLE "user" ADD COLUMN "theme_preference"`, the audit_log.action conversion via ALTER COLUMN, and the new audit_log index on (user_id, action, created_at).
    3. The audit_log.action conversion is the load-bearing risk (Open Question 2 / 3). drizzle-kit may emit `ALTER COLUMN action TYPE audit_action;` without a `USING` clause — that fails because Postgres can't auto-cast text to a custom enum without a USING expression. Hand-edit the generated SQL: change `ALTER COLUMN action TYPE audit_action` to `ALTER COLUMN action TYPE audit_action USING action::audit_action`.
    4. The pre-existing audit_log rows (Phase 1 contributed: session.signin / signout / signout_all / user.signup) must still cast cleanly because all four are in `AUDIT_ACTIONS`. If a stray test fixture row carries a value not in the enum, the migration aborts — Wave 0 verifies via `SELECT DISTINCT action FROM audit_log` BEFORE running migrate (sentinel check inside the integration test).
    5. tests/integration/migrate.test.ts gains a new it() that asserts: `pg_tables` lists `games`, `api_keys_steam`, `game_steam_listings`, `youtube_channels`, `game_youtube_channels`, `tracked_youtube_videos`, `events`; `pg_type` lists `event_kind` and `audit_action`; `user.theme_preference` column exists; the new audit_log index exists.
  </behavior>
  <action>
    **A. Generate the migration:**
    ```bash
    pnpm db:generate
    ```
    Inspect the generated file. It will be in `drizzle/` (filename auto-assigned by drizzle-kit; rename to `0001_phase02_schema.sql` if needed for predictability — keep the journal entry consistent). Commit the file as-is unless the audit_log.action ALTER is missing the USING clause (very likely per RESEARCH.md Open Question 2).

    **B. Hand-edit the generated SQL** — find the line:
    ```sql
    ALTER TABLE "audit_log" ALTER COLUMN "action" TYPE audit_action;
    ```
    Replace with:
    ```sql
    ALTER TABLE "audit_log" ALTER COLUMN "action" TYPE audit_action USING action::audit_action;
    ```

    **C. Pre-flight sanity** — run `pnpm db:check` to confirm no commutativity issues. If drizzle-kit complains that the journal `_journal.json` is dirty, re-run generate after a clean.

    **D. Apply the migration** by running the integration test which boots the migrate runner under the advisory lock:
    ```bash
    pnpm test:integration tests/integration/migrate.test.ts
    ```

    **E. EXTEND `tests/integration/migrate.test.ts`** — append these assertions inside the existing `describe(...)` (or add a new describe block):

    ```typescript
    import { describe, it, expect, beforeAll } from "vitest";
    import { db, pool } from "../../src/lib/server/db/client.js";
    import { runMigrations } from "../../src/lib/server/db/migrate.js";

    describe("Phase 2 schema migration (Plan 02-03)", () => {
      beforeAll(async () => {
        await runMigrations();
      });

      it("creates the 7 new Phase 2 tables", async () => {
        const expected = [
          "games",
          "game_steam_listings",
          "youtube_channels",
          "game_youtube_channels",
          "api_keys_steam",
          "tracked_youtube_videos",
          "events",
        ];
        const result = await pool.query(
          `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename = ANY($1)`,
          [expected],
        );
        const found = result.rows.map((r) => r.tablename).sort();
        expect(found).toEqual(expected.slice().sort());
      });

      it("creates event_kind and audit_action pgEnums", async () => {
        const result = await pool.query(
          `SELECT typname FROM pg_type WHERE typname IN ('event_kind', 'audit_action')`,
        );
        const found = result.rows.map((r) => r.typname).sort();
        expect(found).toEqual(["audit_action", "event_kind"]);
      });

      it("audit_log.action is now of type audit_action (not text)", async () => {
        const result = await pool.query(
          `SELECT data_type, udt_name FROM information_schema.columns WHERE table_name='audit_log' AND column_name='action'`,
        );
        expect(result.rows[0]?.udt_name).toBe("audit_action");
      });

      it("user.theme_preference column exists with default 'system'", async () => {
        const result = await pool.query(
          `SELECT column_default FROM information_schema.columns WHERE table_name='user' AND column_name='theme_preference'`,
        );
        expect(result.rows[0]?.column_default).toMatch(/system/);
      });

      it("audit_log gains user_id+action+created_at index for filter-by-action queries", async () => {
        const result = await pool.query(
          `SELECT indexname FROM pg_indexes WHERE tablename='audit_log' AND indexname='audit_log_user_id_action_created_at_idx'`,
        );
        expect(result.rows.length).toBe(1);
      });

      it("Phase 1 audit rows survive the action-column type conversion", async () => {
        const result = await pool.query(
          `SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('session.signin','session.signout','session.signout_all','user.signup')`,
        );
        // n is whatever Phase 1 left (could be 0 in clean test DBs); assertion
        // only validates the query succeeds, i.e. the cast did not corrupt rows.
        expect(typeof result.rows[0]?.n).toBeDefined();
      });
    });
    ```
  </action>
  <verify>
    <automated>pnpm test:integration tests/integration/migrate.test.ts --reporter=verbose 2>&1 | tail -40</automated>
  </verify>
  <done>
    - `drizzle/0001_phase02_schema.sql` exists; contains `CREATE TYPE event_kind`, `CREATE TYPE audit_action`, 7 `CREATE TABLE` statements, `ALTER TABLE "user" ADD COLUMN "theme_preference"`, and `ALTER TABLE "audit_log" ALTER COLUMN "action" TYPE audit_action USING action::audit_action`.
    - `pnpm db:check` exits 0.
    - The migrate.test.ts suite passes all 6 assertions above (4 schema-creation + 1 audit_log conversion + 1 Phase 1 audit row survival).
    - Boot-time `runMigrations()` applies the migration once under the advisory lock; subsequent boots are no-ops (Phase 1 idempotency invariant unchanged).
  </done>
</task>

</tasks>

<verification>
- `pnpm exec tsc --noEmit` is clean.
- `pnpm db:generate` produces no diff (schema and migration are in sync).
- `pnpm db:check` exits 0.
- `pnpm test:integration tests/integration/migrate.test.ts` is green.
- Hand-edit verification: `grep -c "USING action::audit_action" drizzle/0001_phase02_schema.sql` == 1 (the audit_log conversion).
- `grep -c "RETENTION_DAYS" .env.example` == 1.
</verification>

<success_criteria>
- 7 new schema files compile and re-export through `src/lib/server/db/schema/index.ts`.
- audit_log.action is a pgEnum typed by `auditActionEnum`; the const list `AUDIT_ACTIONS` is the single source of truth.
- user.theme_preference text column exists with default 'system'.
- env.ts exposes RETENTION_DAYS (default 60); .env.example documents it.
- One generated migration `drizzle/0001_phase02_schema.sql` applies cleanly under the existing advisory lock; the audit_log.action conversion uses `USING action::audit_action`.
- Migration integration test passes 6 assertions including Phase 1 audit row survival.
- ESLint TENANT_TABLES set (Plan 02-02) matches the 8 tenant-owned tables now in the schema (the rule will start firing on real services from Plan 04 onward).
</success_criteria>

<output>
After completion, create `.planning/phases/02-ingest-secrets-and-audit/02-03-SUMMARY.md` covering:
1. The exact filename drizzle-kit assigned to the migration (rename if needed).
2. Whether the audit_log.action ALTER required the manual `USING` patch (almost certainly yes per RESEARCH.md Open Question 2).
3. Confirmation that the partial-index `WHERE last_polled_at IS NOT NULL` made it through drizzle-kit, or required a hand-edit to the SQL.
4. The 16 AUDIT_ACTIONS values committed (verbatim).
</output>
