// Barrel re-export so `import * as schema from './schema/index.js'` covers
// every table in the codebase. Drizzle's `drizzle(pool, { schema })` consumes
// this shape to provide typed query builders.

export * from "./auth.js";
export * from "./audit-log.js";
// Phase 2.1 (Plan 02.1-01): unified data-sources + extended events table replace
// the per-platform youtube_channels / tracked_youtube_videos / game_youtube_channels
// trio. Order is alphabetical within the active block; FK dependency order is
// resolved by drizzle-kit at generate time via `references()`.
export * from "./api-keys-steam.js";
export * from "./data-sources.js";
export * from "./event-games.js";
export * from "./events.js";
export * from "./game-steam-listings.js";
export * from "./games.js";
// Phase 3.0 Plan 01 — public-data tables (no user_id columns; ESLint
// TENANT_TABLES allowlist mirrors). One module per table per RESEARCH.md
// "Architecture Patterns" — keeps drizzle-kit's schema scan unambiguous.
export * from "./youtube-channels.js";
export * from "./youtube-metadata-fetch-log.js";
export * from "./youtube-service-quota-usage.js";
export * from "./youtube-video-snapshots.js";
export * from "./youtube-videos.js";
