// nginx access-log privacy invariant.
//
// The JSON access_log ships to Loki, which BYPASSES Pino's redaction layer.
// So the log_format itself is the only barrier: it must never emit fields
// that can carry secrets. The query string carries OAuth `code`/`state` on
// the callback and private feed-filter state; Referer can carry full
// external URLs with their own query params. This test is the load-bearing
// guard against a future edit re-introducing $request_uri / $args /
// $http_referer into the access log.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TEMPLATE = readFileSync(join(process.cwd(), "nginx", "nginx.conf.template"), "utf8");

// Isolate the json_access log_format block so we assert against the access
// log specifically, not the whole file (proxy_pass blocks legitimately use
// other vars).
function logFormatBlock(): string {
  const start = TEMPLATE.indexOf("log_format json_access");
  expect(start, "json_access log_format must exist").toBeGreaterThan(-1);
  const end = TEMPLATE.indexOf("';", start);
  return TEMPLATE.slice(start, end);
}

describe("nginx access-log privacy", () => {
  const block = logFormatBlock();

  it("logs the path via $uri (no query string), not $request_uri", () => {
    expect(block).toContain("$uri");
    expect(block).not.toContain("$request_uri");
  });

  it("never logs the raw query string ($args / $query_string)", () => {
    expect(block).not.toContain("$args");
    expect(block).not.toContain("$query_string");
  });

  it("never logs Referer (can carry external URLs with secrets)", () => {
    expect(block).not.toContain("$http_referer");
  });

  it("never logs User-Agent (opsec parity with Pino redaction)", () => {
    expect(block).not.toContain("$http_user_agent");
  });

  it("still captures the fields needed to triage a failing request", () => {
    expect(block).toContain("$status");
    expect(block).toContain("$request_method");
    expect(block).toContain("$request_time");
  });
});
