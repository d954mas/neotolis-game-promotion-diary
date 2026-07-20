---
name: grafana-audit
description: Audit production Grafana — collect Prometheus metrics, Loki logs, dashboard screenshots, and alert state. Use when asked to check monitoring, investigate prod performance, or verify observability after deploy.
---

# Grafana Production Audit

Run the Playwright-based audit script that opens a headed browser, lets the user log in, then auto-collects all observability data from the production Grafana instance.

## When to use

- User asks to "check Grafana", "проверь графану", "check monitoring", "как прод?"
- After deploying observability changes (dashboards, alerts, Prometheus/Loki config)
- Investigating production performance, errors, or memory leaks
- Morning health checks

## How to run

```bash
node scripts/grafana-audit.mjs [grafana_url]
```

Default URL: `https://neotolis-diary.dev/grafana`. The browser opens for the user to log in manually (no credentials in scripts). After login the script auto-collects everything and closes.

**Output directory:** `scripts/grafana-audit-output/`
- `report.json` — full structured data (Prometheus metrics, Loki stats, alert state, memory trend)
- `dashboard-overview.png` — screenshot of Neotolis Overview dashboard
- `dashboard-logs.png` — screenshot of Neotolis Logs dashboard

## What the script collects

### Prometheus (instant queries)
| Key | What |
|-----|------|
| `up` | Scrape target health |
| `error_rate_5m` | 5xx error rate |
| `request_rate_5m` / `request_rate_by_status` | RPS total and per status code |
| `latency_p50/p95/p99` | Request latency percentiles |
| `slowest_routes_p95` | Top 10 slowest routes |
| `memory_rss_bytes` / `heap_used_bytes` | Node.js memory |
| `eventloop_lag` | Event loop lag |
| `queue_depth` | pg-boss queue depths |
| `gc_duration` | GC time per second |
| `total_requests` | Absolute counters by route/status |

### Prometheus (range query, 24h)
- `memoryTrend` — RSS over 24h with delta in MB and %. Used to detect memory leaks.

### Loki
- Auto-discovers available labels and their values (no hardcoded selectors)
- Error logs count (level >= 50, parse-error lines excluded via `__error__=""`) over 24h
- `escapedHeadersSent24h` — raw `ERR_HTTP_HEADERS_SENT` lines (the known deferred bug prints raw, bypassing Pino, so `level >= 50` never sees it)
- Total log volume over 1h
- Retention is ~7 days — anything older is gone regardless of query window

### Alerts
- Current firing/pending alert state from Grafana Alertmanager API

## How to interpret results

After the script finishes, read `scripts/grafana-audit-output/report.json` and the screenshots. Look for:

### Red flags (act now)
- **5xx errors present** (`error_rate_5m` value > 0 — a zero-valued series just means a 5xx happened at some point since process start) — check `errors_by_route` for which routes
- **Alerts firing** — check `alerts` array, look at `status.state` and `labels.alertname`
- **Loki error logs** (`errorLogs24h > 0`, a matched-line count via `count_over_time`) — investigate via Grafana Explore
- **Queue depth > 0 in `active`** for extended periods — jobs stuck

### Yellow flags (monitor)
- **Memory trend delta > +20% per 24h** — possible leak. Check if heap grows proportionally or if it's RSS-only (V8 overhead). If pattern persists after restart → real leak.
- **Latency p95 > 500ms** — investigate slowest routes
- **High 404 rate** in `request_rate_by_status` — likely bots, but check if real assets missing
- **Loki 0 lines** — Promtail may not be shipping logs; check `docker logs diary-promtail-1`

### Green (healthy)
- `error_rate_5m` zero (no current 5xx)
- `latency_p95` < 200ms
- All queues at 0
- Memory trend < +10% per 24h
- No alerts firing
- Loki receiving logs

## Cleanup

The output directory (`scripts/grafana-audit-output/`) is gitignored. Screenshots and report are overwritten on each run.
