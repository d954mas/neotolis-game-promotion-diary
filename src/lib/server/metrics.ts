// App-role only. Worker/scheduler must NOT import this module — they
// don't serve HTTP and would register duplicate default metrics.
// Separate Registry so multiple createApp() calls in tests don't collide.

import { Registry, collectDefaultMetrics, Histogram, Counter, Gauge } from "prom-client";
import type { Pool } from "pg";

export const register = new Registry();

collectDefaultMetrics({
  register,
  prefix: "neotolis_",
  eventLoopMonitoringPrecision: 10,
});

export const httpRequestDuration = new Histogram({
  name: "neotolis_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const httpRequestTotal = new Counter({
  name: "neotolis_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [register],
});

export const queueDepth = new Gauge({
  name: "neotolis_pgboss_queue_depth",
  help: "Number of jobs in pg-boss queue by state",
  labelNames: ["queue", "state"] as const,
  registers: [register],
});

// Direct SQL against pgboss schema — avoids lazy-boot dependency on the
// boss singleton (worker may not be running in the app role).
export async function collectQueueDepths(
  pool: Pool,
): Promise<Record<string, { queued: number; active: number }>> {
  const result = await pool.query<{
    name: string;
    queued_count: string;
    active_count: string;
  }>("SELECT name, queued_count, active_count FROM pgboss.queue");

  const queues: Record<string, { queued: number; active: number }> = {};
  for (const row of result.rows) {
    queues[row.name] = {
      queued: Number(row.queued_count),
      active: Number(row.active_count),
    };
  }
  return queues;
}
