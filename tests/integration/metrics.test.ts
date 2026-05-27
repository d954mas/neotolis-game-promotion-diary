import { describe, it, expect } from "vitest";
import { createApp } from "../../src/lib/server/http/app.js";

describe("GET /metrics", () => {
  const app = createApp();

  it("returns 200 with Prometheus text format", async () => {
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") || "";
    // prom-client returns either text/plain or application/openmetrics-text
    expect(contentType).toMatch(/text\/plain|openmetrics/);
  });

  it("contains HTTP request metrics", async () => {
    const res = await app.request("/metrics");
    const body = await res.text();
    expect(body).toContain("neotolis_http_requests_total");
    expect(body).toContain("neotolis_http_request_duration_seconds");
  });

  it("contains Node.js runtime metrics", async () => {
    const res = await app.request("/metrics");
    const body = await res.text();
    expect(body).toContain("neotolis_process_resident_memory_bytes");
    expect(body).toContain("neotolis_nodejs_eventloop_lag_seconds");
  });

  it("contains pg-boss queue depth metrics", async () => {
    const res = await app.request("/metrics");
    const body = await res.text();
    // Queue depth gauge should be present (even if zero)
    expect(body).toContain("neotolis_pgboss_queue_depth");
  });

  it("is unauthenticated (no session required)", async () => {
    // /metrics must be accessible without a session — same as /healthz and /readyz.
    // This is a design decision per D-03/D-04: Docker network isolation is the
    // access control, not auth middleware.
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
  });
});
