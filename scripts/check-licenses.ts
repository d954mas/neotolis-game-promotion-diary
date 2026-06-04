// D-19b AGPL/GPL-family deny-gate on PRODUCTION deps. Filled in by plan 06-06.
// Will shell `pnpm licenses list --prod --json`, tokenize compound SPDX
// expressions (an `OR` with any permissive arm PASSES), and exit 1 on a pure
// copyleft id in prod deps. STUB: exits 0 so CI is not blocked pre-implementation.
process.exit(0);
