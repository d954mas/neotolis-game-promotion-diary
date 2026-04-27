// Single pg.Pool + Drizzle ORM client for the application process.
//
// Pool sizing is APP_ROLE-aware (D-01 three-role single image): the `app`
// role serves HTTP requests so it gets the largest pool; `worker` consumes
// jobs concurrently but still less than the app; `scheduler` only enqueues
// jobs on a cron and barely touches the DB. pg-boss runs against its own
// pool (Plan 08 passes `connectionString` to `new PgBoss()` directly) — that
// keeps queue traffic from contending with app-data traffic for connections.
//
// Tuned for a small VPS where Postgres `max_connections` is ~100 by default
// and we want headroom for backups, manual psql, and future replicas.

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";
import { env } from "../config/env.js";

const POOL_MAX_BY_ROLE: Record<typeof env.APP_ROLE, number> = {
  app: 10,
  worker: 4,
  scheduler: 2,
};

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: POOL_MAX_BY_ROLE[env.APP_ROLE],
  idleTimeoutMillis: 30_000,
});

export const db = drizzle(pool, { schema });

export type DB = typeof db;
