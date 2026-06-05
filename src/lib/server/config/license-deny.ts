// D-19b — the single source of truth for the AGPL/GPL-family deny-gate.
// Both the CI gate (scripts/check-licenses.ts) and its hermetic unit test
// (tests/unit/check-licenses.test.ts) import the classifier + lists from HERE,
// never a copy (AGENTS.md "one source of truth").
//
// The gate's job is to keep copyleft (AGPL/GPL-family) out of PRODUCTION
// dependencies. pnpm emits compound SPDX expressions: an `OR` is a choice
// (a dual-licensed dep PASSES when ANY arm is permissive — you pick it),
// while an `AND` is cumulative (every conjunct's obligation applies, so a
// copyleft `AND` conjunct FAILs no matter what the other arm is).
// classifyLicense evaluates that operator structure, not a flat token bag —
// a flat scan mis-passes "(MIT OR Apache-2.0) AND GPL-3.0".

export type LicenseVerdict = "PASS" | "WARN" | "FAIL";

// Hard copyleft / network-copyleft / strong-reciprocal — never allowed in
// PRODUCTION deps. Matched as whole tokens (case-insensitive) so "LGPL-3.0"
// does NOT trip the "GPL" rule. Bare family prefixes (AGPL, GPL, SSPL, EUPL,
// OSL, EPL) catch EVERY versioned variant via the `${id}-` boundary in
// tokenMatchesId — GPL-1.0 / GPL-2.0-only / AGPL-3.0-or-later / GPL-2.0+ all
// classify FAIL. (Listing a specific version like "GPL-3.0" would silently
// miss GPL-1.0 and the bare "GPL" form.)
export const FAIL_LICENSES: readonly string[] = ["AGPL", "GPL", "SSPL", "EUPL", "OSL", "EPL"];

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

// A token matches a list id if it equals the id or starts with `${id}-` /
// `${id}.` (the SPDX version-suffix convention: "GPL-3.0", "AGPL-3.0-or-later").
// Whole-token matching is why "LGPL-3.0" does not match the "GPL" FAIL id —
// "LGPL-3.0" neither equals "GPL-..." nor starts with "GPL-". A trailing SPDX
// `+` ("or-later", e.g. "GPL-2.0+") is stripped first so it matches the base id.
function tokenMatchesId(token: string, id: string): boolean {
  const t = token.toLowerCase().replace(/\+$/, "");
  const i = id.toLowerCase();
  return t === i || t.startsWith(`${i}-`) || t.startsWith(`${i}.`);
}

// Verdict for a single bare license id. WARN before FAIL so weak/file-level
// copyleft ("LGPL-3.0", "MPL-2.0") classifies WARN — tokenMatchesId already
// keeps "LGPL" off the "GPL" FAIL id, but the ordering is the explicit guard.
// Unknown ids PASS: the gate blocks copyleft, it does not allowlist every id.
function classifyToken(token: string): LicenseVerdict {
  if (WARN_LICENSES.some((id) => tokenMatchesId(token, id))) return "WARN";
  if (FAIL_LICENSES.some((id) => tokenMatchesId(token, id))) return "FAIL";
  return "PASS";
}

// OR — satisfy ANY disjunct → best obtainable verdict (PASS > WARN > FAIL).
function orVerdict(a: LicenseVerdict, b: LicenseVerdict): LicenseVerdict {
  if (a === "PASS" || b === "PASS") return "PASS";
  if (a === "WARN" || b === "WARN") return "WARN";
  return "FAIL";
}

// AND — satisfy EVERY conjunct → worst verdict (FAIL > WARN > PASS).
function andVerdict(a: LicenseVerdict, b: LicenseVerdict): LicenseVerdict {
  if (a === "FAIL" || b === "FAIL") return "FAIL";
  if (a === "WARN" || b === "WARN") return "WARN";
  return "PASS";
}

// Lex an SPDX expression into parens + words (operators and license ids).
function lex(spdx: string): string[] {
  return spdx
    .replace(/([()])/g, " $1 ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Classify an SPDX license expression for the prod-dep copyleft gate.
 *
 * A real SPDX evaluator, not a token bag: `OR` binds loosest (you pick an arm
 * → best-of), `AND` binds tighter (you must comply with all → worst-of),
 * parens override. So `(MIT OR Apache-2.0) AND GPL-3.0` FAILs — the GPL
 * conjunct is mandatory whichever OR-arm you pick — while `MIT OR GPL-3.0`
 * PASSes (pick MIT). A `WITH` exception does not change copyleft status, so
 * its operand is dropped. A bare/unknown id is PASS.
 */
export function classifyLicense(spdx: string): LicenseVerdict {
  const tokens = lex(spdx);
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const isOp = (op: string): boolean => (peek() ?? "").toUpperCase() === op;

  // expr := and ( "OR" and )*
  function parseExpr(): LicenseVerdict {
    let v = parseAnd();
    while (isOp("OR")) {
      pos++;
      v = orVerdict(v, parseAnd());
    }
    return v;
  }
  // and := term ( "AND" term )*
  function parseAnd(): LicenseVerdict {
    let v = parseTerm();
    while (isOp("AND")) {
      pos++;
      v = andVerdict(v, parseTerm());
    }
    return v;
  }
  // term := "(" expr ")" | LICENSE [ "WITH" EXCEPTION ]
  function parseTerm(): LicenseVerdict {
    const tok = tokens[pos++];
    if (tok === undefined) return "PASS"; // empty / malformed → unknown
    if (tok === "(") {
      const v = parseExpr();
      if (peek() === ")") pos++;
      return v;
    }
    if (isOp("WITH")) pos += 2; // drop "WITH" + the exception id
    return classifyToken(tok);
  }

  return parseExpr();
}
