// Grafana production audit — collects Prometheus metrics, Loki log stats,
// dashboard screenshots, and alert state via headed Playwright browser.
//
// Run:  node scripts/grafana-audit.mjs [grafana_url]
//
// Default URL: https://neotolis-diary.dev/grafana
// The browser opens for login, then auto-collects everything.
// Output: scripts/grafana-audit-output/ (JSON report + PNG screenshots)

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openGrafana } from "./lib/grafana-session.mjs";

const GRAFANA_URL = process.argv[2] || "https://neotolis-diary.dev/grafana";
const OUT_DIR = "scripts/grafana-audit-output";
mkdirSync(OUT_DIR, { recursive: true });

async function fetchJson(page, url) {
  return page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "include" });
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) };
    } catch {
      return { status: r.status, body: null, nonJson: text.slice(0, 200) };
    }
  }, url);
}

async function promQuery(page, expr) {
  const url = `${GRAFANA_URL}/api/datasources/proxy/uid/prometheus/api/v1/query?query=${encodeURIComponent(expr)}`;
  const { status, body } = await fetchJson(page, url);
  if (status !== 200) return { error: status };
  return body.data?.result ?? [];
}

async function promRangeQuery(page, expr, rangeSeconds = 86400, step = 300) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - rangeSeconds;
  const url = `${GRAFANA_URL}/api/datasources/proxy/uid/prometheus/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${start}&end=${now}&step=${step}`;
  const { status, body } = await fetchJson(page, url);
  if (status !== 200) return { error: status };
  return body.data?.result ?? [];
}

async function lokiLabelValues(page, label) {
  const url = `${GRAFANA_URL}/api/datasources/proxy/uid/loki/loki/api/v1/label/${label}/values`;
  const { status, body } = await fetchJson(page, url);
  return status === 200 ? body.data : [];
}

// Counts MATCHED lines via count_over_time. Do not report the query stats'
// totalLinesProcessed — that is how many lines the engine scanned, not how
// many matched, and it inflates with every broad line filter.
async function lokiCount(page, expr, rangeSeconds = 86400) {
  const now = Math.floor(Date.now() / 1000);
  const q = `sum(count_over_time(${expr} [${rangeSeconds}s]))`;
  const url = `${GRAFANA_URL}/api/datasources/proxy/uid/loki/loki/api/v1/query?query=${encodeURIComponent(q)}&time=${now}`;
  const { status, body } = await fetchJson(page, url);
  if (status !== 200) return { error: status };
  return Number(body.data?.result?.[0]?.value?.[1] ?? 0);
}

// Per-service log volume over time — feeds the "Log Volume by Service" panel.
// Returns each service's peak count_over_time bucket so we can spot spikes.
async function lokiVolumeByService(page, services, rangeSeconds = 86400, step = 300) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - rangeSeconds;
  const expr = `sum by (service) (count_over_time({service=~"${services.join("|")}"}[${step}s]))`;
  const url = `${GRAFANA_URL}/api/datasources/proxy/uid/loki/loki/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${start}000000000&end=${now}000000000&step=${step}`;
  const { status, body, nonJson } = await fetchJson(page, url);
  if (status !== 200 || !body) return { error: status, nonJson };
  const series = body.data?.result ?? [];
  return series
    .map((s) => {
      const values = s.values ?? [];
      const total = values.reduce((acc, v) => acc + Number(v[1]), 0);
      let peak = { count: 0, ts: 0 };
      for (const [ts, val] of values) {
        const n = Number(val);
        if (n > peak.count) peak = { count: n, ts };
      }
      return {
        service: s.metric?.service ?? "?",
        total,
        peakCount: peak.count,
        peakAt: peak.ts ? new Date(peak.ts * 1000).toISOString() : null,
        perStepAvg: values.length ? Math.round(total / values.length) : 0,
      };
    })
    .sort((a, b) => b.total - a.total);
}

function extractValue(result) {
  if (Array.isArray(result) && result.length > 0) {
    return result.map((r) => ({
      labels: r.metric,
      value: r.value?.[1],
    }));
  }
  return result;
}

async function main() {
  // Persistent session (scripts/.grafana-session/) — log in ONCE, every
  // subsequent run reuses the cookie. Same helper as grafana-logs.mjs.
  const { page, close } = await openGrafana(GRAFANA_URL);
  console.log(">>> Collecting data...\n");

  const report = { timestamp: new Date().toISOString(), grafanaUrl: GRAFANA_URL };

  // --- Prometheus instant queries ---
  console.log("=== Prometheus Metrics ===");
  const promMetrics = {
    up: "up",
    error_rate_5m: 'sum(rate(neotolis_http_requests_total{status_code=~"5.."}[5m]))',
    request_rate_5m: "sum(rate(neotolis_http_requests_total[5m]))",
    request_rate_by_status: "sum by (status_code) (rate(neotolis_http_requests_total[5m]))",
    latency_p50:
      "histogram_quantile(0.50, sum by (le) (rate(neotolis_http_request_duration_seconds_bucket[5m])))",
    latency_p95:
      "histogram_quantile(0.95, sum by (le) (rate(neotolis_http_request_duration_seconds_bucket[5m])))",
    latency_p99:
      "histogram_quantile(0.99, sum by (le) (rate(neotolis_http_request_duration_seconds_bucket[5m])))",
    slowest_routes_p95:
      "topk(10, histogram_quantile(0.95, sum by (le, route) (rate(neotolis_http_request_duration_seconds_bucket[5m]))))",
    memory_rss_bytes: "neotolis_process_resident_memory_bytes",
    heap_used_bytes: "neotolis_nodejs_heap_size_used_bytes",
    eventloop_lag: "neotolis_nodejs_eventloop_lag_seconds",
    queue_depth: "neotolis_pgboss_queue_depth",
    top_routes: "topk(10, sum by (route) (rate(neotolis_http_requests_total[5m])))",
    errors_by_route:
      'sum by (route, status_code) (rate(neotolis_http_requests_total{status_code=~"5.."}[5m]))',
    active_handles: "neotolis_nodejs_active_handles_total",
    gc_duration: "rate(neotolis_nodejs_gc_duration_seconds_sum[5m])",
    total_requests: "neotolis_http_requests_total",
  };

  report.prometheus = {};
  for (const [name, expr] of Object.entries(promMetrics)) {
    const raw = await promQuery(page, expr);
    report.prometheus[name] = extractValue(raw);
    console.log(`  ${name}: ${JSON.stringify(report.prometheus[name]).slice(0, 120)}`);
  }

  // --- Memory trend (24h range) ---
  console.log("\n=== Memory Trend (24h) ===");
  const memTrend = await promRangeQuery(page, "neotolis_process_resident_memory_bytes", 86400, 300);
  if (memTrend.length > 0 && memTrend[0].values) {
    const values = memTrend[0].values;
    const first = parseFloat(values[0][1]);
    const last = parseFloat(values[values.length - 1][1]);
    const delta = last - first;
    report.memoryTrend = {
      firstMB: (first / 1e6).toFixed(1),
      lastMB: (last / 1e6).toFixed(1),
      deltaMB: (delta / 1e6).toFixed(1),
      deltaPercent: ((delta / first) * 100).toFixed(1),
      datapoints: values.length,
    };
    console.log(
      `  ${report.memoryTrend.firstMB}MB → ${report.memoryTrend.lastMB}MB (${report.memoryTrend.deltaMB > 0 ? "+" : ""}${report.memoryTrend.deltaMB}MB, ${report.memoryTrend.deltaPercent}%)`,
    );
  } else {
    report.memoryTrend = { error: "no data" };
    console.log("  no data");
  }

  // --- Loki ---
  console.log("\n=== Loki Labels & Logs ===");
  report.loki = {};
  report.loki.labels = {};
  for (const label of ["service", "service_name", "container", "level"]) {
    report.loki.labels[label] = await lokiLabelValues(page, label);
    console.log(`  ${label}: [${report.loki.labels[label].join(", ")}]`);
  }

  const serviceSelector = report.loki.labels.service?.length
    ? '{service=~"' + report.loki.labels.service.join("|") + '"}'
    : '{service=~".+"}';

  // __error__="" must come AFTER the numeric comparison: LogQL keeps lines whose
  // label failed to parse as a number (nginx logs level:"info"), so without the
  // trailing filter every nginx access-log line counts as an "error".
  report.loki.errorLogs24h = await lokiCount(
    page,
    `${serviceSelector} |= "level" | json | level >= 50 | __error__=""`,
  );
  console.log(`  error logs (24h): ${report.loki.errorLogs24h} lines`);

  // --- Log volume by service (spike detection) ---
  console.log("\n=== Log Volume by Service (24h) ===");
  const services = report.loki.labels.service?.length ? report.loki.labels.service : [".+"];
  report.loki.volumeByService = await lokiVolumeByService(page, services, 86400, 300);
  if (Array.isArray(report.loki.volumeByService)) {
    for (const s of report.loki.volumeByService) {
      console.log(
        `  ${s.service.padEnd(10)} total=${s.total}  avg/5m=${s.perStepAvg}  peak=${s.peakCount} @ ${s.peakAt}`,
      );
    }
  } else {
    console.log(`  error: ${JSON.stringify(report.loki.volumeByService)}`);
  }

  // ERR_HTTP_HEADERS_SENT is printed raw by @hono/node-server (bypasses Pino),
  // so the level>=50 query never sees it — grep the raw line instead.
  report.loki.escapedHeadersSent24h = await lokiCount(
    page,
    `${serviceSelector} |= "ERR_HTTP_HEADERS_SENT"`,
  );
  console.log(`  ERR_HTTP_HEADERS_SENT (24h): ${report.loki.escapedHeadersSent24h} lines`);

  report.loki.allLogs1h = await lokiCount(page, serviceSelector, 3600);
  console.log(`  all logs (1h): ${report.loki.allLogs1h} lines`);

  // --- Alerts ---
  console.log("\n=== Alert State ===");
  const alertResp = await fetchJson(page, `${GRAFANA_URL}/api/alertmanager/grafana/api/v2/alerts`);
  report.alerts = alertResp.status === 200 ? alertResp.body : { error: alertResp.status };
  if (Array.isArray(report.alerts)) {
    if (report.alerts.length === 0) {
      console.log("  No alerts firing");
    } else {
      for (const a of report.alerts) {
        console.log(`  [${a.status?.state}] ${a.labels?.alertname} (since ${a.startsAt})`);
      }
    }
  }

  // --- Dashboard screenshots ---
  console.log("\n=== Dashboard Screenshots ===");
  for (const [uid, name] of [
    ["neotolis-overview", "overview"],
    ["neotolis-logs", "logs"],
  ]) {
    try {
      await page.goto(`${GRAFANA_URL}/d/${uid}/${uid}?orgId=1`, { waitUntil: "load" });
      await page.waitForTimeout(5000);
      const path = join(OUT_DIR, `dashboard-${name}.png`);
      await page.screenshot({ path, fullPage: true });
      console.log(`  Saved ${path}`);
    } catch (e) {
      console.log(`  ${name}: ${e.message}`);
    }
  }

  // --- Summary ---
  const rss = report.prometheus.memory_rss_bytes;
  const rssMB = rss?.[0]?.value ? (parseFloat(rss[0].value) / 1e6).toFixed(1) : "?";
  const p95 = report.prometheus.latency_p95;
  const p95ms = p95?.[0]?.value ? (parseFloat(p95[0].value) * 1000).toFixed(0) : "?";
  // A zero-valued series still exists once any 5xx was ever counted — flag on
  // the rate's value, not on the series' presence.
  const errRate = report.prometheus.error_rate_5m;
  const hasErrors = Array.isArray(errRate) && errRate.some((r) => parseFloat(r.value) > 0);
  const firingAlerts = Array.isArray(report.alerts)
    ? report.alerts.filter((a) => a.status?.state === "active").length
    : "?";

  console.log("\n========== SUMMARY ==========");
  console.log(`  RSS:         ${rssMB} MB`);
  console.log(
    `  Heap:        ${report.prometheus.heap_used_bytes?.[0]?.value ? (parseFloat(report.prometheus.heap_used_bytes[0].value) / 1e6).toFixed(1) : "?"} MB`,
  );
  console.log(`  Latency p95: ${p95ms} ms`);
  console.log(`  5xx errors:  ${hasErrors ? "YES" : "none"}`);
  console.log(`  Alerts:      ${firingAlerts} firing`);
  console.log(`  Loki logs:   ${report.loki.allLogs1h} lines (1h)`);
  if (report.memoryTrend.deltaMB) {
    console.log(
      `  Memory 24h:  ${report.memoryTrend.deltaMB > 0 ? "+" : ""}${report.memoryTrend.deltaMB} MB (${report.memoryTrend.deltaPercent}%)`,
    );
  }
  console.log("=============================\n");

  // Save report
  const reportPath = join(OUT_DIR, "report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Full report: ${reportPath}`);

  await close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
