// APP_ROLE dispatcher entrypoint.
//
// One Docker image; ENTRYPOINT is `node build/server.js`. The dispatcher
// switches on env.APP_ROLE and starts:
//   - app       → src/roles/app.ts (Hono+SvelteKit HTTP server)
//   - worker    → src/worker/index.ts (pg-boss worker)
//   - scheduler → src/scheduler/index.ts (pg-boss scheduler)
//
// Migrations run BEFORE the role-specific entrypoint so worker/scheduler
// containers also fail fast on schema drift, and so /readyz semantics hold
// for the app role.

// Side-effect import: sets DNS IPv4-first resolution at process boot.
// Must run before any outbound fetch happens; placing it ahead of the
// env / logger imports keeps the resolver order set even if a downstream
// module fires an outbound fetch at module-load time.
import "./lib/server/integrations/dns-bootstrap.js";
import { env } from "./lib/server/config/env.js";
import { logger } from "./lib/server/logger.js";
import { registerCrashHandlers } from "./lib/server/crash-handlers.js";
import { runMigrations } from "./lib/server/db/migrate.js";

// Register the global crash handlers. Boot-path rejections (e.g. inside
// runMigrations) propagate through main() and are caught by main().catch()
// below; these handlers cover the cases that bypass it — a synchronous
// uncaughtException anywhere, and floating/un-awaited promise rejections
// after boot — so they're logged as structured JSON (Pino fatal) instead of
// a raw Node stack trace that bypasses the log pipeline. Registered early so
// even a startup crash outside main()'s await chain is captured.
registerCrashHandlers();

async function main(): Promise<void> {
  // Every role runs migrations (idempotent, advisory-locked).
  await runMigrations();

  switch (env.APP_ROLE) {
    case "app": {
      const { start } = await import("./roles/app.js");
      return start();
    }
    case "worker": {
      const { startWorker } = await import("./worker/index.js");
      return startWorker();
    }
    case "scheduler": {
      const { startScheduler } = await import("./scheduler/index.js");
      return startScheduler();
    }
    default: {
      logger.fatal({ role: env.APP_ROLE }, "unknown APP_ROLE");
      process.exit(1);
    }
  }
}

main().catch((err) => {
  logger.fatal({ err }, "boot failed");
  process.exit(1);
});
