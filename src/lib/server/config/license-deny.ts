// D-19b — the single source of truth for the AGPL/GPL-family deny-gate.
// Both the CI gate (scripts/check-licenses.ts) and its hermetic unit test
// (tests/unit/check-licenses.test.ts) import the classifier + lists from HERE,
// never a copy (AGENTS.md "one source of truth").
//
// The gate's job is to keep copyleft (AGPL/GPL-family) out of PRODUCTION
// dependencies. pnpm emits compound SPDX expressions like "(MIT OR CC0-1.0)"
// — a dual-licensed dependency is satisfied when ANY disjunct is permissive
// (you pick the permissive arm), so a compound expression with a permissive
// token PASSES even if another token is copyleft.

export type LicenseVerdict = "PASS" | "WARN" | "FAIL";

// Hard copyleft / network-copyleft / strong-reciprocal — never allowed in
// PRODUCTION deps. Matched as whole tokens (case-insensitive) so "LGPL-3.0"
// does NOT trip the "GPL" rule. Family prefixes (AGPL, GPL, SSPL, EUPL, OSL,
// EPL) catch versioned variants (GPL-2.0-only, AGPL-3.0-or-later, ...).
export const FAIL_LICENSES: readonly string[] = [
  "AGPL-3.0",
  "AGPL-1.0",
  "GPL-2.0",
  "GPL-3.0",
  "SSPL",
  "EUPL",
  "OSL",
  "EPL",
];

// Weak/file-level copyleft — surfaced, not blocked. A self-host operator
// shipping the unmodified image is unaffected; flag for awareness only.
export const WARN_LICENSES: readonly string[] = ["LGPL", "MPL-2.0"];

// Permissive — an `OR` expression with ANY of these PASSES (pick this arm).
export const PERMISSIVE_LICENSES: readonly string[] = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "CC0-1.0",
  "Unlicense",
  "WTFPL",
  "Python-2.0",
  "BlueOak-1.0.0",
];

// Split an SPDX expression into bare license tokens: drop parens and the
// `OR` / `AND` / `WITH` operators, trim, drop empties.
function tokenize(spdx: string): string[] {
  return spdx
    .split(/[()]|\s+(?:OR|AND|WITH)\s+/i)
    .map((t) => t.trim())
    .filter(Boolean);
}

// A token matches a list id if it equals the id or starts with `${id}-`
// (the SPDX version-suffix convention: "GPL-3.0", "AGPL-3.0-or-later").
// Whole-token matching is why "LGPL-3.0" does not match the "GPL" FAIL id —
// "LGPL-3.0" neither equals "GPL-..." nor starts with "GPL-".
function tokenMatchesId(token: string, id: string): boolean {
  const t = token.toLowerCase();
  const i = id.toLowerCase();
  return t === i || t.startsWith(`${i}-`) || t.startsWith(`${i}.`);
}

function anyTokenIn(tokens: string[], ids: readonly string[]): boolean {
  return tokens.some((tok) => ids.some((id) => tokenMatchesId(tok, id)));
}

/**
 * Classify an SPDX license expression for the prod-dep copyleft gate.
 *
 * Compound-OR semantics: if the expression contains `OR` AND any token is
 * permissive → PASS (the permissive arm satisfies the obligation). Otherwise
 * a FAIL token → FAIL; a WARN token → WARN; anything else → PASS (unknown but
 * not denied — the gate blocks copyleft, it does not allowlist every id).
 *
 * WARN is checked BEFORE FAIL so "LGPL-3.0" classifies as WARN, never FAIL —
 * tokenMatchesId already prevents the "GPL" substring from catching "LGPL",
 * but the WARN-first ordering is the explicit guard.
 */
export function classifyLicense(spdx: string): LicenseVerdict {
  const tokens = tokenize(spdx);
  const hasOr = /\bOR\b/i.test(spdx);

  if (hasOr && anyTokenIn(tokens, PERMISSIVE_LICENSES)) return "PASS";
  if (anyTokenIn(tokens, WARN_LICENSES)) return "WARN";
  if (anyTokenIn(tokens, FAIL_LICENSES)) return "FAIL";
  return "PASS";
}
