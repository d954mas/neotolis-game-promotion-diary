// Wave 0 scaffold (06-01) — flipped GREEN by plan 06-04.
//
// D-12 KEK rotation rehearsal. Integration-level (real Postgres): seed
// encrypted secret rows under KEK v1, run rotateAllDeks({to:2}), then assert
// every wrapped_dek now carries kek_version=2, the ciphertext (secret_ct) is
// byte-identical (re-wrap touches the DEK only — cheap online rotation, D-10),
// and decryptSecret still returns the original plaintext. The 06-04 plan
// replaces each skipped placeholder below with a real test; the named-plan tag
// keeps the Nyquist sampling invariant honest (grep "06-04" finds the stubs
// the downstream plan must flip).

import { describe, it } from "vitest";

describe("KEK rotation rehearsal (D-12)", () => {
  it.skip("seed under v1 → rotateAllDeks({to:2}) → every wrapped_dek now kek_version=2 [06-04]", () => {
    // Seed N encrypted rows under KEK v1, run rotateAllDeks({to:2}), assert
    // every persisted wrapped_dek row reports kek_version === 2.
  });

  it.skip("secret_ct is byte-identical before/after rotation (re-wrap touches DEK only) [06-04]", () => {
    // Capture secret_ct before rotation; assert it is unchanged after — only
    // the wrapped_dek (DEK under the new KEK) changes.
  });

  it.skip("decryptSecret returns the original plaintext after rotation [06-04]", () => {
    // After rotateAllDeks({to:2}), decryptSecret on a rotated row yields the
    // exact plaintext that was encrypted under v1.
  });

  it.skip("re-running rotateAllDeks on already-v2 rows is a no-op (idempotent, kek_version checkpoint) [06-04]", () => {
    // Second rotateAllDeks({to:2}) on rows already at v2 mutates nothing
    // (kek_version checkpoint short-circuits).
  });

  it.skip("after dropping v1 from KEK_VERSIONS, rotated rows still decrypt (v1 retireable) [06-04]", () => {
    // Remove v1 from the KEK_VERSIONS map; rotated rows still decrypt under v2
    // — v1 is retireable once rotation completes.
  });

  it.skip("a corrupted wrapped_dek surfaces the failing row id rather than silently skipping [06-04]", () => {
    // A row with a tampered wrapped_dek raises an error naming the failing row
    // id; rotation must not silently skip undecryptable rows.
  });
});
