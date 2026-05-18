import { defineConfig } from "drizzle-kit";

// drizzle-kit is a dev-only tool that runs at generate/migrate-check time only
// (never in the production runtime). It is the one approved exception to the
// "src/lib/server/config/env.ts is the sole reader of process.env" rule.
//
// The schema barrel re-exports cross-source tables plus per-source schemas.
// Keeping drizzle-kit on one entrypoint avoids duplicate table discovery when
// shared schemas are imported through both cross-source and adapter modules.
export default defineConfig({
  schema: ["./src/lib/server/db/schema/index.ts"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // eslint-disable-next-line no-restricted-properties -- drizzle-kit is dev-only and runs outside the app process
    url: process.env.DATABASE_URL ?? "postgres://localhost/dev",
  },
});
