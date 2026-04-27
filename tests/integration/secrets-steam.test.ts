import { describe, it } from "vitest";

/**
 * Wave 0 placeholder test file (Plan 02-01 — Phase 2 Wave 0).
 *
 * Per Phase 1 Wave 0 invariant: every later task ships into a test that
 * already exists. The it.skip stubs below are EXACT names — implementing
 * plans (02-NN) replace `it.skip` with `it` and add the assertions.
 *
 * If you are an executor on a later plan and the test you need is NOT in
 * the it.skip list below, the gap is in this Wave 0 plan — fix it here,
 * NOT by silently adding a new it() in your plan's commit.
 */
describe("api_keys_steam envelope encryption (KEYS-03..06)", () => {
  it.skip("02-05: KEYS-03 envelope encrypted at rest", () => {
    /* placeholder — implementing plan: 02-05 */
  });
  it.skip("02-05: KEYS-04 DTO strips ciphertext", () => {
    /* placeholder — implementing plan: 02-05 */
  });
  it.skip("02-05: KEYS-05 rotate overwrites ciphertext + audits", () => {
    /* placeholder — implementing plan: 02-05 */
  });
  it.skip("02-05: KEYS-05 rotate fails on invalid key (422)", () => {
    /* placeholder — implementing plan: 02-05 */
  });
  it.skip("02-05: KEYS-06 audit metadata shape {kind, key_id, label, last4}", () => {
    /* placeholder — implementing plan: 02-05 */
  });
});
