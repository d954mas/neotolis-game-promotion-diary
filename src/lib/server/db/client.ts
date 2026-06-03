// Single pg.Pool + Drizzle ORM client for the application process.
//
// Pool sizing is APP_ROLE-aware (three-role single image): the `app`
// role serves HTTP requests so it gets the largest pool; `worker` consumes
// jobs concurrently but still less than the app; `scheduler` only enqueues
// jobs on a cron and barely touches the DB. pg-boss runs against its own
// pool (passes `connectionString` to `new PgBoss()` directly) — that keeps
// queue traffic from contending with app-data traffic for connections.
//
// Tuned for a small VPS where Postgres `max_connections` is ~100 by default
// and we want headroom for backups, manual psql, and future replicas.

import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

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

// node-postgres emits 'error' on an IDLE pooled client whose backend connection
// drops (DB restart, network blip, server-side idle kill). Without a listener pg
// re-throws it as an uncaughtException — crashing the process for an event the
// pool already recovers from (it discards the dead client; the next checkout
// opens a fresh one). Log and let the pool heal. An ACTIVE query's error still
// rejects that query's promise as before — this covers only idle clients.
pool.on("error", (err) => {
  logger.error({ err }, "pg idle client error — pool will discard and reconnect");
});

export const db = drizzle(pool, { schema });

export type DB = typeof db;
/** Inner-tx handle as Drizzle exposes it to a `.transaction(async (tx) => …)` callback. */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
/** Either the live db handle or an inner tx — for helpers that don't care which. */
export type DbOrTx = DB | Tx;
