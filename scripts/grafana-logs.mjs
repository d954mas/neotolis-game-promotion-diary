// Pull actual log lines from Loki for inspection. Reuses persistent session.
// Run: node scripts/grafana-logs.mjs [query] [grafana_url]

import { openGrafana, DEFAULT_GRAFANA_URL } from "./lib/grafana-session.mjs";

const QUERY = process.argv[2] || '{service=~"app|worker|scheduler"} |= "level" | json | level >= 50';
const GRAFANA_URL = process.argv[3] || DEFAULT_GRAFANA_URL;

const { page, grafanaUrl, close } = await openGrafana(GRAFANA_URL);

const now = Math.floor(Date.now() / 1000);
const dayAgo = now - 86400;
const url = `${grafanaUrl}/api/datasources/proxy/uid/loki/loki/api/v1/query_range?query=${encodeURIComponent(QUERY)}&start=${dayAgo}000000000&end=${now}000000000&limit=50&direction=backward`;

const resp = await page.evaluate(async (u) => {
  const r = await fetch(u, { credentials: "include" });
  return r.json();
}, url);

const streams = resp.data?.result ?? [];
console.log(`\n=== ${streams.length} stream(s) for: ${QUERY} ===\n`);
for (const s of streams) {
  console.log(`LABELS: service=${s.stream.service} container=${s.stream.container} level=${s.stream.level}`);
  for (const [ts, line] of s.values.slice(0, 30)) {
    const t = new Date(Number(ts) / 1e6).toISOString();
    console.log(`  ${t}  ${line.slice(0, 280)}`);
  }
  console.log();
}

await close();
