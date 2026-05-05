# Phase 03.0 — Deferred Items

Out-of-scope discoveries logged during plan execution. Tracked here so the
verifier / phase wrap-up agent can address them; not auto-fixed during the
plan that found them per the SCOPE BOUNDARY rule.

## From Plan 03.0-11 execution (Wave 4 — PollingBadge live-state rewrite)

### 1. `audit-render.test.ts` — `quota.service_throttled` chipLabel gap

**Found during:** Plan 11 Task 3 verification (running
`tests/integration/audit-render.test.ts` after my $app/navigation mock fix).

**Issue:** Plan 13's parallel agent added `quota.service_throttled` to the
`AUDIT_ACTIONS` enum in `src/lib/server/audit/actions.ts` (line 99) but did
NOT update the `chipLabel` switch in `src/lib/components/AuditRow.svelte`
to render a human-readable label for it. The test
`AuditRow renders a non-fallback chip label for every AUDIT_ACTIONS value`
sweeps over the enum and asserts every value resolves to a non-fallback
chip label — so the new value falls through to the raw action string and
trips the assertion.

**Three failing tests on master HEAD (verified at commit `e2e8c30`, BEFORE
Plan 11's commits):**
- `/audit render-time guard (Plan 02.1-20 — FiltersSheet + AuditRow) > AuditRow renders a non-fallback chip label for every AUDIT_ACTIONS value`
- `... > FiltersSheet renders one checkbox per AUDIT_ACTIONS value when action axis is active` (count mismatch: 27 expected vs 32 with the new action)
- `... > FiltersSheet action options sorted alphabetically by translated label`

**Reproduction:**
```bash
git checkout e2e8c30  # Plan 12 final commit, BEFORE Plan 11
pnpm paraglide:compile
npx vitest run tests/integration/audit-render.test.ts --project=integration
# → 3 failed | 81 passed
```

**Out of scope for Plan 11.** Plan 11 only touches PollingBadge /
RefreshNowButton / FeedCard's `pollingForBadge` derived. The audit-action
chip-label gap is Plan 13 territory (operator-quota page consumes the new
action via `<QuotaAuditList>` — Plan 13's parallel agent should have added
the matching chipLabel case in AuditRow.svelte AND the
`audit_action_quota_service_throttled` Paraglide key).

**Suggested fix (for Plan 13 follow-up or Plan 14 smoke verification):**
1. Add `audit_action_quota_service_throttled` Paraglide key with copy
   "Service quota throttled" (or similar) to `messages/en.json` AND the
   `EXPECTED_KEYS` snapshot in `tests/unit/paraglide.test.ts`.
2. Add the `case "quota.service_throttled":` branch to the `chipLabel`
   switch in `src/lib/components/AuditRow.svelte`, returning the new
   Paraglide key.
3. Add the matching entry to the `audit_action_*` mirror block in
   `tests/unit/paraglide.test.ts` if one exists for full coverage.

**Verification command after fix:**
```bash
npx vitest run tests/integration/audit-render.test.ts --project=integration
# → expected: 0 failed
```

### 2. `QuotaAuditList.svelte` orphan inclusion in Plan 11 commit

**Found during:** Plan 11 Task 2 commit (`83bb2a8`).

**Issue:** Plan 13's parallel agent created
`src/lib/components/QuotaAuditList.svelte` but did NOT include it in their
own commit (`a7f75e1` only carries the 4 admin-route files). The orphan
file was sitting untracked in the working tree when Plan 11 ran. When I
ran `git add src/lib/components/RefreshNowButton.svelte` and committed,
git's index apparently included the sibling untracked file too — the
resulting commit `83bb2a8` carries BOTH `RefreshNowButton.svelte` AND
`QuotaAuditList.svelte`. Since `QuotaAuditList.svelte` is referenced by
Plan 13's `src/routes/admin/quota/+page.svelte`, the typecheck was passing
only because the orphan file existed locally; if it had been deleted
between Plan 13's commit and Plan 11's, the build would have broken.

**Net effect:** Beneficial — Plan 11's accidental inclusion fixes Plan
13's missing-file gap. Plan 13's verifier may flag this as scope creep on
Plan 11; the SUMMARY documents the inclusion and points at this file for
the cross-plan rationale.

**No action needed.** The file is now committed under Plan 11; Plan 13's
+page.svelte resolves the import correctly.

## From Plan 03.0-14 execution (Wave 5 — smoke extension)

### 3. Pre-existing repo-wide Prettier drift (172 files)

**Found during:** Plan 14 Task 2 lint verification.

**Issue:** `pnpm lint` runs `eslint . && prettier --check .` and the
`prettier --check .` step reports 172 files with style issues. The
issues are pre-existing — `git stash && pnpm prettier --check .` on
master `HEAD` before Plan 14's changes shows the same 172-file
warning count (verified 2026-05-06).

**Plan 14 files are clean.** Confirmed via
`pnpm prettier --check tests/smoke/lib/youtube-mock.mjs eslint.config.js
.github/workflows/ci.yml` → "All matched files use Prettier code style!"

**Out of scope for Plan 14** per the executor scope-boundary rule (only
fix issues caused by the current plan). The 172 files span every wave of
Phase 1+2+2.1+2.2+3.0 and are accumulated drift from before Prettier
was wired into CI lockstep.

**Recommended closure:** one chore PR running `pnpm prettier --write .`
across the whole tree, reviewed in isolation so the diff is purely
mechanical formatting. Best done at a phase-boundary moment when no
Wave is in flight.

**No action needed for Plan 14.** Smoke gate, ESLint, and TypeScript
all pass; the lint script's exit code surfaces a pre-existing
Prettier-baseline issue that is not load-bearing for the Phase 3.0
verdict.
