// Wave 0 scaffold (06-01) — flipped GREEN by plan 06-06.
//
// D-19a env.ts schema <-> .env.example drift guard. The 06-06 plan replaces
// each skipped placeholder below with a real test importing RAW_ENV_KEYS from
// src/lib/server/config/env.ts (the canonical key set landed in 06-01) and
// parsing .env.example (note the leading dot).
//
// The parser must match `^#?\s*([A-Z_][A-Z0-9_]*)=` so documented-but-commented
// optional vars count as present. The reverse direction (no .env.example key
// absent from RAW_ENV_KEYS) subtracts a compose-only allowlist that lives in
// .env.example for docker-compose but is never read by the app:
//   POSTGRES_PASSWORD, GF_SECURITY_ADMIN_PASSWORD, GF_SERVER_ROOT_URL,
//   GF_SERVER_SERVE_FROM_SUB_PATH, GF_PORT, COMPOSE_NETWORK,
//   APP_KEK_V2_BASE64 (rotation-only, documented as a comment).
// Named-plan tag "06-06" keeps the Nyquist invariant honest.

import { describe, it } from "vitest";

describe("env.ts schema <-> .env.example drift (D-19a)", () => {
  it.skip("every RAW_ENV_KEYS key appears in .env.example as `KEY=` or `# KEY=` [06-06]", () => {
    // For each RAW_ENV_KEYS entry, assert .env.example contains a line matching
    // `^#?\s*KEY=` so documented-but-commented optional vars count as present.
  });

  it.skip("no .env.example key is absent from RAW_ENV_KEYS (minus the compose-only allowlist) [06-06]", () => {
    // Every key parsed from .env.example is in RAW_ENV_KEYS, except the
    // compose-only allowlist (POSTGRES_PASSWORD, GF_*, COMPOSE_NETWORK,
    // APP_KEK_V2_BASE64).
  });
});
