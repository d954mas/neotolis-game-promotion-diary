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

export const activeUsers24h = new Gauge({
  name: "neotolis_active_users_24h",
  help: "Distinct logged-in users with session activity in last 24h",
  registers: [register],
});

export const adapterQuotaUsed24h = new Gauge({
  name: "neotolis_adapter_quota_used_24h",
  help: "API quota units consumed by adapter in last 24h",
  labelNames: ["adapter"] as const,
  registers: [register],
});

export const adapterJobsDone24h = new Gauge({
  name: "neotolis_adapter_jobs_done_24h",
  help: "Adapter refresh jobs completed in last 24h",
  labelNames: ["adapter", "type"] as const,
  registers: [register],
});

// Social-provider seam collectors (OBS-01 / D-24). Every request through the
// provider HTTP wrapper (instagram/server/http.ts) emits a request counter +
// latency histogram labeled platform/provider/status, and a credits counter
// labeled platform/provider. These are the operator's visibility into the
// prepaid scraper-credit spend and per-platform request health.
export const socialProviderRequests = new Counter({
  name: "neotolis_social_provider_requests_total",
  help: "Social provider HTTP requests",
  labelNames: ["platform", "provider", "status"] as const,
  registers: [register],
});

export const socialProviderRequestDuration = new Histogram({
  name: "neotolis_social_provider_request_duration_seconds",
  help: "Social provider request latency",
  labelNames: ["platform", "provider", "status"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [register],
});

export const socialProviderCredits = new Counter({
  name: "neotolis_social_provider_credits_total",
  help: "Social provider credits consumed",
  labelNames: ["platform", "provider"] as const,
  registers: [register],
});

export async function collectAdapterStats(pool: Pool): Promise<void> {
  const dau = await pool.query<{ count: string }>(
    `SELECT COUNT(DISTINCT user_id)::int AS count
     FROM session
     WHERE updated_at > NOW() - INTERVAL '24 hours'
       AND expires_at > NOW()`,
  );
  activeUsers24h.set(Number(dau.rows[0]?.count ?? 0));

  const ytQuota = await pool.query<{ units: string }>(
    `SELECT COALESCE(SUM(estimated_units), 0)::int AS units
     FROM youtube_service_quota_usage
     WHERE date_pacific = (NOW() AT TIME ZONE 'America/Los_Angeles')::date`,
  );
  adapterQuotaUsed24h.set({ adapter: "youtube" }, Number(ytQuota.rows[0]?.units ?? 0));

  const redditQuota = await pool.query<{ units: string }>(
    `SELECT COALESCE(SUM((metadata->>'entries_processed')::int), 0) AS units
     FROM audit_log
     WHERE action = 'reddit.queue_drained'
       AND created_at > NOW() - INTERVAL '24 hours'`,
  );
  adapterQuotaUsed24h.set({ adapter: "reddit" }, Number(redditQuota.rows[0]?.units ?? 0));

  const jobs = await pool.query<{ adapter_kind: string; type: string; count: string }>(
    `SELECT adapter_kind, type, COUNT(*)::int AS count
     FROM adapter_refresh_queue
     WHERE status = 'done'
       AND last_attempt_at >= NOW() - INTERVAL '24 hours'
     GROUP BY adapter_kind, type`,
  );
  const ADAPTER_LABELS: Record<string, string> = {
    youtube_channel: "youtube",
    reddit_account: "reddit",
  };
  adapterJobsDone24h.reset();
  for (const row of jobs.rows) {
    const adapter = ADAPTER_LABELS[row.adapter_kind];
    if (!adapter) continue;
    adapterJobsDone24h.set({ adapter, type: row.type }, Number(row.count));
  }
}

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
