import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MONITORING_ROOT = join(process.cwd(), "monitoring");
const GRAFANA_PROV = join(MONITORING_ROOT, "grafana", "provisioning");

describe("monitoring config structural validation", () => {
  // Prometheus
  describe("prometheus/prometheus.yml", () => {
    const content = readFileSync(join(MONITORING_ROOT, "prometheus", "prometheus.yml"), "utf8");
    it("targets app:3000", () => {
      expect(content).toContain("app:3000");
    });
    it("scrape interval is 15s", () => {
      expect(content).toContain("scrape_interval: 15s");
    });
    it("metrics_path is /metrics", () => {
      expect(content).toContain("metrics_path: /metrics");
    });
  });

  // Loki
  describe("loki/loki-config.yml", () => {
    const content = readFileSync(join(MONITORING_ROOT, "loki", "loki-config.yml"), "utf8");
    it("retention period is 168h", () => {
      expect(content).toContain("retention_period: 168h");
    });
    it("uses filesystem storage", () => {
      expect(content).toContain("store: tsdb");
    });
  });

  // Promtail
  describe("promtail/promtail-config.yml", () => {
    const content = readFileSync(join(MONITORING_ROOT, "promtail", "promtail-config.yml"), "utf8");
    it("uses Docker service discovery", () => {
      expect(content).toContain("docker_sd_configs");
    });
    it("filters to neotolis compose project only", () => {
      expect(content).toContain("com_docker_compose_project");
    });
    it("pushes to Loki", () => {
      expect(content).toContain("http://loki:3100/loki/api/v1/push");
    });
  });

  // Grafana datasources
  describe("grafana datasources", () => {
    const content = readFileSync(join(GRAFANA_PROV, "datasources", "datasources.yml"), "utf8");
    it("defines Prometheus datasource", () => {
      expect(content).toContain("type: prometheus");
      expect(content).toContain("http://prometheus:9090");
    });
    it("defines Loki datasource", () => {
      expect(content).toContain("type: loki");
      expect(content).toContain("http://loki:3100");
    });
  });

  // Grafana dashboards
  describe("grafana dashboard provider", () => {
    const content = readFileSync(join(GRAFANA_PROV, "dashboards", "dashboards.yml"), "utf8");
    it("points to provisioning/dashboards directory", () => {
      expect(content).toContain("/etc/grafana/provisioning/dashboards");
    });
  });

  describe("neotolis-overview dashboard", () => {
    const dashboard = JSON.parse(
      readFileSync(join(GRAFANA_PROV, "dashboards", "neotolis-overview.json"), "utf8"),
    );
    it("has correct uid", () => {
      expect(dashboard.uid).toBe("neotolis-overview");
    });
    it("has at least 8 panels", () => {
      expect(dashboard.panels.length).toBeGreaterThanOrEqual(8);
    });
    it("references neotolis_http_requests_total (RPS)", () => {
      const json = JSON.stringify(dashboard);
      expect(json).toContain("neotolis_http_requests_total");
    });
    it("references neotolis_http_request_duration_seconds_bucket (latency)", () => {
      const json = JSON.stringify(dashboard);
      expect(json).toContain("neotolis_http_request_duration_seconds_bucket");
    });
    it("references neotolis_process_resident_memory_bytes (RSS)", () => {
      const json = JSON.stringify(dashboard);
      expect(json).toContain("neotolis_process_resident_memory_bytes");
    });
    it("references neotolis_pgboss_queue_depth (queues)", () => {
      const json = JSON.stringify(dashboard);
      expect(json).toContain("neotolis_pgboss_queue_depth");
    });
  });

  describe("neotolis-logs dashboard", () => {
    const dashboard = JSON.parse(
      readFileSync(join(GRAFANA_PROV, "dashboards", "neotolis-logs.json"), "utf8"),
    );
    it("has correct uid", () => {
      expect(dashboard.uid).toBe("neotolis-logs");
    });
    it("has at least 2 panels", () => {
      expect(dashboard.panels.length).toBeGreaterThanOrEqual(2);
    });
  });

  // Grafana alerting
  describe("grafana alert rules", () => {
    const content = readFileSync(join(GRAFANA_PROV, "alerting", "alert-rules.yml"), "utf8");
    it("defines error-rate-spike rule", () => {
      expect(content).toContain("error-rate-spike");
    });
    it("defines high-latency-p95 rule", () => {
      expect(content).toContain("high-latency-p95");
    });
    it("defines memory-pressure rule", () => {
      expect(content).toContain("memory-pressure");
    });
  });

  describe("grafana contact points", () => {
    const content = readFileSync(join(GRAFANA_PROV, "alerting", "contact-points.yml"), "utf8");
    it("uses webhook type", () => {
      expect(content).toContain("type: webhook");
    });
    it("references ALERT_WEBHOOK_URL", () => {
      expect(content).toContain("ALERT_WEBHOOK_URL");
    });
  });

  describe("grafana notification policies", () => {
    const content = readFileSync(
      join(GRAFANA_PROV, "alerting", "notification-policies.yml"),
      "utf8",
    );
    it("routes to webhook-alerts receiver", () => {
      expect(content).toContain("receiver: webhook-alerts");
    });
  });

  // Docker compose overlay
  describe("docker-compose.monitoring.yml", () => {
    const content = readFileSync(join(process.cwd(), "docker-compose.monitoring.yml"), "utf8");
    it("pins Prometheus v3.x (not :latest)", () => {
      expect(content).toContain("prom/prometheus:v3.");
      expect(content).not.toContain("prom/prometheus:latest");
    });
    it("pins all image versions", () => {
      expect(content).toContain("grafana/loki:3.");
      expect(content).toContain("grafana/grafana:12.");
      expect(content).toContain("grafana/promtail:3.");
    });
    it("uses external network", () => {
      expect(content).toContain("external: true");
    });
  });
});
