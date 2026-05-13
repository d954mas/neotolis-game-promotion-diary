import { defineConfig } from "drizzle-kit";

// drizzle-kit is a dev-only tool that runs at generate/migrate-check time only
// (never in the production runtime). It is the one approved exception to the
// "src/lib/server/config/env.ts is the sole reader of process.env" rule.
//
// Schema glob discovers per-source schemas under
// src/lib/sources/*/server/schema/ in addition to the cross-source schemas
// in src/lib/server/db/schema/. Both globs are walked; drizzle-kit
// deduplicates by table name (first arg to pgTable).
export default defineConfig({
  schema: ["./src/lib/server/db/schema/*.ts", "./src/lib/sources/*/server/schema/*.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // eslint-disable-next-line no-restricted-properties -- drizzle-kit is dev-only and runs outside the app process
    url: process.env.DATABASE_URL ?? "postgres://localhost/dev",
  },
});
