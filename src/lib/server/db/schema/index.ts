// Barrel re-export so `import * as schema from './schema/index.js'` covers
// every table in the codebase. Drizzle's `drizzle(pool, { schema })` consumes
// this shape to provide typed query builders.

export * from "./auth.js";
export * from "./audit-log.js";
// Order is alphabetical within the active block; FK dependency order is
// resolved by drizzle-kit at generate time via `references()`.
export * from "./api-keys-steam.js";
export * from "./data-source-channel-state.js";
export * from "./data-sources.js";
export * from "./event-games.js";
export * from "./events.js";
export * from "./game-steam-listings.js";
export * from "./games.js";
// Transactional outbox.
export * from "./outbox.js";
// YouTube schemas live in the per-source folder. Re-exported here so
// existing call sites (`import { youtubeVideos } from
// "$lib/server/db/schema/index.js"`) continue to compile without edit.
export * from "$lib/sources/youtube/server/schema/index.js";
