import { describe, it, expect } from "vitest";
import { createApp } from "../../src/lib/server/http/app.js";

const TOKEN = process.env.METRICS_BEARER_TOKEN!;

describe("GET /metrics", () => {
  it("returns 404 with wrong bearer token", async () => {
    const app = createApp();
    const res = await app.request("/metrics", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 with correct bearer token", async () => {
    const app = createApp();
    const res = await app.request("/metrics", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") || "";
    expect(contentType).toMatch(/text\/plain|openmetrics/);
  });

  it("contains HTTP request metrics", async () => {
    const app = createApp();
    const res = await app.request("/metrics", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = await res.text();
    expect(body).toContain("neotolis_http_requests_total");
    expect(body).toContain("neotolis_http_request_duration_seconds");
  });

  it("contains Node.js runtime metrics", async () => {
    const app = createApp();
    const res = await app.request("/metrics", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = await res.text();
    expect(body).toContain("neotolis_process_resident_memory_bytes");
    expect(body).toContain("neotolis_nodejs_eventloop_lag_seconds");
  });

  it("contains pg-boss queue depth metrics", async () => {
    const app = createApp();
    const res = await app.request("/metrics", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = await res.text();
    expect(body).toContain("neotolis_pgboss_queue_depth");
  });
});
