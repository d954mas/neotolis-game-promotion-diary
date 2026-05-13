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

import { env } from "./lib/server/config/env.js";
import { logger } from "./lib/server/logger.js";
import { runMigrations } from "./lib/server/db/migrate.js";

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
