// Wave 0 scaffold (06-01) — flipped GREEN by plan 06-02.
//
// D-08 account export envelope completeness drift-guard. Sits alongside the
// existing "account export envelope ciphertext strip" block in dto.test.ts.
// The 06-02 plan replaces each skipped placeholder below with a real test.
//
// The activated test will import TENANT_TABLES from
// eslint-plugin-tenant-scope/no-unfiltered-tenant-query.js and assert that
// every tenant table is covered by an AccountExportEnvelope key OR is named in
// an explicit EXPORT_EXCLUDED_TENANT_TABLES allowlist for junction /
// operational tables (event_games, adapter_refresh_queue, outbox). It also
// pins the envelope's key set against a frozen EXPECTED_EXPORT_KEYS list so a
// new tenant table forces a deliberate export decision rather than a silent
// gap. Named-plan tag "06-02" keeps the Nyquist invariant honest.

import { describe, it } from "vitest";

describe("account export envelope completeness (D-08)", () => {
  it.skip("every TENANT_TABLES entry has a corresponding AccountExportEnvelope key OR is in EXPORT_EXCLUDED_TENANT_TABLES [06-02]", () => {
    // Import TENANT_TABLES from the tenant-scope ESLint plugin; assert each is
    // either an AccountExportEnvelope key or an allowlisted junction/operational
    // table (event_games, adapter_refresh_queue, outbox).
  });

  it.skip("AccountExportEnvelope keys match the frozen EXPECTED_EXPORT_KEYS list [06-02]", () => {
    // Pin the envelope's key set against a frozen EXPECTED_EXPORT_KEYS list so
    // adding a tenant table forces a deliberate export decision.
  });
});
