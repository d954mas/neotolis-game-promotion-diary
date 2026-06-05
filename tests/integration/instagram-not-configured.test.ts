// PLACEHOLDER (Wave-0, it.skip) — activated by Plan 08-06.
// Requirements: SOC-05.
//
// Graceful "not configured" degrade: with INSTAGRAM_PROVIDER unset, the
// add-source IG entry is disabled and /admin/quota shows "not configured" —
// no error is thrown, boot/self-host parity preserved (no APP_MODE branch).
// Integration test — real Postgres via ./helpers.js.
import { describe, it } from "vitest";
// import { seedUserDirectly, fetchAs } from "./helpers.js";

describe("instagram not-configured graceful degrade (SOC-05)", () => {
  it.skip("with INSTAGRAM_PROVIDER unset, the add-source IG entry is disabled and /admin/quota shows not-configured; no error thrown", async () => {
    // Plan 06: the IG observability.auth.isOperatorConfigured is false; the
    // add-source kind matrix marks instagram_account disabled; /admin/quota
    // renders the provider block as not-configured (no throw).
  });
});
