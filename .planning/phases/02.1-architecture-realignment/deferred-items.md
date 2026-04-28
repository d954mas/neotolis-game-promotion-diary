# Phase 2.1 Deferred Items

Out-of-scope discoveries logged during plan execution. These are not fixed by
the current plan; the listed plan / phase owns the fix.

## From Plan 02.1-01

### `tests/unit/paraglide.test.ts` keyset snapshot drift

- **Discovered during:** Plan 02.1-01 verification (`pnpm test:unit`).
- **Symptom:** The hard-coded alphabetical key list in `paraglide.test.ts`
  (last refreshed at the end of Phase 2 when 80 keys were live) does not match
  the live `messages/en.json` snapshot anymore — Phase 2.1 is mid-flight and
  the messages file has accreted ~50 new keys for `/feed`, `/sources`,
  `/sources/new`, `polling_badge_*`, `settings_sessions_*`,
  `source_kind_*`, etc.
- **Why deferred:** Plan 02.1-01 is the migration / schema / ESLint plan.
  Touching the keyset snapshot here couples a structural plan to copy work
  that belongs to the wave-3 / wave-4 UI plans, which add the keys with the
  components that consume them. Fixing it now would either require dropping
  the keys (regression for downstream waves) or hard-coding tomorrow's
  expected list (trip-wire defeated until then).
- **Owner:** the Phase 2.1 wave-3 / wave-4 plans that ship `/feed`, `/sources`,
  `/sources/new`, `<UserChip>`, `<SessionsList>`, etc. land their keys; the
  wave that finishes the copy contract refreshes `paraglide.test.ts`
  alphabetical snapshot. (Phase 2 precedent: Plan 02-09 was the snapshot
  refresh point.)
- **Out of scope for Plan 02.1-01:** confirmed.
