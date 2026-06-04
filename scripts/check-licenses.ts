// D-19b — AGPL/GPL-family deny-gate over PRODUCTION dependencies. Run in CI
// (lint-typecheck job). Shells `pnpm licenses list --prod --json`, classifies
// every SPDX group key with the shared compound-OR-aware classifier from
// src/lib/server/config/license-deny.ts (one source of truth, also unit-tested
// hermetically in tests/unit/check-licenses.test.ts), prints WARNs (non-fatal),
// and exits 1 listing every offending package if any prod dep is copyleft.
//
// `pnpm` resolves to `pnpm.cmd` on Windows; Node blocks spawning a .cmd shim
// directly (CVE-2024-27980), so run through the platform shell. The command is
// a fixed literal with no untrusted input, so the shell form is safe and lets
// the shell resolve the right `pnpm` on both win32 and CI Linux (mirrors
// scripts/gen-third-party-licenses.ts).
import { execSync } from "node:child_process";
import { classifyLicense } from "../src/lib/server/config/license-deny.js";

interface PnpmLicensePkg {
  name: string;
  version?: string;
  versions?: string[];
  license?: string;
}

const json = JSON.parse(
  execSync("pnpm licenses list --prod --json", {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    // pnpm prints a deprecation/advisory preamble to stderr on some setups;
    // keep stdout clean so JSON.parse never chokes.
    stdio: ["ignore", "pipe", "ignore"],
  }),
) as Record<string, PnpmLicensePkg[]>;

interface Offender {
  name: string;
  version: string;
  license: string;
}

const fails: Offender[] = [];
const warns: Offender[] = [];

for (const [license, pkgs] of Object.entries(json)) {
  const verdict = classifyLicense(license);
  if (verdict === "PASS") continue;
  for (const p of pkgs) {
    for (const v of p.versions ?? (p.version ? [p.version] : ["?"])) {
      (verdict === "FAIL" ? fails : warns).push({ name: p.name, version: v, license });
    }
  }
}

for (const w of warns) {
  console.warn(`WARN  weak/file-level copyleft: ${w.name}@${w.version} (${w.license})`);
}

if (fails.length > 0) {
  console.error(
    `\nFAIL  ${fails.length} production dependency license(s) are copyleft (AGPL/GPL-family) — not permitted:`,
  );
  for (const f of fails) {
    console.error(`  - ${f.name}@${f.version} (${f.license})`);
  }
  console.error(
    "\nRemove or replace the offending dependency, or — if it is genuinely dual-licensed —\n" +
      "verify pnpm reports the permissive arm. The deny-list lives in\n" +
      "src/lib/server/config/license-deny.ts.",
  );
  process.exit(1);
}

console.log(
  `check-licenses: OK — no copyleft in production deps (${warns.length} WARN, ${Object.keys(json).length} license groups).`,
);
process.exit(0);
