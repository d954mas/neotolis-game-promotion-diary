// Pull raw Loki log lines for a time window and aggregate by message/route,
// to identify what caused a log-volume spike.
//
// Run:  node scripts/loki-window.mjs [startISO] [endISO] [service]
// Defaults target the 2026-05-29 03:10 UTC app spike found in the audit.

import { openGrafana } from "./lib/grafana-session.mjs";

const GRAFANA_URL = "https://neotolis-diary.dev/grafana";
const START = process.argv[2] || "2026-05-29T03:05:00Z";
const END = process.argv[3] || "2026-05-29T03:20:00Z";
const SERVICES = process.argv[4] ? [process.argv[4]] : ["app", "nginx"];

function topN(map, n = 20) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

async function lokiRaw(page, expr, startNs, endNs, limit = 5000) {
  const url = `${GRAFANA_URL}/api/datasources/proxy/uid/loki/loki/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${startNs}&end=${endNs}&limit=${limit}&direction=forward`;
  const { status, body, nonJson } = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "include" });
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) };
    } catch {
      return { status: r.status, body: null, nonJson: text.slice(0, 200) };
    }
  }, url);
  if (status !== 200 || !body) return { error: status, nonJson };
  const lines = [];
  for (const stream of body.data?.result ?? []) {
    for (const [ts, line] of stream.values ?? []) lines.push({ ts, line });
  }
  return { lines };
}

// Scan mode: count_over_time per bucket across a range to locate volume spikes.
async function lokiCountRange(page, svc, startNs, endNs, stepSec) {
  const expr = `sum(count_over_time({service="${svc}"}[${stepSec}s]))`;
  const url = `${GRAFANA_URL}/api/datasources/proxy/uid/loki/loki/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${startNs}&end=${endNs}&step=${stepSec}`;
  const { status, body, nonJson } = await page.evaluate(async (u) => {
    const r = await fetch(u, { credentials: "include" });
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) };
    } catch {
      return { status: r.status, body: null, nonJson: text.slice(0, 200) };
    }
  }, url);
  if (status !== 200 || !body) return { error: status, nonJson };
  const values = body.data?.result?.[0]?.values ?? [];
  return { values };
}

async function authedPage() {
  // Reuse the SHARED, gitignored session dir (scripts/.grafana-session/) via the same
  // helper grafana-logs.mjs / grafana-audit.mjs use. The previous bespoke
  // `.grafana-auth` persistent context wrote live Grafana cookies / Login Data /
  // Sessions into a NON-ignored path that `git add -A` could stage — a leaked session.
  const { context, page } = await openGrafana(GRAFANA_URL);
  return { context, page };
}

async function scanMain() {
  const rangeHours = Number(process.argv[3] || 24);
  const stepSec = Number(process.argv[4] || 300);
  const services = process.argv[5] ? process.argv[5].split(",") : ["app", "nginx"];
  const now = Date.now();
  const endNs = now * 1e6;
  const startNs = (now - rangeHours * 3600 * 1000) * 1e6;
  console.log(`Scan: last ${rangeHours}h, ${stepSec}s buckets  (${services.join(", ")})\n`);

  const { context, page } = await authedPage();
  for (const svc of services) {
    const res = await lokiCountRange(page, svc, startNs, endNs, stepSec);
    if (res.error) {
      console.log(`### ${svc}: ERROR ${res.error} ${res.nonJson ?? ""}\n`);
      continue;
    }
    const buckets = res.values.map(([ts, v]) => ({ ts: Number(ts), n: Number(v) }));
    const total = buckets.reduce((a, b) => a + b.n, 0);
    const top = [...buckets].sort((a, b) => b.n - a.n).slice(0, 10);
    console.log(`### ${svc}: total=${total} over ${buckets.length} buckets`);
    console.log(`  top buckets (count @ time UTC):`);
    for (const b of top) {
      console.log(`    ${String(b.n).padStart(6)}  ${new Date(b.ts * 1000).toISOString()}`);
    }
    console.log();
  }
  await context.close();
}

async function main() {
  const startNs = Date.parse(START) * 1e6;
  const endNs = Date.parse(END) * 1e6;
  console.log(`Window: ${START} → ${END}  (${SERVICES.join(", ")})\n`);

  const { context, page } = await authedPage();

  for (const svc of SERVICES) {
    const res = await lokiRaw(page, `{service="${svc}"}`, startNs, endNs);
    if (res.error) {
      console.log(`### ${svc}: ERROR ${res.error} ${res.nonJson ?? ""}\n`);
      continue;
    }
    const byMsg = new Map();
    const byRoute = new Map();
    const byLevel = new Map();
    // nginx access-log aggregations: what was scanned, from where, with what result
    const byPath = new Map();
    const byIp = new Map();
    const byStatus = new Map();
    const byPathStatus = new Map();
    let nginxLines = 0;
    const samples = [];
    for (const { line } of res.lines) {
      // Assigned in every branch below (nginx / json / raw-fallback) before use.
      let key;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        // nginx / non-JSON line: collapse digits & IPs to find the pattern
      }
      const isNginxAccess = parsed && (parsed.source === "nginx" || parsed.path !== undefined);
      if (isNginxAccess) {
        nginxLines++;
        const path = String(parsed.path ?? "?").split("?")[0];
        const status = String(parsed.status ?? "?");
        const ip = String(parsed.remote_addr ?? "?");
        byPath.set(path, (byPath.get(path) ?? 0) + 1);
        byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
        byIp.set(ip, (byIp.get(ip) ?? 0) + 1);
        const ps = `${status} ${path}`;
        byPathStatus.set(ps, (byPathStatus.get(ps) ?? 0) + 1);
        key = `${parsed.method ?? "?"} ${path}`;
      } else if (parsed) {
        const msg = parsed.msg ?? parsed.message ?? parsed.err?.message ?? "(no msg)";
        key = msg;
        const lvl = String(parsed.level ?? "?");
        byLevel.set(lvl, (byLevel.get(lvl) ?? 0) + 1);
        const route = parsed.req?.url ?? parsed.url ?? parsed.route ?? parsed.request?.url;
        if (route) {
          const norm = String(route).split("?")[0];
          byRoute.set(norm, (byRoute.get(norm) ?? 0) + 1);
        }
      } else {
        key = line
          .replace(/\d{1,3}(\.\d{1,3}){3}/g, "<ip>")
          .replace(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/g, "<ts>")
          .replace(/\d+/g, "<n>")
          .slice(0, 160);
      }
      byMsg.set(key, (byMsg.get(key) ?? 0) + 1);
      if (samples.length < 3) samples.push(line.slice(0, 280));
    }

    console.log(`### ${svc}: ${res.lines.length} lines in window`);
    if (byLevel.size) console.log(`  levels: ${JSON.stringify(Object.fromEntries(byLevel))}`);
    if (nginxLines) {
      console.log(`  status codes: ${JSON.stringify(Object.fromEntries(topN(byStatus, 10)))}`);
      console.log(`  top IPs (requests):`);
      for (const [k, c] of topN(byIp, 12)) console.log(`    ${String(c).padStart(5)}  ${k}`);
      console.log(`  top paths:`);
      for (const [k, c] of topN(byPath, 20)) console.log(`    ${String(c).padStart(5)}  ${k}`);
      console.log(`  top status+path:`);
      for (const [k, c] of topN(byPathStatus, 20))
        console.log(`    ${String(c).padStart(5)}  ${k}`);
    } else {
      console.log(`  top messages/patterns:`);
      for (const [k, c] of topN(byMsg, 15)) console.log(`    ${String(c).padStart(5)}  ${k}`);
      if (byRoute.size) {
        console.log(`  top routes:`);
        for (const [k, c] of topN(byRoute, 10)) console.log(`    ${String(c).padStart(5)}  ${k}`);
      }
    }
    console.log(`  samples:`);
    for (const s of samples) console.log(`    | ${s}`);
    console.log();
  }

  await context.close();
}

const entry = process.argv[2] === "scan" ? scanMain : main;
entry().catch((e) => {
  console.error(e);
  process.exit(1);
});
