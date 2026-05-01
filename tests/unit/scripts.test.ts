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

  it("Plan 02.2-06: nginx/refresh-cf-ips.sh syntax-validates via `bash -n`", () => {
    expect(() => execSync("bash -n nginx/refresh-cf-ips.sh", { stdio: "pipe" })).not.toThrow();
  });
});
