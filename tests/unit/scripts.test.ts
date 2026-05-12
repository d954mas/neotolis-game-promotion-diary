import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Tests for scripts/deploy.sh, scripts/deploy-rollback.sh, scripts/backup.sh,
// nginx/refresh-cf-ips.sh.

describe("deploy + backup scripts syntax + invariants", () => {
  it("scripts/deploy.sh syntax-validates via `bash -n`", () => {
    expect(() => execSync("bash -n scripts/deploy.sh", { stdio: "pipe" })).not.toThrow();
  });

  it("scripts/deploy-rollback.sh syntax-validates via `bash -n`", () => {
    expect(() => execSync("bash -n scripts/deploy-rollback.sh", { stdio: "pipe" })).not.toThrow();
  });

  it("scripts/backup.sh syntax-validates via `bash -n`", () => {
    expect(() => execSync("bash -n scripts/backup.sh", { stdio: "pipe" })).not.toThrow();
  });

  // The locked shape uses the FD-based shell form: `exec 200>"$LOCK"`
  // followed by `flock -n 200`, where $LOCK=/var/lock/diary-backup.lock.
  // Asserting both substrings together proves the non-blocking lock is
  // acquired on the documented sentinel path (concurrency safety).
  it("scripts/backup.sh contains literal `flock -n /var/lock/diary-backup.lock`", () => {
    const content = readFileSync("scripts/backup.sh", "utf-8");
    expect(content).toMatch(/flock -n/);
    expect(content).toContain("/var/lock/diary-backup.lock");
  });

  it("scripts/backup.sh contains `set -euo pipefail`", () => {
    const content = readFileSync("scripts/backup.sh", "utf-8");
    expect(content).toContain("set -euo pipefail");
  });

  // backup.sh used to default `PG_CONTAINER=diary_postgres` and call
  // `docker exec "$PG_CONTAINER"`, but docker-compose.prod.yml does not set
  // `container_name` — Compose generates the actual name from
  // <project>-<service>-<index>. The default name didn't exist on a standard
  // install and backups silently never ran. Fix uses `docker compose exec`
  // which resolves the service by compose name, independent of project prefix.
  // Lock the new shape so a future revert can't reintroduce the bug.
  it("backup.sh resolves Postgres via `docker compose exec`, not `docker exec <name>`", () => {
    const content = readFileSync("scripts/backup.sh", "utf-8");
    // Must use `docker compose exec` against $COMPOSE_FILE.
    expect(content).toMatch(/docker compose -f "\$COMPOSE_FILE" exec -T postgres pg_dump/);
    // Must NOT reference the old fragile PG_CONTAINER/diary_postgres default.
    expect(content).not.toMatch(/PG_CONTAINER/);
    expect(content).not.toMatch(/docker exec\s+"\$PG_CONTAINER"/);
    expect(content).not.toMatch(/diary_postgres/);
  });

  it("nginx/refresh-cf-ips.sh syntax-validates via `bash -n`", () => {
    expect(() => execSync("bash -n nginx/refresh-cf-ips.sh", { stdio: "pipe" })).not.toThrow();
  });

  // nginx config must terminate HTTPS on origin (CF Full Strict mode
  // connects via HTTPS only). This locks the ssl_certificate /
  // ssl_certificate_key directives + the 443 listener so a future revert
  // can't reintroduce the 521 trap.
  //
  // TLS 1.3 only (TLSv1.2 dropped per project constraint "TLS 1.3 + HSTS");
  // origin nginx does NOT listen on port 80 at all — HTTP→HTTPS redirect is
  // handled by Cloudflare "Always Use HTTPS" rule at the edge
  // (install.md §2 Step 4.4). UFW closes port 80 (§1 Step 2), compose does
  // not publish 80, nginx does not listen on 80 — three layers of defense
  // in depth.
  it("nginx.conf.template listens on 443 only with Origin CA cert + TLS 1.3 only, NO listen 80", () => {
    const content = readFileSync("nginx/nginx.conf.template", "utf-8");
    expect(content, "must listen on 443 ssl").toMatch(/listen\s+443\s+ssl;/);
    expect(content, "must enable http2").toMatch(/http2\s+on;/);
    expect(content, "must reference origin.pem at the canonical mounted path").toMatch(
      /ssl_certificate\s+\/etc\/nginx\/certs\/origin\.pem;/,
    );
    expect(content, "must reference origin.key at the canonical mounted path").toMatch(
      /ssl_certificate_key\s+\/etc\/nginx\/certs\/origin\.key;/,
    );
    // Constraint: TLS 1.3 only — `ssl_protocols TLSv1.3;` exact match,
    // explicitly NOT `TLSv1.2 TLSv1.3` (which would re-allow 1.2).
    expect(content, "must restrict to TLSv1.3 only").toMatch(/ssl_protocols\s+TLSv1\.3;/);
    expect(content, "must NOT allow TLSv1.2").not.toMatch(/ssl_protocols\s+[^;]*TLSv1\.2/);
    // Strict reading of constraint: nginx does not listen on port 80.
    // CF "Always Use HTTPS" rule handles HTTP→HTTPS redirect at the edge.
    expect(content, "nginx must NOT listen on port 80 — CF handles HTTP→HTTPS").not.toMatch(
      /listen\s+80\b/,
    );
  });
});
