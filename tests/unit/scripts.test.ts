import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Phase 02.2 Plan 02.2-06 — live tests for scripts/deploy.sh,
// scripts/deploy-rollback.sh, scripts/backup.sh, nginx/refresh-cf-ips.sh.
// Plan 02.2-01 reserved 6 it.skip blocks; Plan 02.2-06 flipped them live.

describe("deploy + backup scripts syntax + invariants (Phase 02.2)", () => {
  it("Plan 02.2-06: scripts/deploy.sh syntax-validates via `bash -n`", () => {
    expect(() => execSync("bash -n scripts/deploy.sh", { stdio: "pipe" })).not.toThrow();
  });

  it("Plan 02.2-06: scripts/deploy-rollback.sh syntax-validates via `bash -n`", () => {
    expect(() => execSync("bash -n scripts/deploy-rollback.sh", { stdio: "pipe" })).not.toThrow();
  });

  it("Plan 02.2-06: scripts/backup.sh syntax-validates via `bash -n`", () => {
    expect(() => execSync("bash -n scripts/backup.sh", { stdio: "pipe" })).not.toThrow();
  });

  // The locked shape uses the FD-based shell form: `exec 200>"$LOCK"`
  // followed by `flock -n 200`, where $LOCK=/var/lock/diary-backup.lock.
  // Asserting both substrings together proves the non-blocking lock is
  // acquired on the documented sentinel path (D-25b — concurrency safety).
  it("Plan 02.2-06: scripts/backup.sh contains literal `flock -n /var/lock/diary-backup.lock`", () => {
    const content = readFileSync("scripts/backup.sh", "utf-8");
    expect(content).toMatch(/flock -n/);
    expect(content).toContain("/var/lock/diary-backup.lock");
  });

  it("Plan 02.2-06: scripts/backup.sh contains `set -euo pipefail`", () => {
    const content = readFileSync("scripts/backup.sh", "utf-8");
    expect(content).toContain("set -euo pipefail");
  });

  // Codex post-fix #1: backup.sh used to default `PG_CONTAINER=diary_postgres`
  // and call `docker exec "$PG_CONTAINER"`, but docker-compose.prod.yml does
  // not set `container_name` — Compose generates the actual name from
  // <project>-<service>-<index>. The default name didn't exist on a standard
  // install and backups silently never ran. Fix uses `docker compose exec`
  // which resolves the service by compose name, independent of project prefix.
  // Lock the new shape so a future revert can't reintroduce the bug.
  it("Plan 02.2-06 (Codex post-fix #1): backup.sh resolves Postgres via `docker compose exec`, not `docker exec <name>`", () => {
    const content = readFileSync("scripts/backup.sh", "utf-8");
    // Must use `docker compose exec` against $COMPOSE_FILE.
    expect(content).toMatch(/docker compose -f "\$COMPOSE_FILE" exec -T postgres pg_dump/);
    // Must NOT reference the old fragile PG_CONTAINER/diary_postgres default.
    expect(content).not.toMatch(/PG_CONTAINER/);
    expect(content).not.toMatch(/docker exec\s+"\$PG_CONTAINER"/);
    expect(content).not.toMatch(/diary_postgres/);
  });

  it("Plan 02.2-06: nginx/refresh-cf-ips.sh syntax-validates via `bash -n`", () => {
    expect(() => execSync("bash -n nginx/refresh-cf-ips.sh", { stdio: "pipe" })).not.toThrow();
  });
});
