# Deferred items — Phase 2

Out-of-scope discoveries surfaced while executing Phase 2 plans. Each entry
records which plan saw it, the symptom, and why it was not fixed inline.

## Pre-existing prettier drift in `package.json` (and 51 other repo files)

**Surfaced by:** Plan 02-02 (Wave 0 ESLint tenant-scope rule).
**Symptom:** `pnpm exec prettier --check .` reports 52 files with style issues
on master (including `package.json`, `tsconfig.json`, `vite.config.ts`,
`vitest.config.ts`, etc.). Reproduced on the branch BEFORE plan 02-02 changes
applied (`git stash && prettier --check package.json` → exit 1).
**Why deferred:** Pre-existing drift unrelated to plan 02-02's tenant-scope
rule. Touching 52 unrelated files in the same PR would violate the atomic-PR
rule. Resolution: a follow-up `chore/format` PR runs `prettier --write .` once
across the repo and lands as a no-op formatting sweep.
**Tracked under:** chore/prettier-format-sweep (TODO; not yet a branch).
