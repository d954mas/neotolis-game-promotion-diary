// D-19a env.ts schema <-> .env.example drift guard (flipped GREEN by 06-06).
//
// Closes the exact drift hole found during Phase 6 discussion: adding an env.ts
// schema var without a matching .env.example line (or leaving a stale example
// var that no longer maps to a schema key) fails THIS unit test in CI, before
// it can rot the self-host onboarding story.
//
// RAW_ENV_KEYS (06-01) is the canonical key set — Object.keys(RawSchema.shape),
// read inside the env.ts boundary so it never touches process.env. The parser
// matches `^#?\s*([A-Z_][A-Z0-9_]*)=` so documented-but-commented optional vars
// count as present. The reverse direction subtracts a compose-only allowlist:
// vars that live in .env.example for docker-compose but are never read by the app.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { RAW_ENV_KEYS } from "../../src/lib/server/config/env.js";

const here = dirname(fileURLToPath(import.meta.url));
const envExamplePath = resolve(here, "../../.env.example");
const envExample = readFileSync(envExamplePath, "utf8");

// Parse every declared key — both real `KEY=` and documented-commented `# KEY=`.
const ENV_EXAMPLE_KEYS = new Set<string>();
for (const line of envExample.split(/\r?\n/)) {
  const m = line.match(/^#?\s*([A-Z_][A-Z0-9_]*)=/);
  if (m?.[1]) ENV_EXAMPLE_KEYS.add(m[1]);
}

// Compose-only vars: present in .env.example for docker-compose / monitoring
// overlay, but never read by the app (not in RawSchema). APP_KEK_V2_BASE64 is
// rotation-only (read directly in env.ts via process.env[`APP_KEK_V${v}_BASE64`],
// not a RawSchema key), documented in .env.example as a comment.
const COMPOSE_ONLY_ALLOWLIST = new Set<string>([
  "POSTGRES_PASSWORD",
  "GF_SECURITY_ADMIN_PASSWORD",
  "GF_SERVER_ROOT_URL",
  "GF_SERVER_SERVE_FROM_SUB_PATH",
  "GF_PORT",
  "COMPOSE_NETWORK",
  "APP_KEK_V2_BASE64",
]);

describe("env.ts schema <-> .env.example drift (D-19a)", () => {
  it("every RAW_ENV_KEYS key appears in .env.example as `KEY=` or `# KEY=`", () => {
    const missing = RAW_ENV_KEYS.filter((k) => !ENV_EXAMPLE_KEYS.has(k));
    expect(
      missing,
      `env.ts schema keys absent from .env.example (add a \`KEY=\` or \`# KEY=\` line): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("no .env.example key is absent from RAW_ENV_KEYS (minus the compose-only allowlist)", () => {
    const schemaKeys = new Set(RAW_ENV_KEYS);
    const stale = [...ENV_EXAMPLE_KEYS].filter(
      (k) => !schemaKeys.has(k) && !COMPOSE_ONLY_ALLOWLIST.has(k),
    );
    expect(
      stale,
      `.env.example declares keys not in env.ts RawSchema (remove them, or add to the compose-only allowlist if they are compose-only): ${stale.join(", ")}`,
    ).toEqual([]);
  });
});
