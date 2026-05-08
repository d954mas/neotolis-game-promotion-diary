// YouTube per-source schema barrel — Phase 03.0.1 D-14.
// The cross-source barrel src/lib/server/db/schema/index.ts re-exports
// from this barrel. Drizzle config glob picks up these files directly,
// but the cross-source barrel re-export keeps existing
// `import { youtubeVideos } from "$lib/server/db/schema/index.js"`
// call sites compiling without edit.
export * from "./channels.js";
export * from "./metadata-fetch-log.js";
export * from "./service-quota-usage.js";
export * from "./video-snapshots.js";
export * from "./videos.js";
