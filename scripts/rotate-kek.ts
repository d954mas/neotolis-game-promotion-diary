// KEK rotation CLI — a THIN wrapper over rotateAllDeks.
//
// This script contains ZERO rotation/crypto logic of its own. It parses three
// flags and calls the SAME shared core (src/lib/server/crypto/rotate-kek-batch.ts
// rotateAllDeks) that the permanent CI integration test
// (tests/integration/kek-rotation.test.ts) exercises — so the drill the
// operator runs is the exact code CI proves every PR (D-13 / DEPLOY-04).
//
// Run:  pnpm tsx scripts/rotate-kek.ts --to 2 [--dry-run] [--batch-size 500]
// Docs: docs/self-host/kek-rotation.md (when / dry-run / rotate / promote /
//       rollback / retire).
//
// Exit codes: 0 = clean, 1 = at least one row failed to re-wrap (failures
// surfaced), 2 = usage error (missing/invalid --to).

import "dotenv/config";
import { pool } from "../src/lib/server/db/client.js";
import { rotateAllDeks } from "../src/lib/server/crypto/rotate-kek-batch.js";

const USAGE = `Usage: pnpm tsx scripts/rotate-kek.ts --to <version> [--dry-run] [--batch-size <n>]

  --to <n>          (required) target KEK version to re-wrap every DEK to
  --dry-run         verify-only: decrypt every candidate under its current KEK,
                    issue NO UPDATE (counts candidates + verified)
  --batch-size <n>  rows per transaction (default 500)

Before running, set APP_KEK_V<to>_BASE64 in the env and reboot so both KEKs are
loaded. See docs/self-host/kek-rotation.md for the full operator procedure.`;

function parseArgs(argv: string[]): { to: number; dryRun: boolean; batchSize?: number } | null {
  let to: number | undefined;
  let dryRun = false;
  let batchSize: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--to") {
      to = Number(argv[++i]);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--batch-size") {
      batchSize = Number(argv[++i]);
    } else {
      console.error(`Unknown argument: ${arg}`);
      return null;
    }
  }

  if (to === undefined || !Number.isInteger(to) || to < 1) {
    console.error("Error: --to <version> is required and must be a positive integer.\n");
    return null;
  }
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) {
    console.error("Error: --batch-size must be a positive integer.\n");
    return null;
  }

  return { to, dryRun, batchSize };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.error(USAGE);
    process.exit(2);
  }

  const mode = opts.dryRun ? "DRY-RUN (no writes)" : "ROTATE";
  console.log(`KEK rotation — ${mode} → target v${opts.to}`);

  const results = await rotateAllDeks(opts);

  let anyFailure = false;
  for (const r of results) {
    console.log(
      `  ${r.table}: candidates=${r.candidates} verified=${r.verified} rotated=${r.rotated} failures=${r.failures.length}`,
    );
    if (r.failures.length > 0) {
      anyFailure = true;
      console.error(`  ${r.table}: failed row ids → ${r.failures.join(", ")}`);
    }
  }

  await pool.end();
  process.exit(anyFailure ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await pool.end().catch(() => {});
  process.exit(1);
});
