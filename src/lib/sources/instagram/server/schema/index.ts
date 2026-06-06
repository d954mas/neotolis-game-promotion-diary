// Instagram per-source schema barrel.
// The cross-source barrel src/lib/server/db/schema/index.ts re-exports from
// this barrel. Drizzle config glob picks up these files directly, but the
// cross-source barrel re-export keeps existing
// `import { instagramPosts } from "$lib/server/db/schema/index.js"` call sites
// compiling without edit.
export * from "./posts.js";
export * from "./post-snapshots.js";
export * from "./provider-spend.js";
