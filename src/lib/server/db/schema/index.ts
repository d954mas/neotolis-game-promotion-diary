// Barrel re-export so `import * as schema from './schema/index.js'` covers
// every table in the codebase. Drizzle's `drizzle(pool, { schema })` consumes
// this shape to provide typed query builders.

export * from "./auth.js";
export * from "./audit-log.js";
