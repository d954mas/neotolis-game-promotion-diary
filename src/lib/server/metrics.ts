// Prometheus metrics module for the app role.
//
// Per D-04, /metrics is a Hono route on the app container. Worker and
// scheduler roles do NOT initialize prom-client (RESEARCH Anti-Pattern 1:
// importing this module in those roles would register duplicate default
// metrics and corrupt the shared pgboss schema).
//
// The registry is intentionally separate from the global default so
// multiple test-mode createApp() calls don't collide on metric names.

import { Registry, collectDefaultMetrics, Histogram, Counter, Gauge } from "prom-client";

export const register = new Registry();

// Node.js runtime metrics: process_cpu_*, process_resident_memory_bytes,
// nodejs_eventloop_lag_seconds, nodejs_active_handles_total,
// nodejs_heap_size_*, nodejs_gc_duration_seconds, etc.
collectDefaultMetrics({
  register,
  prefix: "neotolis_",
  eventLoopMonitoringPrecision: 10,
});

// HTTP request duration histogram (p50/p95/p99 derivable from buckets)
export const httpRequestDuration = new Histogram({
  name: "neotolis_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  // Buckets tuned for a web app: most requests < 100ms, alert on > 2s
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

// HTTP request counter (for RPS calculation via rate())
export const httpRequestTotal = new Counter({
  name: "neotolis_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [register],
});

// pg-boss queue depth gauge (collected on /metrics scrape)
export const queueDepth = new Gauge({
  name: "neotolis_pgboss_queue_depth",
  help: "Number of jobs in pg-boss queue by state",
  labelNames: ["queue", "state"] as const,
  registers: [register],
});
